import { validateGraph } from '@core/graph'
import { createId as newId } from '@core/ids'
import { slugify, uniqueKey } from '@core/labels'
import type {
  AIMessageDraft,
  AIStepConfig,
  InputDefinition,
  InputType,
  IterateConfig,
  ManualMode,
  ManualStepConfig,
  MergeStepConfig,
  ParseStepConfig,
  StepDefinition,
  StepType,
  TransformStepConfig,
  WorkflowGraph
} from '@core/types'

const INPUT_TYPES = new Set<InputType>([
  'string',
  'text',
  'number',
  'boolean',
  'image',
  'image[]',
  'file',
  'file[]',
  'json',
  'json[]',
  'select',
  'multi-select'
])

const STEP_TYPES = new Set<StepType>(['input', 'ai', 'transform', 'parse', 'fanout', 'manual', 'merge'])
const MANUAL_MODES = new Set<ManualMode>([
  'select_one',
  'select_many',
  'text',
  'confirm',
  'edit_json',
  'upload_file',
  'upload_image'
])
const TRANSFORM_MODES = new Set<TransformStepConfig['mode']>(['template', 'extract', 'filter', 'script'])
const FILTER_OPS = new Set<NonNullable<TransformStepConfig['op']>>(['eq', 'neq', 'contains', 'truthy'])
const PARSE_MODES = new Set<ParseStepConfig['mode']>(['json', 'regex', 'delimiter'])
const ROLES = new Set<AIMessageDraft['role']>(['system', 'user', 'assistant'])

export type WorkflowJsonDocument = {
  name: string
  description: string
  graph: WorkflowGraph
}

export type WorkflowJsonResult = { ok: true; document: WorkflowJsonDocument } | { ok: false; errors: string[] }

export function formatWorkflowJson(document: WorkflowJsonDocument): string {
  return JSON.stringify(
    {
      name: document.name,
      description: document.description,
      inputs: document.graph.inputs,
      steps: document.graph.steps
    },
    null,
    2
  )
}

export type WorkflowJsonParseOptions = {
  createId?: () => string
  previous?: WorkflowGraph
}

export function parseWorkflowJson(text: string, options: WorkflowJsonParseOptions = {}): WorkflowJsonResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'синтаксическая ошибка'
    return { ok: false, errors: [`Некорректный JSON: ${message}`] }
  }
  if (!isRecord(raw)) return { ok: false, errors: ['Корень JSON должен быть объектом с полями name, description, inputs и steps'] }

  const errors: string[] = []
  onlyKeys(raw, ['name', 'description', 'inputs', 'steps'], 'корень', errors)
  const name = readString(raw, 'name', 'name', errors, '') ?? ''
  const description = readString(raw, 'description', 'description', errors, '') ?? ''
  if (!Array.isArray(raw.inputs)) errors.push('inputs должен быть массивом')
  if (!Array.isArray(raw.steps)) errors.push('steps должен быть массивом')
  if (!Array.isArray(raw.inputs) || !Array.isArray(raw.steps)) return { ok: false, errors }

  const session: ParseSession = {
    createId: options.createId ?? newId,
    previous: options.previous,
    takenIds: new Set<string>(),
    aliases: new Map<string, string>(),
    errors
  }
  const takenNames = new Set<string>()
  const inputs: InputDefinition[] = []
  raw.inputs.forEach((item, index) => {
    const input = parseInput(item, index, takenNames, session)
    if (input) inputs.push(input)
  })

  const takenKeys = new Set<string>()
  const pending: PendingStep[] = []
  raw.steps.forEach((item, index) => {
    const step = parseStep(item, index, takenKeys, session)
    if (step) pending.push(step)
  })
  if (errors.length) return { ok: false, errors }

  const byId = new Map(pending.map((item) => [item.step.id, item.step]))
  const byKey = new Map(pending.map((item) => [item.step.key, item.step.id]))
  const steps = pending.map((item) => resolveStep(item, byId, byKey, session.aliases, errors))
  if (errors.length) return { ok: false, errors }

  const graph = { inputs, steps }
  const issues = validateGraph(graph)
  if (issues.length) return { ok: false, errors: issues }
  return { ok: true, document: { name, description, graph } }
}

