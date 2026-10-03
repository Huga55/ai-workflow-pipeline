import { runAiStep } from '@core/ai-step'
import { extractJson } from '@core/json'
import { waitingOutcome } from '@core/manual'
import { branchLabel } from '@core/labels'
import { interpolate, resolveReference } from '@core/variables'
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  ManualOption,
  StepDefinition,
  StepOutcome,
  VariableContext,
  WorkflowGraph
} from '@core/types'
import vm from 'node:vm'

export type StepRunContext = {
  step: StepDefinition
  ctx: VariableContext
  graph: WorkflowGraph
  signal?: AbortSignal
  collectOutputs?: (fanoutStepId: string, fromStepId: string) => unknown[]
}

export type StepRunner = (ctx: StepRunContext) => Promise<StepOutcome>

export type RunnerDeps = {
  generate?: (request: AIRequest, signal?: AbortSignal) => Promise<AIResponse>
  providerFor?: (providerId: string) => AIProvider
}

export function createRunners(deps: RunnerDeps = {}): Record<StepDefinition['type'], StepRunner> {
  return {
    input: runInput,
    transform: runTransform,
    parse: runParse,
    manual: runManual,
    merge: runMerge,
    ai: async (ctx) => {
      if (ctx.step.type !== 'ai') return { status: 'failed', error: 'Неверный тип шага' }
      const generate =
        deps.generate ??
        (async (request, signal) => {
          if (!deps.providerFor) throw new Error('AI-провайдер не настроен')
          return deps.providerFor(request.provider).generate(request, signal)
        })
      return runAiStep(ctx.step.config, ctx.ctx, generate, ctx.signal)
    }
  }
}

async function runInput({ step, ctx, graph }: StepRunContext): Promise<StepOutcome> {
  if (step.type !== 'input') return { status: 'failed', error: 'Неверный тип шага' }
  const output: Record<string, unknown> = {}
  for (const key of step.config.keys) {
    const definition = graph.inputs.find((input) => input.name === key)
    const value = ctx.inputs[key]
    if ((value === undefined || value === null || value === '') && definition?.required) {
      return { status: 'failed', error: `Не заполнен вход «${definition.label}»` }
    }
    output[key] = value ?? null
  }
  return { status: 'completed', output, rawResponse: null }
}

async function runTransform({ step, ctx }: StepRunContext): Promise<StepOutcome> {
  if (step.type !== 'transform') return { status: 'failed', error: 'Неверный тип шага' }
  const config = step.config
  try {
    if (config.mode === 'template') {
      return { status: 'completed', output: interpolate(config.template ?? '', ctx), rawResponse: null }
    }
    if (config.mode === 'extract') {
      const resolved = resolveReference(config.source ?? '', ctx)
      if (!resolved.ok) return { status: 'failed', error: resolved.error, rawResponse: null }
      return { status: 'completed', output: resolved.value, rawResponse: null }
    }
    if (config.mode === 'filter') {
      const resolved = resolveReference(config.source ?? '', ctx)
      if (!resolved.ok) return { status: 'failed', error: resolved.error, rawResponse: null }
      if (!Array.isArray(resolved.value)) return { status: 'failed', error: 'Источник фильтра должен быть массивом', rawResponse: null }
      const output = resolved.value.filter((item) => matchFilter(item, config.field ?? '', config.op ?? 'truthy', config.value ?? ''))
      return { status: 'completed', output, rawResponse: null }
    }
    const output = runScript(config.script ?? 'return null;', ctx)
    return { status: 'completed', output, rawResponse: null }
  } catch (error) {
    return { status: 'failed', error: errorMessage(error, 'Ошибка преобразования'), rawResponse: null }
  }
}

function matchFilter(item: unknown, field: string, op: 'eq' | 'neq' | 'contains' | 'truthy', expected: string): boolean {
  const value = field ? readField(item, field) : item
  if (op === 'truthy') return Boolean(value)
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  if (op === 'eq') return text === expected
  if (op === 'neq') return text !== expected
  return text.includes(expected)
}

