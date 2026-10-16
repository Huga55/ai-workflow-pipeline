import type { StepDefinition } from '@core/types'

export type SideChain = {
  rootId: string
  stepIds: string[]
  anchorId: string | null
}

/** Цепочка доп. ветки и шаг, от которого она рисуется. */
export function sideChains(steps: StepDefinition[]): SideChain[] {
  const roots = steps.filter((step) => step.sideBranch)
  const claimed = new Set<string>()
  const raw: { rootId: string; ids: Set<string> }[] = []
  for (const root of roots) {
    if (claimed.has(root.id)) continue
    const ids = new Set<string>([root.id])
    let grew = true
    while (grew) {
      grew = false
      for (const step of steps) {
        if (ids.has(step.id) || step.sideBranch) continue
        if (!step.dependsOn.length) continue
        if (step.dependsOn.every((dep) => ids.has(dep))) {
          ids.add(step.id)
          grew = true
        }
      }
    }
    for (const id of ids) claimed.add(id)
    raw.push({ rootId: root.id, ids })
  }
  return raw.map((chain) => ({
    rootId: chain.rootId,
    stepIds: [...chain.ids],
    anchorId: anchorOf(chain.rootId, chain.ids, steps)
  }))
}

function anchorOf(rootId: string, ids: Set<string>, steps: StepDefinition[]): string | null {
  const root = steps.find((step) => step.id === rootId)
  if (!root) return null
  const candidates = root.dependsOn.filter((id) => !ids.has(id) && steps.some((step) => step.id === id))
  if (!candidates.length) return null
  return candidates.reduce((best, id) => (later(id, best, steps) ? id : best))
}

function later(id: string, best: string, steps: StepDefinition[]): boolean {
  const next = steps.find((step) => step.id === id)
  const current = steps.find((step) => step.id === best)
  if (!next || !current) return false
  if (next.order !== current.order) return next.order > current.order
  return next.name.localeCompare(current.name) > 0
}