type PendingStep = {
  step: StepDefinition
  dependsOn: string[]
  skipStepIds?: string[]
  fromFanoutStepId?: string
  fromStepId?: string
}

type ParseSession = {
  createId: () => string
  previous?: WorkflowGraph
  takenIds: Set<string>
  aliases: Map<string, string>
  errors: string[]
}

function parseInput(raw: unknown, index: number, takenNames: Set<string>, session: ParseSession): InputDefinition | null {
  const errors = session.errors
  const path = `inputs[${index}]`
  if (!isRecord(raw)) {
    errors.push(`${path} должен быть объектом`)
    return null
  }
  onlyKeys(raw, ['id', 'name', 'label', 'type', 'required', 'description', 'defaultValue', 'options'], path, errors)
  const label = readString(raw, 'label', `${path}.label`, errors)
  const explicitName = readString(raw, 'name', `${path}.name`, errors)
  const name = explicitName?.trim() || (label ? slugify(label) : '')
  if (!name) errors.push(`${path}: укажите name или label`)
  else if (takenNames.has(name)) errors.push(`${path}: повторяется имя «${name}»`)
  if (name) takenNames.add(name)

  const type = readEnum(raw, 'type', `${path}.type`, INPUT_TYPES, errors, 'string')
  const required = readBoolean(raw, 'required', `${path}.required`, errors, false)
  const description = readString(raw, 'description', `${path}.description`, errors, '')
  if (!type || required === undefined || description === undefined || !name) return null

  const input: InputDefinition = {
    id: assignId(readString(raw, 'id', `${path}.id`, errors), session.previous?.inputs.find((item) => item.name === name)?.id, path, session),
    name,
    label: label?.trim() || name,
    type,
    required,
    description
  }
  if ('defaultValue' in raw) input.defaultValue = raw.defaultValue
  if ('options' in raw) {
    const options = readStringArray(raw.options, `${path}.options`, errors)
    if (options) input.options = options
  }
  return input
}

function parseStep(raw: unknown, index: number, takenKeys: Set<string>, session: ParseSession): PendingStep | null {
  const errors = session.errors
  const path = `steps[${index}]`
  if (!isRecord(raw)) {
    errors.push(`${path} должен быть объектом`)
    return null
  }
  onlyKeys(raw, ['id', 'key', 'name', 'description', 'type', 'order', 'dependsOn', 'stopAfter', 'iterate', 'config'], path, errors)
  const type = readEnum(raw, 'type', `${path}.type`, STEP_TYPES, errors)
  const explicitName = readString(raw, 'name', `${path}.name`, errors)
  const explicitKey = readString(raw, 'key', `${path}.key`, errors)
  const label = explicitName?.trim() || explicitKey?.trim() || ''
  if (!label) errors.push(`${path}: укажите key или name`)
  const key = explicitKey?.trim() ? explicitKey.trim() : uniqueKey(slugify(label || 'step'), takenKeys)
  if (explicitKey?.trim()) {
    if (takenKeys.has(key)) errors.push(`${path}: повторяется ключ «${key}»`)
    takenKeys.add(key)
  } else if (label) takenKeys.add(key)

  const description = readString(raw, 'description', `${path}.description`, errors, '')
  const order = readNumber(raw, 'order', `${path}.order`, errors, index + 1)
  const stopAfter = readBoolean(raw, 'stopAfter', `${path}.stopAfter`, errors, false)
  const dependsOn = readDepends(raw.dependsOn, `${path}.dependsOn`, errors)
  const iterate = readIterate(raw, path, type, errors)
  if (!type || !label || description === undefined || order === undefined || stopAfter === undefined || !dependsOn || iterate === undefined) {
    return null
  }

  const previousStep = session.previous?.steps.find((item) => item.key === key)
  const config = parseConfig(type, raw.config, `${path}.config`, previousStep, session)
  if (!config) return null
  const id = assignId(readString(raw, 'id', `${path}.id`, errors), previousStep?.id, path, session)
  const step = {
    id,
    key,
    name: explicitName?.trim() || key,
    description,
    order,
    dependsOn: [],
    stopAfter,
    iterate: iterate,
    type,
    config: config.config
  } as StepDefinition
  return { step, dependsOn, skipStepIds: config.skipStepIds, fromFanoutStepId: config.fromFanoutStepId, fromStepId: config.fromStepId }
}