function readField(item: unknown, field: string): unknown {
  let current = item
  for (const part of field.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function runScript(body: string, ctx: VariableContext): unknown {
  const sandbox = {
    ctx: JSON.parse(JSON.stringify(ctx)) as unknown,
    result: undefined as unknown
  }
  const code = `"use strict";\nresult = (function(ctx){\n${body}\n})(ctx);`
  vm.runInNewContext(code, sandbox, { timeout: 1000 })
  return sandbox.result
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return fallback
}

async function runParse({ step, ctx }: StepRunContext): Promise<StepOutcome> {
  if (step.type !== 'parse') return { status: 'failed', error: 'Неверный тип шага' }
  const resolved = resolveReference(step.config.source, ctx)
  if (!resolved.ok) return { status: 'failed', error: resolved.error, rawResponse: null }
  const raw = typeof resolved.value === 'string' ? resolved.value : JSON.stringify(resolved.value)
  try {
    if (step.config.mode === 'json') {
      const output = typeof resolved.value === 'string' ? extractJson(resolved.value) : resolved.value
      return { status: 'completed', output, rawResponse: raw }
    }
    if (step.config.mode === 'regex') {
      const pattern = step.config.pattern?.trim()
      if (!pattern) return { status: 'failed', error: 'Не задан шаблон regex', rawResponse: raw }
      const expression = new RegExp(pattern, 'g')
      const matches: unknown[] = []
      for (const match of raw.matchAll(expression)) {
        if (match.groups && Object.keys(match.groups).length) matches.push(match.groups)
        else matches.push(match[0])
      }
      return { status: 'completed', output: matches, rawResponse: raw }
    }
    const delimiter = step.config.delimiter?.replace(/\\n/g, '\n') || '\n\n'
    const output = raw
      .split(delimiter)
      .map((part) => part.trim())
      .filter(Boolean)
    return { status: 'completed', output, rawResponse: raw }
  } catch (error) {
    return { status: 'failed', error: errorMessage(error, 'Ошибка разбора'), rawResponse: raw }
  }
}

async function runManual({ step, ctx }: StepRunContext): Promise<StepOutcome> {
  if (step.type !== 'manual') return { status: 'failed', error: 'Неверный тип шага' }
  const config = step.config
  let source: unknown
  if (config.source?.trim()) {
    const resolved = resolveReference(config.source, ctx)
    if (!resolved.ok) return { status: 'failed', error: resolved.error, rawResponse: null }
    source = resolved.value
  }
  if (config.mode === 'select_one' || config.mode === 'select_many') {
    const list = Array.isArray(source) ? source : source == null ? [] : [source]
    const options: ManualOption[] = list.map((value, index) => ({
      id: String(index),
      label: optionLabel(value, config.labelField) || branchLabel(value, index),
      description: config.descriptionField ? stringField(value, config.descriptionField) : undefined,
      value
    }))
    return waitingOutcome(
      { mode: config.mode, prompt: config.prompt, options, allowEmpty: config.allowEmpty, skipStepIds: config.skipStepIds },
      { source }
    )
  }
  if (config.mode === 'text') {
    return waitingOutcome({ mode: 'text', prompt: config.prompt, value: source, skipStepIds: config.skipStepIds }, { source })
  }
  if (config.mode === 'confirm' || config.mode === 'edit_json') {
    return waitingOutcome({ mode: config.mode, prompt: config.prompt, value: source, skipStepIds: config.skipStepIds }, { source })
  }
  return waitingOutcome({ mode: config.mode, prompt: config.prompt, value: source, skipStepIds: config.skipStepIds }, { source })
}

function optionLabel(value: unknown, field?: string): string {
  if (!field) return ''
  const found = stringField(value, field)
  return found ?? ''
}

function stringField(value: unknown, field: string): string | undefined {
  const current = readField(value, field)
  return typeof current === 'string' ? current : undefined
}

async function runMerge({ step, ctx, collectOutputs }: StepRunContext): Promise<StepOutcome> {
  if (step.type !== 'merge') return { status: 'failed', error: 'Неверный тип шага' }
  if (step.config.mode === 'collect') {
    if (!collectOutputs) return { status: 'failed', error: 'Сборка веток недоступна', rawResponse: null }
    const output = collectOutputs(step.config.fromFanoutStepId, step.config.fromStepId)
    return { status: 'completed', output, rawResponse: null }
  }
  const output: Record<string, unknown> = {}
  for (const source of step.config.sources) {
    const resolved = resolveReference(source.ref, ctx)
    if (!resolved.ok) return { status: 'failed', error: resolved.error, rawResponse: null }
    output[source.key] = resolved.value
  }
  return { status: 'completed', output, rawResponse: null }
}
