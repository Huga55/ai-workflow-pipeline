import { fanoutInnerSteps } from '@core/graph'
import { isSharedRef } from '@core/shared-messages'
import { effectiveStep } from '@core/step-ref'
import type { StepDefinition, WorkflowGraph } from '@core/types'
import { parsePath, previousStep, templatePaths, type VariablePools } from '@core/variables'

export type MissingVariable = {
  fieldId: string
  targetId: string
  place: string
  field: string
  path: string
  hint?: string
}

type NameScope = {
  aliases: Set<string>
  inBranch: boolean
  hasPrev: boolean
  prevFields: Set<string> | null
}

type Bound = {
  fieldId: string
  targetId: string
  place: string
  field: string
  texts: string[]
  barePaths: string[]
  scope: NameScope | { snippet: string } | { shared: string }
}

const NONE: NameScope = { aliases: new Set(), inBranch: false, hasPrev: false, prevFields: null }

export function findMissingVariables(graph: WorkflowGraph, pools?: VariablePools): MissingVariable[] {
  const bounds = collectBounds(graph)
  const issues: MissingVariable[] = []
  for (const bound of bounds) {
    const scope = resolveScope(bound, bounds, graph, new Set())
    const seen = new Set<string>()
    for (const path of [...bound.barePaths, ...bound.texts.flatMap(templatePaths)]) {
      if (seen.has(path)) continue
      seen.add(path)
      const hint = missingHint(path, scope, graph, pools)
      if (hint === null) continue
      issues.push({
        fieldId: bound.fieldId,
        targetId: bound.targetId,
        place: bound.place,
        field: bound.field,
        path,
        ...(hint ? { hint } : {})
      })
    }
  }
  return issues
}

function collectBounds(graph: WorkflowGraph): Bound[] {
  const bounds: Bound[] = []
  const steps = graph.steps
  for (const snippet of graph.snippets ?? []) {
    bounds.push({
      fieldId: `snippet:${snippet.key}:content`,
      targetId: `snippet:${snippet.key}`,
      place: `Фрагмент «${snippet.key}»`,
      field: 'текст',
      texts: [snippet.content],
      barePaths: [],
      scope: { snippet: snippet.key }
    })
  }
  for (const shared of graph.sharedMessages ?? []) {
    const place = `Общее сообщение «${shared.name || shared.key}»`
    bounds.push({
      fieldId: `shared:${shared.key}:content`,
      targetId: `shared:${shared.key}`,
      place,
      field: 'текст',
      texts: [shared.content],
      barePaths: [],
      scope: { shared: shared.key }
    })
    if (shared.when?.paths.length) {
      bounds.push({
        fieldId: `shared:${shared.key}:when`,
        targetId: `shared:${shared.key}`,
        place,
        field: 'условие',
        texts: [],
        barePaths: shared.when.paths.filter((path) => path.trim()),
        scope: { shared: shared.key }
      })
    }
  }
  for (const chat of graph.chats ?? []) {
    bounds.push({
      fieldId: `chat:${chat.key}:instruction`,
      targetId: `chat:${chat.key}`,
      place: `Чат «${chat.key}»`,
      field: 'инструкция',
      texts: [chat.instruction],
      barePaths: [],
      scope: chat.scope === 'branch' ? branchChatScope(graph) : NONE
    })
  }
  for (const step of steps) {
    if (step.iterate?.over) {
      bounds.push(stepBound(step, steps, 'over', 'массив', [step.iterate.over], [], 'over'))
    }
    if (step.use) continue
    const resolved = effectiveStep(step, steps)
    if (resolved.type === 'ai') {
      resolved.config.messages.forEach((message, index) => {
        if (isSharedRef(message)) return
        const label = `сообщение ${index + 1}`
        bounds.push(stepBound(step, steps, `message:${message.id}`, label, [message.content], [], 'body'))
        if (message.when?.paths.length) {
          bounds.push(
            stepBound(
              step,
              steps,
              `message:${message.id}:when`,
              `условие сообщения ${index + 1}`,
              [],
              message.when.paths.filter((path) => path.trim()),
              'body'
            )
          )
        }
      })
    } else if (resolved.type === 'transform') {
      if (resolved.config.mode === 'template' && resolved.config.template) {
        bounds.push(stepBound(step, steps, 'template', 'шаблон', [resolved.config.template], [], 'body'))
      }
      if ((resolved.config.mode === 'extract' || resolved.config.mode === 'filter') && resolved.config.source) {
        bounds.push(stepBound(step, steps, 'source', 'источник', [resolved.config.source], [], 'body'))
      }
      if (resolved.config.mode === 'filter' && resolved.config.value) {
        bounds.push(stepBound(step, steps, 'value', 'значение фильтра', [resolved.config.value], [], 'body'))
      }
    } else if (resolved.type === 'parse') {
      bounds.push(stepBound(step, steps, 'source', 'источник', [resolved.config.source], [], 'body'))
    } else if (resolved.type === 'manual') {
      if (resolved.config.prompt) bounds.push(stepBound(step, steps, 'prompt', 'подсказка', [resolved.config.prompt], [], 'body'))
      if (resolved.config.source) bounds.push(stepBound(step, steps, 'source', 'источник', [resolved.config.source], [], 'body'))
    } else if (resolved.type === 'merge' && resolved.config.mode === 'object') {
      resolved.config.sources.forEach((source, index) => {
        bounds.push(stepBound(step, steps, `merge:${index}`, `значение ${index + 1}`, [source.ref], [], 'body'))
      })
    }
  }
  return bounds
}

