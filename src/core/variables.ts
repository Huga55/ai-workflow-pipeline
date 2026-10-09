import { topoSort } from '@core/graph'
import { isStoredFile } from '@core/media'
import type { ContentPart, NamedVariable, VariableContext, VariableVersion, WorkflowGraph, StepDefinition } from '@core/types'

export type PathSegment = { kind: 'prop'; name: string } | { kind: 'index'; index: number }

const TOKEN = /\{\{\s*([^}]+)\s*\}\}/g

export function parsePath(input: string): PathSegment[] | null {
  const path = input.trim()
  if (!path) return null
  const segments: PathSegment[] = []
  let i = 0
  const ident = () => {
    const start = i
    if (!/[A-Za-z_]/.test(path[i] ?? '')) return null
    i += 1
    while (i < path.length && /[A-Za-z0-9_]/.test(path[i])) i += 1
    return path.slice(start, i)
  }
  const first = ident()
  if (!first) return null
  segments.push({ kind: 'prop', name: first })
  while (i < path.length) {
    if (path[i] === '.') {
      i += 1
      const name = ident()
      if (!name) return null
      segments.push({ kind: 'prop', name })
      continue
    }
    if (path[i] === '[') {
      i += 1
      const start = i
      if (!/[0-9]/.test(path[i] ?? '')) return null
      while (i < path.length && /[0-9]/.test(path[i])) i += 1
      if (path[i] !== ']') return null
      segments.push({ kind: 'index', index: Number(path.slice(start, i)) })
      i += 1
      continue
    }
    return null
  }
  return segments
}

export type ResolveResult = { ok: true; value: unknown } | { ok: false; error: string }

export function resolvePath(path: string, ctx: VariableContext): ResolveResult {
  const segments = parsePath(path)
  if (!segments || segments[0]?.kind !== 'prop') {
    return { ok: false, error: `Некорректный путь «${path}»` }
  }
  const root = segments[0].name
  let value: unknown
  if (root === 'inputs') value = ctx.inputs
  else if (root === 'steps') value = ctx.steps
  else if (root === 'globals') value = ctx.globals ?? {}
  else if (root === 'project') value = ctx.project ?? {}
  else if (root === 'current_item') value = ctx.current_item
  else if (root === 'current_index') value = ctx.current_index
  else if (root === 'prev') {
    if (!ctx.prev) return { ok: false, error: 'У этого шага нет предыдущего' }
    if (ctx.prev.output === undefined) return { ok: false, error: 'Предыдущий шаг ещё без результата' }
    let rest = segments.slice(1)
    if (rest[0]?.kind === 'prop' && rest[0].name === 'output') rest = rest.slice(1)
    return walk(ctx.prev.output, rest, path)
  } else if (Object.prototype.hasOwnProperty.call(ctx.aliases, root)) {
    value = ctx.aliases[root]
    return walk(value, segments.slice(1), path)
  } else {
    return { ok: false, error: `Неизвестная переменная «${root}»` }
  }
  return walk(value, segments.slice(1), path)
}

function walk(value: unknown, segments: PathSegment[], path: string): ResolveResult {
  let current = value
  for (const segment of segments) {
    if (current == null) return { ok: false, error: `Пустое значение в «${path}»` }
    if (segment.kind === 'index') {
      if (!Array.isArray(current)) return { ok: false, error: `«${path}» не является массивом` }
      current = current[segment.index]
      continue
    }
    if (typeof current !== 'object') return { ok: false, error: `«${path}» не является объектом` }
    current = (current as Record<string, unknown>)[segment.name]
  }
  if (current === undefined) return { ok: false, error: `Переменная «${path}» не найдена` }
  return { ok: true, value: current }
}

export function resolveReference(ref: string, ctx: VariableContext): ResolveResult {
  const trimmed = ref.trim()
  const whole = trimmed.match(/^\{\{\s*([^}]+)\s*\}\}$/)
  if (whole) return resolvePath(whole[1], ctx)
  if (trimmed.includes('{{')) {
    const parts = interpolateParts(trimmed, ctx)
    if (parts.length === 1 && parts[0].type === 'text') return { ok: true, value: parts[0].text }
    return { ok: true, value: partsToDisplay(parts) }
  }
  return resolvePath(trimmed, ctx)
}

function partsToDisplay(parts: ContentPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : `[image:${part.name}]`))
    .join('')
}

export function interpolate(template: string, ctx: VariableContext): unknown {
  const whole = template.match(/^\{\{\s*([^}]+)\s*\}\}$/)
  if (whole) {
    const resolved = resolvePath(whole[1], ctx)
    return resolved.ok ? resolved.value : template
  }
  return template.replace(TOKEN, (raw, path: string) => {
    const resolved = resolvePath(path.trim(), ctx)
    if (!resolved.ok) return raw
    return stringifyValue(resolved.value)
  })
}

export function interpolateParts(template: string, ctx: VariableContext): ContentPart[] {
  const parts: ContentPart[] = []
  const pushText = (text: string) => {
    if (!text) return
    const prev = parts[parts.length - 1]
    if (prev?.type === 'text') prev.text += text
    else parts.push({ type: 'text', text })
  }
  const append = (value: unknown) => {
    if (isStoredFile(value, 'image')) {
      const image = value as { path: string; mime: string; name: string }
      parts.push({ type: 'image', path: image.path, mime: image.mime, name: image.name })
      return
    }
    if (Array.isArray(value)) {
      value.forEach(append)
      return
    }
    pushText(stringifyValue(value))
  }

  let last = 0
  const flags = new RegExp(TOKEN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = flags.exec(template))) {
    pushText(template.slice(last, match.index))
    const resolved = resolvePath(match[1].trim(), ctx)
    if (!resolved.ok) pushText(match[0])
    else append(resolved.value)
    last = match.index + match[0].length
  }
  pushText(template.slice(last))
  return parts
}

