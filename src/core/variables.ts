import { isStoredFile } from '@core/media'
import { effectiveStep } from '@core/step-ref'
import type { ContentPart, NamedVariable, VariableContext, VariableVersion, WorkflowGraph, StepDefinition } from '@core/types'

const SNIPPET_DEPTH = 8

export type PathSegment = { kind: 'prop'; name: string } | { kind: 'index'; index: number }

const TOKEN = /\{\{\s*([^}]+)\s*\}\}/g

type TemplateNode =
  | { kind: 'text'; text: string }
  | { kind: 'var'; path: string; raw: string }
  | { kind: 'if'; path: string; children: TemplateNode[] }

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
  else if (root === 'snippets') value = ctx.snippets ?? {}
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
  if (whole && !isDirective(whole[1].trim())) return resolvePath(whole[1], ctx)
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

function isDirective(inner: string): boolean {
  return inner === '/if' || inner.startsWith('#') || inner.startsWith('/')
}

export function messageAllowed(when: { op: 'and' | 'or'; paths: string[] } | undefined, ctx: VariableContext): boolean {
  if (!when || when.paths.length === 0) return true
  const present = when.paths.map((path) => {
    const resolved = resolvePath(path, ctx)
    return resolved.ok && isPresent(resolved.value)
  })
  return when.op === 'or' ? present.some(Boolean) : present.every(Boolean)
}

export function isPresent(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return !Number.isNaN(value)
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function validateTemplate(template: string): string[] {
  const errors: string[] = []
  const stack: string[] = []
  const flags = new RegExp(TOKEN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = flags.exec(template))) {
    const inner = match[1].trim()
    if (inner === '/if') {
      if (!stack.length) errors.push('Лишний {{/if}} без открывающего {{#if}}')
      else stack.pop()
      continue
    }
    if (inner.startsWith('#if')) {
      const path = inner.slice(3).trim()
      if (!path) errors.push('В {{#if}} не указан путь')
      else if (!parsePath(path)) errors.push(`Некорректный путь «${path}» в {{#if}}`)
      stack.push(path)
      continue
    }
    if (inner.startsWith('#') || inner.startsWith('/')) {
      errors.push(`Неизвестная конструкция {{${inner}}}`)
    }
  }
  if (stack.length === 1) errors.push(`Не закрыт {{#if ${stack[0]}}}`)
  else if (stack.length > 1) {
    errors.push(`Не закрыты {{#if}}: ${stack.map((path) => path || '…').join(', ')}`)
  }
  return errors
}

export function templatesInStep(step: StepDefinition, steps: StepDefinition[] = []): string[] {
  const resolved = steps.length ? effectiveStep(step, steps) : step
  const out: string[] = []
  if (step.iterate?.over) out.push(step.iterate.over)
  switch (resolved.type) {
    case 'ai':
      for (const message of resolved.config.messages) out.push(message.content)
      break
    case 'transform':
      if (resolved.config.template) out.push(resolved.config.template)
      if (resolved.config.source) out.push(resolved.config.source)
      if (resolved.config.value) out.push(resolved.config.value)
      break
    case 'parse':
      out.push(resolved.config.source)
      break
    case 'manual':
      out.push(resolved.config.prompt)
      if (resolved.config.source) out.push(resolved.config.source)
      break
    case 'merge':
      if (resolved.config.mode === 'object') {
        for (const source of resolved.config.sources) out.push(source.ref)
      }
      break
    default:
      break
  }
  return out
}

export function validateWorkflowTemplates(graph: WorkflowGraph): string[] {
  const errors: string[] = []
  for (const snippet of graph.snippets ?? []) {
    for (const issue of validateTemplate(snippet.content)) {
      errors.push(`Фрагмент «${snippet.key}»: ${issue}`)
    }
  }
  for (const chat of graph.chats ?? []) {
    for (const issue of validateTemplate(chat.instruction)) {
      errors.push(`Чат «${chat.key}»: ${issue}`)
    }
  }
  for (const step of graph.steps) {
    if (step.use) continue
    for (const template of templatesInStep(step, graph.steps)) {
      for (const issue of validateTemplate(template)) {
        errors.push(`Шаг «${step.name}»: ${issue}`)
      }
    }
    if (step.type === 'ai') {
      step.config.messages.forEach((message, index) => {
        if (!message.when) return
        if (!message.when.paths.length) {
          errors.push(`Шаг «${step.name}»: у сообщения ${index + 1} условие без переменных`)
        }
        for (const path of message.when.paths) {
          if (!parsePath(path)) errors.push(`Шаг «${step.name}»: некорректный путь «${path}» в условии сообщения ${index + 1}`)
        }
      })
    }
  }
  return errors
}