function parseConfig(
  type: StepType,
  raw: unknown,
  path: string,
  previousStep: StepDefinition | undefined,
  session: ParseSession
): { config: StepDefinition['config']; skipStepIds?: string[]; fromFanoutStepId?: string; fromStepId?: string } | null {
  const errors = session.errors
  if (type === 'fanout') {
    if (raw === undefined) return { config: {} }
    if (!isRecord(raw)) {
      errors.push(`${path} должен быть объектом`)
      return null
    }
    onlyKeys(raw, [], path, errors)
    return { config: {} }
  }
  if (!isRecord(raw)) {
    errors.push(`${path} должен быть объектом`)
    return null
  }
  if (type === 'ai') {
    const config = parseAiConfig(raw, path, previousStep, session)
    return config ? { config } : null
  }
  if (type === 'transform') {
    const config = parseTransformConfig(raw, path, errors)
    return config ? { config } : null
  }
  if (type === 'parse') {
    const config = parseParseConfig(raw, path, errors)
    return config ? { config } : null
  }
  if (type === 'manual') {
    const parsed = parseManualConfig(raw, path, errors)
    if (!parsed) return null
    return { config: parsed.config, skipStepIds: parsed.skipStepIds }
  }
  if (type === 'merge') {
    const parsed = parseMergeConfig(raw, path, errors)
    if (!parsed) return null
    return parsed
  }
  const config = parseInputConfig(raw, path, errors)
  return config ? { config } : null
}

function parseAiConfig(
  raw: Record<string, unknown>,
  path: string,
  previousStep: StepDefinition | undefined,
  session: ParseSession
): AIStepConfig | null {
  const errors = session.errors
  const previousMessages = previousStep?.type === 'ai' ? previousStep.config.messages : []
  onlyKeys(raw, ['provider', 'model', 'temperature', 'maxTokens', 'messages', 'outputFormat', 'jsonSchema'], path, errors)
  const provider = readString(raw, 'provider', `${path}.provider`, errors, 'openai')
  const model = readString(raw, 'model', `${path}.model`, errors)
  const outputFormat = readEnum(raw, 'outputFormat', `${path}.outputFormat`, new Set(['text', 'json'] as const), errors, 'json')
  if (!provider?.trim()) errors.push(`${path}.provider: укажите провайдера`)
  if (!model?.trim()) errors.push(`${path}.model: укажите модель`)
  if (!Array.isArray(raw.messages)) {
    errors.push(`${path}.messages должен быть массивом`)
    return null
  }
  const messages: AIMessageDraft[] = []
  const seen = new Set<string>()
  raw.messages.forEach((item, index) => {
    const messagePath = `${path}.messages[${index}]`
    if (!isRecord(item)) {
      errors.push(`${messagePath} должен быть объектом`)
      return
    }
    onlyKeys(item, ['id', 'role', 'content'], messagePath, errors)
    const role = readEnum(item, 'role', `${messagePath}.role`, ROLES, errors)
    const content = readString(item, 'content', `${messagePath}.content`, errors, '')
    if (!role || content === undefined) return
    const id = assignId(readString(item, 'id', `${messagePath}.id`, errors), previousMessages[index]?.id, messagePath, session)
    if (seen.has(id)) errors.push(`${messagePath}: повторяется id «${id}»`)
    seen.add(id)
    messages.push({ id, role, content })
  })
  if (!provider || !model || !outputFormat) return null
  const config: AIStepConfig = { provider, model, messages, outputFormat }
  const temperature = readOptionalNumber(raw, 'temperature', `${path}.temperature`, errors)
  const maxTokens = readOptionalNumber(raw, 'maxTokens', `${path}.maxTokens`, errors)
  if ('temperature' in raw) config.temperature = temperature
  if ('maxTokens' in raw) config.maxTokens = maxTokens
  if ('jsonSchema' in raw) config.jsonSchema = raw.jsonSchema
  return config
}