export function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''
  return JSON.stringify(value, null, 2)
}

export function latestVariableVersion(variable: NamedVariable): VariableVersion | undefined {
  const versions = variable.versions ?? []
  return versions.reduce<VariableVersion | undefined>(
    (best, item) => (!best || item.version > best.version ? item : best),
    undefined
  )
}

export function previousStep(step: StepDefinition, steps: StepDefinition[]): StepDefinition | null {
  const byId = new Map(steps.map((item) => [item.id, item]))
  const deps = step.dependsOn
    .map((id) => byId.get(id))
    .filter((item): item is StepDefinition => Boolean(item))
  if (!deps.length) return null
  if (deps.length === 1) return deps[0]
  const sorted = topoSort(steps)
  const order = sorted.ok ? sorted.steps : [...steps].sort((a, b) => a.order - b.order)
  return deps.reduce((best, item) =>
    order.findIndex((candidate) => candidate.id === item.id) > order.findIndex((candidate) => candidate.id === best.id) ? item : best
  )
}

export type CatalogItem = { path: string; label: string; hint?: string }
export type CatalogGroup = { title: string; items: CatalogItem[] }
export type VariablePools = {
  globals?: { name: string; label: string; version?: number }[]
  project?: { name: string; label: string; version?: number }[]
}

export function variableCatalog(graph: WorkflowGraph, step?: StepDefinition, pools?: VariablePools): CatalogGroup[] {
  const groups: CatalogGroup[] = []
  groups.push({
    title: 'Входы',
    items: graph.inputs.map((input) => ({
      path: `inputs.${input.name}`,
      label: input.label || input.name,
      hint: input.name
    }))
  })
  const named = (title: string, root: 'globals' | 'project', items: { name: string; label: string; version?: number }[] | undefined) => {
    if (!items?.length) return
    groups.push({
      title,
      items: items.map((item) => ({
        path: `${root}.${item.name}`,
        label: item.label || item.name,
        hint: item.version ? `v${item.version}` : item.name
      }))
    })
  }
  named('Проект', 'project', pools?.project)
  named('Глобальные', 'globals', pools?.globals)

  if (step) {
    const prev = previousStep(step, graph.steps)
    if (prev) {
      const items: CatalogItem[] = [
        { path: 'prev.output', label: 'Выход предыдущего шага', hint: prev.name }
      ]
      if (prev.type === 'ai' && prev.config.outputFormat === 'json') {
        for (const prop of schemaProperties(prev.config.jsonSchema)) {
          items.push({ path: `prev.output.${prop}`, label: `${prev.name} → ${prop}`, hint: prop })
        }
      }
      groups.push({ title: 'Предыдущий', items })
    }
  }

  const stepItems: CatalogItem[] = []
  for (const candidate of graph.steps) {
    if (step && candidate.id === step.id) continue
    stepItems.push({
      path: `steps.${candidate.key}.output`,
      label: candidate.name,
      hint: 'output'
    })
    if (candidate.type === 'ai' && candidate.config.outputFormat === 'json') {
      const props = schemaProperties(candidate.config.jsonSchema)
      for (const prop of props) {
        stepItems.push({
          path: `steps.${candidate.key}.output.${prop}`,
          label: `${candidate.name} → ${prop}`,
          hint: prop
        })
      }
    }
  }
  groups.push({ title: 'Шаги', items: stepItems })

  const context: CatalogItem[] = [
    { path: 'current_item', label: 'Текущий элемент', hint: 'current_item' },
    { path: 'current_index', label: 'Индекс элемента', hint: 'current_index' }
  ]
  const aliases = new Set<string>()
  if (step) {
    for (const ancestor of upstreamSteps(step, graph.steps)) {
      if (ancestor.iterate?.alias) aliases.add(ancestor.iterate.alias)
      if (ancestor.iterate?.noteAlias) aliases.add(ancestor.iterate.noteAlias)
    }
    if (step.iterate?.alias) aliases.add(step.iterate.alias)
    if (step.iterate?.noteAlias) aliases.add(step.iterate.noteAlias)
  }
  for (const alias of aliases) {
    if (alias === 'current_item' || alias === 'current_index') continue
    context.push({ path: alias, label: alias, hint: 'алиас ветки' })
  }
  groups.push({ title: 'Ветка', items: context })
  return groups
}

function upstreamSteps(step: StepDefinition, steps: StepDefinition[]): StepDefinition[] {
  const byId = new Map(steps.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const out: StepDefinition[] = []
  const stack = [...step.dependsOn]
  while (stack.length) {
    const id = stack.pop()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const found = byId.get(id)
    if (!found) continue
    out.push(found)
    stack.push(...found.dependsOn)
  }
  return out
}

function schemaProperties(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return []
  const props = (schema as { properties?: Record<string, unknown> }).properties
  if (!props || typeof props !== 'object') return []
  return Object.keys(props).slice(0, 12)
}
