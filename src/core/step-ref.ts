import type { StepDefinition } from '@core/types'

/** Подставляет type и config из шага, на который указывает `use`. */
export function effectiveStep(step: StepDefinition, steps: StepDefinition[], seen = new Set<string>()): StepDefinition {
  if (!step.use) return step
  if (seen.has(step.id)) return step
  seen.add(step.id)
  const source = steps.find((item) => item.key === step.use)
  if (!source) return step
  const resolved = effectiveStep(source, steps, seen)
  return { ...step, type: resolved.type, config: resolved.config } as StepDefinition
}