function parseTransformConfig(raw: Record<string, unknown>, path: string, errors: string[]): TransformStepConfig | null {
  onlyKeys(raw, ['mode', 'source', 'template', 'field', 'op', 'value', 'script'], path, errors)
  const mode = readEnum(raw, 'mode', `${path}.mode`, TRANSFORM_MODES, errors)
  if (!mode) return null
  const config: TransformStepConfig = { mode }
  const source = readString(raw, 'source', `${path}.source`, errors)
  const template = readString(raw, 'template', `${path}.template`, errors)
  const field = readString(raw, 'field', `${path}.field`, errors)
  const value = readString(raw, 'value', `${path}.value`, errors)
  const script = readString(raw, 'script', `${path}.script`, errors)
  if ('source' in raw && source !== undefined) config.source = source
  if ('template' in raw && template !== undefined) config.template = template
  if ('field' in raw && field !== undefined) config.field = field
  if ('value' in raw && value !== undefined) config.value = value
  if ('script' in raw && script !== undefined) config.script = script
  if ('op' in raw) {
    const op = readEnum(raw, 'op', `${path}.op`, FILTER_OPS, errors)
    if (op) config.op = op
  }
  return config
}

function parseParseConfig(raw: Record<string, unknown>, path: string, errors: string[]): ParseStepConfig | null {
  onlyKeys(raw, ['source', 'mode', 'pattern', 'delimiter'], path, errors)
  const source = readString(raw, 'source', `${path}.source`, errors, '')
  const mode = readEnum(raw, 'mode', `${path}.mode`, PARSE_MODES, errors, 'json')
  if (source === undefined || !mode) return null
  const config: ParseStepConfig = { source, mode }
  const pattern = readString(raw, 'pattern', `${path}.pattern`, errors)
  const delimiter = readString(raw, 'delimiter', `${path}.delimiter`, errors)
  if ('pattern' in raw && pattern !== undefined) config.pattern = pattern
  if ('delimiter' in raw && delimiter !== undefined) config.delimiter = delimiter
  return config
}

function parseManualConfig(
  raw: Record<string, unknown>,
  path: string,
  errors: string[]
): { config: ManualStepConfig; skipStepIds?: string[] } | null {
  onlyKeys(raw, ['mode', 'source', 'labelField', 'descriptionField', 'prompt', 'allowEmpty', 'skipStepIds'], path, errors)
  const mode = readEnum(raw, 'mode', `${path}.mode`, MANUAL_MODES, errors)
  const prompt = readString(raw, 'prompt', `${path}.prompt`, errors, '')
  if (!mode || prompt === undefined) return null
  const config: ManualStepConfig = { mode, prompt }
  const source = readString(raw, 'source', `${path}.source`, errors)
  const labelField = readString(raw, 'labelField', `${path}.labelField`, errors)
  const descriptionField = readString(raw, 'descriptionField', `${path}.descriptionField`, errors)
  const allowEmpty = readBoolean(raw, 'allowEmpty', `${path}.allowEmpty`, errors)
  if ('source' in raw && source !== undefined) config.source = source
  if ('labelField' in raw && labelField !== undefined) config.labelField = labelField
  if ('descriptionField' in raw && descriptionField !== undefined) config.descriptionField = descriptionField
  if ('allowEmpty' in raw && allowEmpty !== undefined) config.allowEmpty = allowEmpty
  let skipStepIds: string[] | undefined
  if ('skipStepIds' in raw) {
    const list = readStringArray(raw.skipStepIds, `${path}.skipStepIds`, errors)
    if (!list) return null
    skipStepIds = list
    config.skipStepIds = list
  }
  return { config, skipStepIds }
}

