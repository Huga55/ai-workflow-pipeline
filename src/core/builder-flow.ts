import { topoSort } from '@core/graph'
import { sideChains } from '@core/side-branch'
import type { StepDefinition } from '@core/types'

export type BuilderSideBranch = {
  root: StepDefinition
  steps: StepDefinition[]
}

export type BuilderFlowBlock = {
  step: StepDefinition
  sides: BuilderSideBranch[]
}

export type BuilderFlowLayout = {
  blocks: BuilderFlowBlock[]
  orphans: BuilderSideBranch[]
}

/** Цепочка доп. ветки: корень с sideBranch и шаги, у которых все зависимости уже внутри этой цепочки. */
export function sideBranchChain(root: StepDefinition, steps: StepDefinition[]): StepDefinition[] {
  const chain = sideChains(steps).find((item) => item.rootId === root.id)
  const ids = new Set(chain?.stepIds ?? [root.id])
  const owned = steps.filter((step) => ids.has(step.id))
  const sorted = topoSort(owned)
  return sorted.ok ? sorted.steps : [...owned].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

export function builderFlowLayout(steps: StepDefinition[]): BuilderFlowLayout {
  const roots = steps.filter((step) => step.sideBranch)
  const found = sideChains(steps)
  const chains = new Map<string, StepDefinition[]>()
  const claimed = new Set<string>()
  for (const chain of found) {
    const root = steps.find((step) => step.id === chain.rootId)
    if (!root) continue
    const stepsInChain = sideBranchChain(root, steps)
    for (const step of stepsInChain) claimed.add(step.id)
    chains.set(chain.rootId, stepsInChain)
  }

  const main = steps.filter((step) => !claimed.has(step.id))
  const sorted = topoSort(main)
  const mainSteps = sorted.ok ? sorted.steps : [...main].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const mainOrder = new Map(mainSteps.map((step, index) => [step.id, index]))

  const attached = new Set<string>()
  const blocks: BuilderFlowBlock[] = mainSteps.map((step) => {
    const sides: BuilderSideBranch[] = []
    for (const root of roots) {
      if (attached.has(root.id)) continue
      const parent = primaryParent(root, mainOrder)
      if (parent !== step.id) continue
      const chain = chains.get(root.id) ?? [root]
      sides.push({ root, steps: chain })
      attached.add(root.id)
    }
    sides.sort((a, b) => a.root.order - b.root.order || a.root.name.localeCompare(b.root.name))
    return { step, sides }
  })

  const orphans: BuilderSideBranch[] = []
  for (const root of roots) {
    if (attached.has(root.id)) continue
    orphans.push({ root, steps: chains.get(root.id) ?? [root] })
  }
  orphans.sort((a, b) => a.root.order - b.root.order || a.root.name.localeCompare(b.root.name))
  return { blocks, orphans }
}

/**
 * Ставит шаг сразу после зависимости.
 * Доп. ветки одного шага идут целыми блоками одна за другой,
 * следующий шаг основной колонки — после всех таких веток.
 * При цикле порядок не меняется.
 */
export function placeStepAfterDependency(steps: StepDefinition[], stepId: string): StepDefinition[] {
  const subject = steps.find((step) => step.id === stepId)
  if (!subject || !topoSort(steps).ok) return steps

  const anchor = latestDependency(subject, steps)
  // Корень доп. ветки сохраняет место среди других веток той же опоры: новый шаг и так последний по order.
  const provisional = subject.sideBranch ? subject.order : anchor ? anchor.order + 0.5 : 0
  const adjusted = steps.map((step) => (step.id === stepId ? { ...step, order: provisional } : step))
  const sequence = sequenceForOrders(builderFlowLayout(adjusted), adjusted)
  if (sequence.length !== steps.length) return steps

  const byId = new Map(steps.map((step) => [step.id, step]))
  return sequence.map((step, index) => {
    const original = byId.get(step.id) ?? step
    const order = index + 1
    return original.order === order ? original : { ...original, order }
  })
}

function sequenceForOrders(layout: BuilderFlowLayout, steps: StepDefinition[]): StepDefinition[] {
  const sequence: StepDefinition[] = []
  for (const block of layout.blocks) {
    sequence.push(block.step)
    for (const side of block.sides) sequence.push(...side.steps)
  }
  const pending = [...layout.orphans]
  const chains = sideChains(steps)
  while (pending.length) {
    const ready = pending.findIndex((side) =>
      side.root.dependsOn.every((id) => sequence.some((step) => step.id === id) || !pending.some((other) => other.steps.some((step) => step.id === id)))
    )
    const [side] = pending.splice(ready >= 0 ? ready : 0, 1)
    insertAfterDependency(sequence, side.steps, side.root.dependsOn, chains)
  }
  return sequence
}

function insertAfterDependency(sequence: StepDefinition[], block: StepDefinition[], dependsOn: string[], chains: ReturnType<typeof sideChains>) {
  let anchorIndex = -1
  for (const id of dependsOn) {
    const index = sequence.findIndex((step) => step.id === id)
    if (index > anchorIndex) anchorIndex = index
  }
  if (anchorIndex < 0) {
    sequence.push(...block)
    return
  }
  const chain = chains.find((item) => item.stepIds.includes(sequence[anchorIndex].id))
  let end = anchorIndex
  if (chain) {
    while (end + 1 < sequence.length && chain.stepIds.includes(sequence[end + 1].id)) end += 1
  }
  sequence.splice(end + 1, 0, ...block)
}

function latestDependency(step: StepDefinition, steps: StepDefinition[]): StepDefinition | null {
  const byId = new Map(steps.map((item) => [item.id, item]))
  let best: StepDefinition | null = null
  for (const id of step.dependsOn) {
    const dep = byId.get(id)
    if (!dep) continue
    if (!best || dep.order > best.order || (dep.order === best.order && dep.name.localeCompare(best.name) > 0)) best = dep
  }
  return best
}

function primaryParent(root: StepDefinition, mainOrder: Map<string, number>): string | null {
  const candidates = root.dependsOn.filter((id) => mainOrder.has(id))
  if (!candidates.length) return null
  return candidates.reduce((best, id) => ((mainOrder.get(id) ?? -1) > (mainOrder.get(best) ?? -1) ? id : best))
}