function isSnippetPath(path: string): boolean {
  return path.trim().startsWith('snippets.')
}

function parseTemplate(template: string): TemplateNode[] {
  const root: TemplateNode[] = []
  const stack: { path: string; children: TemplateNode[] }[] = [{ path: '', children: root }]
  let last = 0
  const flags = new RegExp(TOKEN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = flags.exec(template))) {
    const current = stack[stack.length - 1]
    if (!current) break
    if (match.index > last) current.children.push({ kind: 'text', text: template.slice(last, match.index) })
    const raw = match[0]
    const inner = match[1].trim()
    last = match.index + raw.length
    if (inner === '/if') {
      if (stack.length === 1) {
        current.children.push({ kind: 'text', text: raw })
        continue
      }
      stack.pop()
      continue
    }
    if (inner.startsWith('#if')) {
      const path = inner.slice(3).trim()
      const node: TemplateNode = { kind: 'if', path, children: [] }
      current.children.push(node)
      stack.push({ path, children: node.children })
      continue
    }
    if (isDirective(inner)) {
      current.children.push({ kind: 'text', text: raw })
      continue
    }
    current.children.push({ kind: 'var', path: inner, raw })
  }
  if (last < template.length) {
    const current = stack[stack.length - 1]
    if (current) current.children.push({ kind: 'text', text: template.slice(last) })
  }
  return root
}

function conditionValue(path: string, ctx: VariableContext): unknown {
  const resolved = resolvePath(path, ctx)
  return resolved.ok ? resolved.value : null
}

export function interpolate(template: string, ctx: VariableContext): unknown {
  const whole = template.match(/^\{\{\s*([^}]+)\s*\}\}$/)
  if (whole && !isDirective(whole[1].trim())) {
    const path = whole[1].trim()
    if (isSnippetPath(path)) return renderText(parseTemplate(template), ctx, 0)
    const resolved = resolvePath(path, ctx)
    return resolved.ok ? resolved.value : template
  }
  return renderText(parseTemplate(template), ctx, 0)
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
  const walkNodes = (nodes: TemplateNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind === 'text') {
        pushText(node.text)
        continue
      }
      if (node.kind === 'var') {
        const resolved = resolvePath(node.path, ctx)
        if (!resolved.ok) {
          pushText(node.raw)
          continue
        }
        if (isSnippetPath(node.path) && typeof resolved.value === 'string') {
          if (depth < SNIPPET_DEPTH) walkNodes(parseTemplate(resolved.value), depth + 1)
          continue
        }
        append(resolved.value)
        continue
      }
      if (isPresent(conditionValue(node.path, ctx))) walkNodes(node.children, depth)
    }
  }
  walkNodes(parseTemplate(template), 0)
  return parts
}

function renderText(nodes: TemplateNode[], ctx: VariableContext, depth: number): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.text
      continue
    }
    if (node.kind === 'var') {
      const resolved = resolvePath(node.path, ctx)
      if (!resolved.ok) {
        out += node.raw
        continue
      }
      if (isSnippetPath(node.path) && typeof resolved.value === 'string') {
        if (depth < SNIPPET_DEPTH) out += renderText(parseTemplate(resolved.value), ctx, depth + 1)
        continue
      }
      out += stringifyValue(resolved.value)
      continue
    }
    if (isPresent(conditionValue(node.path, ctx))) out += renderText(node.children, ctx, depth)
  }
  return out
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
  return deps.reduce((best, item) =>
    item.order > best.order || (item.order === best.order && item.name.localeCompare(best.name) > 0) ? item : best
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
  if (graph.snippets?.length) {
    groups.push({
      title: 'Фрагменты',
      items: graph.snippets.map((snippet) => ({
        path: `snippets.${snippet.key}`,
        label: snippet.key,
        hint: 'фрагмент'
      }))
    })
  }
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