function parseMergeConfig(
  raw: Record<string, unknown>,
  path: string,
  errors: string[]
): { config: MergeStepConfig; fromFanoutStepId?: string; fromStepId?: string } | null {
  const mode = readEnum(raw, 'mode', `${path}.mode`, new Set(['object', 'collect'] as const), errors)
  if (!mode) return null
  if (mode === 'object') {
    onlyKeys(raw, ['mode', 'sources'], path, errors)
    if (!Array.isArray(raw.sources)) {
      errors.push(`${path}.sources должен быть массивом`)
      return null
    }
    const sources: { key: string; ref: string }[] = []
    raw.sources.forEach((item, index) => {
      const sourcePath = `${path}.sources[${index}]`
      if (!isRecord(item)) {
        errors.push(`${sourcePath} должен быть объектом`)
        return
      }
      onlyKeys(item, ['key', 'ref'], sourcePath, errors)
      const key = readString(item, 'key', `${sourcePath}.key`, errors, '')
      const ref = readString(item, 'ref', `${sourcePath}.ref`, errors, '')
      if (key === undefined || ref === undefined) return
      sources.push({ key, ref })
    })
    return { config: { mode: 'object', sources } }
  }
  onlyKeys(raw, ['mode', 'fromFanoutStepId', 'fromStepId'], path, errors)
  const fromFanoutStepId = readString(raw, 'fromFanoutStepId', `${path}.fromFanoutStepId`, errors)
  const fromStepId = readString(raw, 'fromStepId', `${path}.fromStepId`, errors)
  if (!fromFanoutStepId?.trim() || !fromStepId?.trim()) {
    errors.push(`${path}: для mode "collect" нужны fromFanoutStepId и fromStepId`)
    return null
  }
  return { config: { mode: 'collect', fromFanoutStepId, fromStepId }, fromFanoutStepId, fromStepId }
}

function parseInputConfig(raw: Record<string, unknown>, path: string, errors: string[]): { keys: string[] } | null {
  onlyKeys(raw, ['keys'], path, errors)
  if (!('keys' in raw)) return { keys: [] }
  const keys = readStringArray(raw.keys, `${path}.keys`, errors)
  if (!keys) return null
  return { keys }
}

function readIterate(raw: Record<string, unknown>, path: string, type: StepType | undefined, errors: string[]): IterateConfig | null | undefined {
  if (!('iterate' in raw) || raw.iterate === null) {
    if (type === 'fanout') {
      errors.push(`${path}.iterate: у шага «Элементы» нужно указать массив`)
      return undefined
    }
    return null
  }
  const iteratePath = `${path}.iterate`
  if (!isRecord(raw.iterate)) {
    errors.push(`${iteratePath} должен быть объектом или null`)
    return undefined
  }
  onlyKeys(raw.iterate, ['over', 'alias', 'launch', 'noteAlias'], iteratePath, errors)
  const over = readString(raw.iterate, 'over', `${iteratePath}.over`, errors, '')
  const alias = readString(raw.iterate, 'alias', `${iteratePath}.alias`, errors, 'item')
  const launch = readEnum(raw.iterate, 'launch', `${iteratePath}.launch`, new Set(['all', 'manual'] as const), errors, 'all')
  if (over === undefined || alias === undefined || !launch) return undefined
  const iterate: IterateConfig = { over, alias, launch }
  if ('noteAlias' in raw.iterate) {
    const noteAlias = readString(raw.iterate, 'noteAlias', `${iteratePath}.noteAlias`, errors)
    if (noteAlias === undefined) return undefined
    if (noteAlias) iterate.noteAlias = noteAlias
  }
  return iterate
}

