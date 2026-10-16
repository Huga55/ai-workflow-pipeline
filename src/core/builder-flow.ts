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

function primaryParent(root: StepDefinition, mainOrder: Map<string, number>): string | null {
  const candidates = root.dependsOn.filter((id) => mainOrder.has(id))
  if (!candidates.length) return null
  return candidates.reduce((best, id) => ((mainOrder.get(id) ?? -1) > (mainOrder.get(best) ?? -1) ? id : best))
}
