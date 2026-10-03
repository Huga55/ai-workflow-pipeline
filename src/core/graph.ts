import type { StepDefinition, WorkflowGraph } from '@core/types'

export function childMap(steps: StepDefinition[]): Map<string, StepDefinition[]> {
  const map = new Map<string, StepDefinition[]>()
  for (const step of steps) map.set(step.id, [])
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const list = map.get(dep)
      if (list) list.push(step)
    }
  }
  return map
}

export function isCollectMerge(step: StepDefinition): boolean {
  return step.type === 'merge' && step.config.mode === 'collect'
}

export function innerDependents(stepId: string, steps: StepDefinition[]): StepDefinition[] {
  const children = childMap(steps)
  const out: StepDefinition[] = []
  const seen = new Set<string>()
  const stack = [...(children.get(stepId) ?? [])]
  while (stack.length) {
    const next = stack.pop()
    if (!next || seen.has(next.id)) continue
    if (isCollectMerge(next)) continue
    seen.add(next.id)
    out.push(next)
    stack.push(...(children.get(next.id) ?? []))
  }
  return out
}

export function dependentIds(stepId: string, steps: StepDefinition[]): Set<string> {
  const children = childMap(steps)
  const out = new Set<string>([stepId])
  const stack = [stepId]
  while (stack.length) {
    const id = stack.pop()
    if (!id) continue
    for (const child of children.get(id) ?? []) {
      if (out.has(child.id)) continue
      out.add(child.id)
      stack.push(child.id)
    }
  }
  return out
}

export function hiddenDescendantIds(steps: StepDefinition[], entryStepId: string | null): Set<string> {
  const hidden = new Set<string>()
  for (const step of steps) {
    if (step.iterate && step.id !== entryStepId) {
      for (const dependent of innerDependents(step.id, steps)) hidden.add(dependent.id)
    }
  }
  return hidden
}

export function topoSort(
  steps: StepDefinition[]
): { ok: true; steps: StepDefinition[] } | { ok: false; message: string } {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const indegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const step of steps) {
    indegree.set(step.id, 0)
    children.set(step.id, [])
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) continue
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1)
      children.get(dep)?.push(step.id)
    }
  }
  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0)
  const ordered: StepDefinition[] = []
  while (queue.length) {
    queue.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    const next = queue.shift()
    if (!next) break
    ordered.push(next)
    for (const childId of children.get(next.id) ?? []) {
      const left = (indegree.get(childId) ?? 0) - 1
      indegree.set(childId, left)
      if (left === 0) {
        const child = byId.get(childId)
        if (child) queue.push(child)
      }
    }
  }
  if (ordered.length !== steps.length) return { ok: false, message: 'В графе шагов есть цикл' }
  return { ok: true, steps: ordered }
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = []
  const inputNames = new Set<string>()
  for (const input of graph.inputs) {
    if (!KEY.test(input.name)) errors.push(`Некорректное имя входа «${input.name || input.label}»`)
    if (inputNames.has(input.name)) errors.push(`Повторяется имя входа «${input.name}»`)
    inputNames.add(input.name)
    if ((input.type === 'select' || input.type === 'multi-select') && !(input.options?.length)) {
      errors.push(`У входа «${input.label}» нет вариантов выбора`)
    }
  }
  const keys = new Set<string>()
  const ids = new Set(graph.steps.map((step) => step.id))
  for (const step of graph.steps) {
    if (!KEY.test(step.key)) errors.push(`Некорректный ключ шага «${step.name}»`)
    if (keys.has(step.key)) errors.push(`Повторяется ключ шага «${step.key}»`)
    keys.add(step.key)
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) errors.push(`Шаг «${step.name}» ссылается на отсутствующую зависимость`)
    }
    if (step.iterate && !step.iterate.over.trim()) {
      errors.push(`У шага «${step.name}» не указан источник ветвления`)
    }
    if (step.iterate && !KEY.test(step.iterate.alias)) {
      errors.push(`Некорректный алиас ветки у шага «${step.name}»`)
    }
    if (step.type === 'ai' && step.config.outputFormat === 'json' && step.config.jsonSchema) {
      if (typeof step.config.jsonSchema !== 'object') errors.push(`JSON Schema шага «${step.name}» должна быть объектом`)
    }
    if (step.type === 'merge' && step.config.mode === 'collect') {
      if (!step.dependsOn.includes(step.config.fromFanoutStepId)) {
        errors.push(`Сборка «${step.name}» должна зависеть от шага, который создаёт ветки`)
      }
    }
  }
  const sorted = topoSort(graph.steps)
  if (!sorted.ok) errors.push(sorted.message)
  return errors
}
