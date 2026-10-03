import type { Artifact, Branch, StepExecution, UserAction } from '@core/types'

export interface EngineStore {
  listExecutions(runId: string): StepExecution[]
  listBranches(runId: string): Branch[]
  listArtifacts(runId: string): Artifact[]
  insertExecution(execution: StepExecution): void
  updateExecution(execution: StepExecution): void
  insertArtifact(artifact: Artifact): void
  insertBranch(branch: Branch): void
  updateBranch(branch: Branch): void
  insertUserAction(action: UserAction): void
}