function stepBound(
  step: StepDefinition,
  steps: StepDefinition[],
  fieldKey: string,
  field: string,
  texts: string[],
  barePaths: string[],
  where: 'over' | 'body'
): Bound {
  const runners = where === 'over' ? [step] : [step, ...steps.filter((item) => item.use === step.key)]
  const pick = where === 'over' ? overScope : bodyScope
  return {
    fieldId: `step:${step.id}:${fieldKey}`,
    targetId: step.id,
    place: `Шаг «${step.name}»`,
    field,
    texts,
    barePaths,
    scope: intersectScopes(runners.map((item) => pick(item, steps)))
  }
}

function resolveScope(bound: Bound, bounds: Bound[], graph: WorkflowGraph, stack: Set<string>): NameScope {
  if (!('aliases' in bound.scope)) {
    if ('shared' in bound.scope) return sharedScope(bound.scope.shared, graph)
    if (stack.has(bound.scope.snippet)) return NONE
    return snippetScope(bound.scope.snippet, bounds, graph, stack)
  }
  return bound.scope
}

function snippetScope(key: string, bounds: Bound[], graph: WorkflowGraph, stack: Set<string>): NameScope {
  const next = new Set(stack)
  next.add(key)
  const scopes: NameScope[] = []
  for (const bound of bounds) {
    if ('snippet' in bound.scope && bound.scope.snippet === key) continue
    if (!mentionsSnippet(bound, key)) continue
    if ('snippet' in bound.scope && next.has(bound.scope.snippet)) continue
    scopes.push(resolveScope(bound, bounds, graph, next))
  }
  return intersectScopes(scopes)
}

function sharedScope(key: string, graph: WorkflowGraph): NameScope {
  const owners = graph.steps.filter((step) => {
    if (step.use || step.type !== 'ai') return false
    return step.config.messages.some((message) => isSharedRef(message) && message.shared === key)
  })
  const runners = owners.flatMap((owner) => [owner, ...graph.steps.filter((step) => step.use === owner.key)])
  return intersectScopes(runners.map((step) => bodyScope(step, graph.steps)))
}

function mentionsSnippet(bound: Bound, key: string): boolean {
  const paths = [...bound.barePaths, ...bound.texts.flatMap(templatePaths)]
  return paths.some((path) => {
    const segments = parsePath(path)
    return segments?.[0]?.kind === 'prop' && segments[0].name === 'snippets' && segments[1]?.kind === 'prop' && segments[1].name === key
  })
}

function branchChatScope(graph: WorkflowGraph): NameScope {
  const fanouts = graph.steps.filter((step) => step.iterate)
  if (!fanouts.length) return NONE
  return intersectScopes(fanouts.map((step) => bodyScope(step, graph.steps)))
}

function bodyScope(step: StepDefinition, steps: StepDefinition[]): NameScope {
  const aliases = new Set<string>()
  let inBranch = false
  for (const fanout of fanoutsContaining(step.id, steps)) {
    inBranch = true
    addAliases(aliases, fanout)
  }
  if (step.iterate) {
    inBranch = true
    addAliases(aliases, step)
  }
  return withPrev(step, steps, aliases, inBranch)
}

function overScope(step: StepDefinition, steps: StepDefinition[]): NameScope {
  const aliases = new Set<string>()
  let inBranch = false
  for (const fanout of fanoutsContaining(step.id, steps)) {
    inBranch = true
    addAliases(aliases, fanout)
  }
  return withPrev(step, steps, aliases, inBranch)
}

function fanoutsContaining(stepId: string, steps: StepDefinition[]): StepDefinition[] {
  return steps.filter(
    (step) => step.id !== stepId && step.iterate && fanoutInnerSteps(step.id, steps).some((inner) => inner.id === stepId)
  )
}

function addAliases(aliases: Set<string>, step: StepDefinition) {
  const alias = step.iterate?.alias?.trim()
  const note = step.iterate?.noteAlias?.trim()
  if (alias) aliases.add(alias)
  if (note) aliases.add(note)
}

