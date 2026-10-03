import type { EngineStore } from '@core/store'
import type { Artifact, Branch, StepExecution, UserAction } from '@core/types'

export class MemoryStore implements EngineStore {
  executions: StepExecution[] = []
  branches: Branch[] = []
  artifacts: Artifact[] = []
  actions: UserAction[] = []

  listExecutions(runId: string): StepExecution[] {
    return this.executions.filter((item) => item.runId === runId).map(clone)
  }

  listBranches(runId: string): Branch[] {
    return this.branches.filter((item) => item.runId === runId).map(clone)
  }

  listArtifacts(runId: string): Artifact[] {
    return this.artifacts.filter((item) => item.runId === runId).map(clone)
  }

  insertExecution(execution: StepExecution): void {
    this.executions.push(clone(execution))
  }

  updateExecution(execution: StepExecution): void {
    const index = this.executions.findIndex((item) => item.id === execution.id)
    if (index >= 0) this.executions[index] = clone(execution)
  }

  insertArtifact(artifact: Artifact): void {
    this.artifacts.push(clone(artifact))
  }

  insertBranch(branch: Branch): void {
    this.branches.push(clone(branch))
  }

  updateBranch(branch: Branch): void {
    const index = this.branches.findIndex((item) => item.id === branch.id)
    if (index >= 0) this.branches[index] = clone(branch)
  }

  insertUserAction(action: UserAction): void {
    this.actions.push(clone(action))
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
