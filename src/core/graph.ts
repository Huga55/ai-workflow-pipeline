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

export function fanoutInnerSteps(stepId: string, steps: StepDefinition[]): StepDefinition[] {
  const fanout = steps.find((step) => step.id === stepId)
  const dependents = innerDependents(stepId, steps)
  if (!fanout || fanout.type !== 'fanout') return dependents
  const upstream = ancestorIds(stepId, steps)
  const owned = new Set(dependents.map((step) => step.id))
  const ordered = [...steps].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  let after = false
  for (const step of ordered) {
    if (step.id === stepId) {
      after = true
      continue
    }
    if (!after || upstream.has(step.id) || owned.has(step.id)) continue
    if (step.type === 'merge' && step.config.mode === 'collect') {
      const targetId = step.config.fromFanoutStepId
      if (targetId === stepId || upstream.has(targetId)) break
    }
    owned.add(step.id)
  }
  return steps.filter((step) => owned.has(step.id))
}

function ancestorIds(stepId: string, steps: StepDefinition[]): Set<string> {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const out = new Set<string>()
  const stack = [...(byId.get(stepId)?.dependsOn ?? [])]
  while (stack.length) {
    const id = stack.pop()
    if (!id || out.has(id)) continue
    out.add(id)
    const step = byId.get(id)
    if (!step) continue
    stack.push(...step.dependsOn)
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

export function chainStepIds(stepId: string, steps: StepDefinition[]): Set<string> {
  const origin = steps.find((step) => step.id === stepId)
  const out = new Set<string>()
  if (!origin) return out
  const byId = new Map(steps.map((step) => [step.id, step]))
  const children = childMap(steps)
  const upstream = ancestorIds(stepId, steps)
  const owners = steps.filter(
    (step) => step.iterate && (step.id === stepId || fanoutInnerSteps(step.id, steps).some((inner) => inner.id === stepId))
  )
  for (const owner of owners) {
    if (owner.id !== stepId) upstream.add(owner.id)
    for (const id of ancestorIds(owner.id, steps)) upstream.add(id)
  }
  const add = (id: string) => {
    const stack = [id]
    while (stack.length) {
      const current = stack.pop()
      if (!current || out.has(current) || upstream.has(current)) continue
      out.add(current)
      const step = byId.get(current)
      if (step?.iterate) {
        for (const inner of fanoutInnerSteps(step.id, steps)) stack.push(inner.id)
      }
      for (const child of children.get(current) ?? []) stack.push(child.id)
    }
  }
  add(stepId)
  const hidden = hiddenDescendantIds(steps, null)
  const later = (step: StepDefinition) => step.order > origin.order && !upstream.has(step.id)
  if (!hidden.has(origin.id)) {
    for (const step of steps) {
      if (later(step)) add(step.id)
    }
    return out
  }
  for (const owner of owners) {
    if (owner.id === origin.id) continue
    for (const step of fanoutInnerSteps(owner.id, steps)) {
      if (later(step)) add(step.id)
    }
    for (const step of steps) {
      if (hidden.has(step.id) || step.order <= owner.order || upstream.has(step.id)) continue
      add(step.id)
    }
  }
  return out
}

export function hiddenDescendantIds(steps: StepDefinition[], entryStepId: string | null): Set<string> {
  const hidden = new Set<string>()
  for (const step of steps) {
    if (step.iterate && step.id !== entryStepId) {
      for (const dependent of fanoutInnerSteps(step.id, steps)) hidden.add(dependent.id)
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
    if (step.type === 'fanout' && !step.iterate) errors.push(`Шаг «${step.name}» не раскладывает массив`)
    if (step.iterate && !step.iterate.over.trim()) {
      errors.push(`У шага «${step.name}» не указан источник ветвления`)
    }
    if (step.iterate && !KEY.test(step.iterate.alias)) {
      errors.push(`Некорректный алиас ветки у шага «${step.name}»`)
    }
    if (step.iterate?.noteAlias && !KEY.test(step.iterate.noteAlias)) {
      errors.push(`Некорректное имя текста у шага «${step.name}»`)
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