function withPrev(step: StepDefinition, steps: StepDefinition[], aliases: Set<string>, inBranch: boolean): NameScope {
  const prev = previousStep(step, steps)
  return {
    aliases,
    inBranch,
    hasPrev: Boolean(prev),
    prevFields: prev ? outputFields(effectiveStep(prev, steps)) : null
  }
}

function intersectScopes(scopes: NameScope[]): NameScope {
  if (!scopes.length) return NONE
  const aliases = new Set([...scopes[0].aliases].filter((alias) => scopes.every((scope) => scope.aliases.has(alias))))
  const hasPrev = scopes.every((scope) => scope.hasPrev)
  let prevFields: Set<string> | null = null
  if (hasPrev && scopes.every((scope) => scope.prevFields)) {
    const sets = scopes.map((scope) => scope.prevFields!)
    prevFields = new Set([...sets[0]].filter((field) => sets.every((set) => set.has(field))))
  }
  return {
    aliases,
    inBranch: scopes.every((scope) => scope.inBranch),
    hasPrev,
    prevFields
  }
}

/** null — путь существует. Строка — подсказка, в том числе пустая. */
function missingHint(path: string, scope: NameScope, graph: WorkflowGraph, pools?: VariablePools): string | null {
  const segments = parsePath(path)
  if (!segments || segments[0]?.kind !== 'prop') return null
  const root = segments[0].name
  const second = segments[1]?.kind === 'prop' ? segments[1].name : ''
  const third = segments[2]?.kind === 'prop' ? segments[2].name : ''
  const fourth = segments[3]?.kind === 'prop' ? segments[3].name : ''
  if (root === 'inputs') {
    if (!second) return 'Не указано имя входа.'
    return graph.inputs.some((input) => input.name === second) ? null : `Входа «${second}» нет.`
  }
  if (root === 'snippets') {
    if (!second) return 'Не указан фрагмент.'
    return (graph.snippets ?? []).some((snippet) => snippet.key === second) ? null : `Фрагмента «${second}» нет.`
  }
  if (root === 'steps') {
    if (!second) return 'Не указан шаг.'
    const step = graph.steps.find((item) => item.key === second)
    if (!step) return `Шага «${second}» нет.`
    if (third && third !== 'output') return `Результат шага читается как {{steps.${second}.output}}.`
    if (third === 'output' && fourth) {
      const fields = outputFields(effectiveStep(step, graph.steps))
      if (fields && !fields.has(fourth)) return `В схеме шага «${step.name}» нет поля «${fourth}».`
    }
    return null
  }
  if (root === 'globals') {
    if (!pools?.globals) return null
    if (!second) return 'Не указана глобальная переменная.'
    return pools.globals.some((item) => item.name === second) ? null : `Глобальной переменной «${second}» нет.`
  }
  if (root === 'project') {
    if (!pools?.project) return null
    if (!second) return 'Не указана переменная проекта.'
    return pools.project.some((item) => item.name === second) ? null : `Переменной проекта «${second}» нет.`
  }
  if (root === 'prev') {
    if (!scope.hasPrev) return 'Здесь нет предыдущего шага.'
    if (second && second !== 'output') return 'Предыдущий результат читается как {{prev.output}}.'
    if (second === 'output' && third && scope.prevFields && !scope.prevFields.has(third)) {
      return `В схеме предыдущего шага нет поля «${third}».`
    }
    return null
  }
  if (root === 'current_item' || root === 'current_index') {
    return scope.inBranch ? null : 'Здесь нет ветки, эта переменная недоступна.'
  }
  if (scope.aliases.has(root)) return null
  const hints = nameHints(root, graph, pools)
  return hints.length ? hints.join(' ') : 'Такого фрагмента, шага, входа или переменной нет.'
}

function nameHints(root: string, graph: WorkflowGraph, pools?: VariablePools): string[] {
  const hints: string[] = []
  if (graph.inputs.some((input) => input.name === root)) hints.push(`Вход пишется как {{inputs.${root}}}.`)
  if ((graph.snippets ?? []).some((snippet) => snippet.key === root)) hints.push(`Фрагмент пишется как {{snippets.${root}}}.`)
  if (graph.steps.some((step) => step.key === root)) hints.push(`Шаг пишется как {{steps.${root}.output}}.`)
  if (pools?.project?.some((item) => item.name === root)) hints.push(`Переменная проекта пишется как {{project.${root}}}.`)
  if (pools?.globals?.some((item) => item.name === root)) hints.push(`Глобальная переменная пишется как {{globals.${root}}}.`)
  return hints
}

function outputFields(step: StepDefinition): Set<string> | null {
  if (step.type !== 'ai' || step.config.outputFormat !== 'json') return null
  const schema = step.config.jsonSchema
  if (!schema || typeof schema !== 'object') return null
  const properties = (schema as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object') return null
  const keys = Object.keys(properties)
  return keys.length ? new Set(keys) : null
}
