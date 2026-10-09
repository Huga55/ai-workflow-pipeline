import type { InputType, IterateConfig, RunDetails, StepDefinition, WorkflowGraph } from '@core/types'

export type RunVersionFit = { ok: true } | { ok: false; reasons: string[] }

export function runVersionFit(current: WorkflowGraph, next: WorkflowGraph, details: Pick<RunDetails, 'executions' | 'branches' | 'run'>): RunVersionFit {
  const reasons: string[] = []
  const executed = new Set(details.executions.map((item) => item.stepId))
  const branched = new Set(details.branches.map((item) => item.sourceStepId))
  const done = new Set([...executed, ...branched])
  const nextById = new Map(next.steps.map((step) => [step.id, step]))

  for (const step of current.steps) {
    if (!done.has(step.id)) continue
    const fresh = nextById.get(step.id)
    if (!fresh) {
      reasons.push(`Шаг «${step.name}» уже есть в запуске, в новой версии его нет`)
      continue
    }
    if (fresh.type !== step.type) reasons.push(`Шаг «${step.name}» сменил тип`)
    if (fresh.key !== step.key) reasons.push(`Шаг «${step.name}» сменил ключ «${step.key}»`)
    if (!sameIds(fresh.dependsOn, step.dependsOn)) reasons.push(`У шага «${step.name}» изменились зависимости`)
    const shape = configShapeChange(step, fresh)
    if (shape) reasons.push(`У шага «${step.name}» изменился ${shape}`)
    const iterate = iterateChange(step, fresh, branched.has(step.id), executed.has(step.id))
    if (iterate) reasons.push(`У шага «${step.name}» ${iterate}`)
  }

  for (const input of next.inputs) {
    const previous = current.inputs.find((item) => item.name === input.name)
    if (previous && previous.type !== input.type && family(previous.type) !== family(input.type) && filled(details.run.inputs[input.name])) {
      reasons.push(`Вход «${input.label || input.name}» сменил тип`)
    }
    if (!input.required || input.defaultValue !== undefined) continue
    if (!filled(details.run.inputs[input.name])) reasons.push(`Обязательный вход «${input.label || input.name}» не заполнен`)
  }

  return reasons.length ? { ok: false, reasons } : { ok: true }
}

function iterateChange(before: StepDefinition, after: StepDefinition, hasBranches: boolean, hasExecution: boolean): string | null {
  if (hasBranches) {
    return sameIterate(before.iterate, after.iterate) ? null : 'нельзя менять ветвление: ветки уже созданы'
  }
  if (!hasExecution) return null
  const wasOn = Boolean(before.iterate)
  const nowOn = Boolean(after.iterate)
  if (wasOn !== nowOn) return 'нельзя включать или выключать ветвление у уже выполненного шага'
  return null
}

function sameIterate(before: IterateConfig | null, after: IterateConfig | null): boolean {
  if (!before || !after) return before === after
  return before.over === after.over && before.alias === after.alias && before.launch === after.launch && (before.noteAlias ?? '') === (after.noteAlias ?? '')
}

function configShapeChange(before: StepDefinition, after: StepDefinition): string | null {
  if (before.type !== after.type) return null
  if (before.type === 'ai' && after.type === 'ai' && before.config.outputFormat !== after.config.outputFormat) return 'формат ответа'
  if (before.type === 'transform' && after.type === 'transform' && before.config.mode !== after.config.mode) return 'режим преобразования'
  if (before.type === 'parse' && after.type === 'parse' && before.config.mode !== after.config.mode) return 'режим разбора'
  if (before.type === 'manual' && after.type === 'manual' && before.config.mode !== after.config.mode) return 'режим ручного шага'
  if (before.type === 'merge' && after.type === 'merge' && before.config.mode !== after.config.mode) return 'режим сборки'
  if (before.type === 'input' && after.type === 'input' && !sameIds(before.config.keys, after.config.keys)) return 'набор входов'
  return null
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((item, index) => item === b[index])
}

function family(type: InputType): string {
  if (type === 'string' || type === 'text') return 'text'
  return type
}

function filled(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'number') return !Number.isNaN(value)
  return true
}