function resolveStep(
  pending: PendingStep,
  byId: Map<string, StepDefinition>,
  byKey: Map<string, string>,
  aliases: Map<string, string>,
  errors: string[]
): StepDefinition {
  const dependsOn = pending.dependsOn.map((ref) => resolveRef(ref, pending.step.name, 'dependsOn', byId, byKey, aliases, errors))
  let step = { ...pending.step, dependsOn }
  if (pending.skipStepIds && step.type === 'manual') {
    step = {
      ...step,
      config: {
        ...step.config,
        skipStepIds: pending.skipStepIds.map((ref) => resolveRef(ref, step.name, 'skipStepIds', byId, byKey, aliases, errors))
      }
    }
  }
  if (pending.fromFanoutStepId && pending.fromStepId && step.type === 'merge' && step.config.mode === 'collect') {
    step = {
      ...step,
      config: {
        mode: 'collect',
        fromFanoutStepId: resolveRef(pending.fromFanoutStepId, step.name, 'fromFanoutStepId', byId, byKey, aliases, errors),
        fromStepId: resolveRef(pending.fromStepId, step.name, 'fromStepId', byId, byKey, aliases, errors)
      }
    }
  }
  return step
}

function resolveRef(
  ref: string,
  stepName: string,
  field: string,
  byId: Map<string, StepDefinition>,
  byKey: Map<string, string>,
  aliases: Map<string, string>,
  errors: string[]
): string {
  if (byId.has(ref)) return ref
  const id = byKey.get(ref) ?? aliases.get(ref)
  if (id) return id
  errors.push(`Шаг «${stepName}»: ${field} ссылается на неизвестный шаг «${ref}»`)
  return ref
}

function assignId(explicit: string | undefined, matched: string | undefined, path: string, session: ParseSession): string {
  const preferred = explicit?.trim()
  let id = matched && !session.takenIds.has(matched) ? matched : undefined
  if (!id && preferred && knownId(session, preferred) && !session.takenIds.has(preferred)) id = preferred
  if (!id) id = session.createId()
  if (session.takenIds.has(id)) {
    session.errors.push(`${path}: повторяется id «${id}»`)
    id = session.createId()
  }
  session.takenIds.add(id)
  session.aliases.set(id, id)
  if (preferred && preferred !== id) session.aliases.set(preferred, id)
  return id
}

function knownId(session: ParseSession, id: string): boolean {
  if (!session.previous) return true
  if (session.previous.inputs.some((input) => input.id === id)) return true
  return session.previous.steps.some((step) => step.id === id || (step.type === 'ai' && step.config.messages.some((message) => message.id === id)))
}

function readDepends(value: unknown, path: string, errors: string[]): string[] | null {
  if (value === undefined) return []
  return readStringArray(value, path, errors)
}

function readStringArray(value: unknown, path: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${path} должен быть массивом строк`)
    return null
  }
  return value
}

function readString(record: Record<string, unknown>, key: string, path: string, errors: string[], fallback?: string): string | undefined {
  if (!(key in record)) return fallback
  if (typeof record[key] !== 'string') {
    errors.push(`${path} должен быть строкой`)
    return fallback
  }
  return record[key]
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  fallback?: boolean
): boolean | undefined {
  if (!(key in record)) return fallback
  if (typeof record[key] !== 'boolean') {
    errors.push(`${path} должен быть true или false`)
    return fallback
  }
  return record[key]
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  fallback?: number
): number | undefined {
  if (!(key in record)) return fallback
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    errors.push(`${path} должен быть числом`)
    return fallback
  }
  return record[key]
}

function readOptionalNumber(record: Record<string, unknown>, key: string, path: string, errors: string[]): number | undefined {
  if (!(key in record) || record[key] === undefined) return undefined
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    errors.push(`${path} должен быть числом`)
    return undefined
  }
  return record[key]
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: Set<T>,
  errors: string[],
  fallback?: T
): T | undefined {
  if (!(key in record) || record[key] === undefined) {
    if (fallback !== undefined) return fallback
    errors.push(`${path}: укажите значение (${[...allowed].join(', ')})`)
    return undefined
  }
  const value = record[key]
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    errors.push(`${path}: неизвестное значение «${String(value)}»`)
    return fallback
  }
  return value as T
}

function onlyKeys(record: Record<string, unknown>, allowed: string[], path: string, errors: string[]) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) errors.push(`${path}: неизвестное поле «${key}»`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
