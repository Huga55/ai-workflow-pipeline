import type {
  Project,
  ProviderStatus,
  NamedVariable,
  RunDetails,
  RunStepOptions,
  RunSummary,
  StoredFile,
  UserActionPayload,
  WorkflowDetails,
  WorkflowDraft,
  WorkflowGraph
} from '@core/types'

export type MediaBlob = {
  name: string
  mime: string
  bytes: Uint8Array
  kind: 'image' | 'file'
}

export type PipelineApi = {
  listProjects: () => Promise<Project[]>
  createProject: (input: { name: string; description?: string }) => Promise<Project>
  updateProject: (id: string, patch: { name?: string; description?: string }) => Promise<Project>
  deleteProject: (id: string) => Promise<void>
  listWorkflows: (projectId: string) => Promise<WorkflowDetails['workflow'][]>
  createWorkflow: (projectId: string, input: { name: string; description?: string }) => Promise<WorkflowDetails>
  createWorkflowFromTemplate: (projectId: string, templateId: 'neurophoto') => Promise<WorkflowDetails>
  getWorkflow: (id: string, version?: number) => Promise<WorkflowDetails>
  saveWorkflow: (
    id: string,
    input: { name: string; description: string; graph: WorkflowGraph }
  ) => Promise<WorkflowDetails>
  getDraft: (id: string) => Promise<WorkflowDraft | null>
  saveDraft: (
    id: string,
    input: { name: string; description: string; graph: WorkflowGraph; selectedId: string | null }
  ) => Promise<void>
  saveDraftNow: (
    id: string,
    input: { name: string; description: string; graph: WorkflowGraph; selectedId: string | null }
  ) => void
  deleteWorkflow: (id: string) => Promise<void>
  listRuns: (projectId: string) => Promise<RunSummary[]>
  deleteRun: (runId: string) => Promise<void>
  createRun: (workflowId: string) => Promise<RunDetails>
  duplicateRun: (runId: string) => Promise<RunDetails>
  resetRun: (runId: string) => Promise<RunDetails>
  getRun: (runId: string) => Promise<RunDetails>
  updateRunInputs: (runId: string, inputs: Record<string, unknown>) => Promise<RunDetails>
  updateRunTitle: (runId: string, title: string) => Promise<RunDetails>
  setRunVersion: (runId: string, versionNumber: number) => Promise<RunDetails>
  startRun: (runId: string, options?: { untilStepId?: string }) => Promise<RunDetails>
  continueRun: (
    runId: string,
    options?: { branchId?: string; untilStepId?: string; startManualBranches?: boolean; note?: string }
  ) => Promise<RunDetails>
  retryStep: (runId: string, stepId: string, branchId: string) => Promise<RunDetails>
  runStep: (
    runId: string,
    stepId: string,
    branchId: string,
    mode: 'only' | 'chain',
    options?: RunStepOptions
  ) => Promise<RunDetails>
  skipStep: (runId: string, stepId: string, branchId: string) => Promise<RunDetails>
  repairStepJson: (runId: string, stepId: string, branchId: string) => Promise<RunDetails>
  acceptManualAnswer: (runId: string, stepId: string, branchId: string, text: string, continueAfter?: boolean) => Promise<RunDetails>
  listVariables: (scope: 'global' | 'project', projectId?: string) => Promise<NamedVariable[]>
  saveVariable: (input: {
    scope: 'global' | 'project'
    projectId?: string
    name: string
    label: string
    value: unknown
    description?: string
  }) => Promise<NamedVariable>
  updateVariable: (input: { id: string; name: string; label: string }) => Promise<NamedVariable>
  addVariableVersion: (input: { id: string; value: unknown; description?: string }) => Promise<NamedVariable>
  updateVariableVersion: (input: { id: string; description: string }) => Promise<NamedVariable>
  deleteVariableVersion: (id: string) => Promise<NamedVariable>
  deleteVariable: (id: string) => Promise<void>
  submitUserAction: (runId: string, executionId: string, payload: UserActionPayload) => Promise<RunDetails>
  cancelRun: (runId: string) => Promise<RunDetails>
  pickFiles: (kind: 'image' | 'file' | 'auto', multiple: boolean) => Promise<StoredFile[]>
  storeMedia: (items: MediaBlob[]) => Promise<StoredFile[]>
  pasteMedia: (accept: 'image' | 'file' | 'any') => Promise<StoredFile[]>
  getProviderStatus: () => Promise<ProviderStatus>
  setProviderKey: (providerId: string, apiKey: string) => Promise<ProviderStatus>
  clearProviderKey: (providerId: string) => Promise<ProviderStatus>
  connectQwen: () => Promise<{ loggedIn: boolean }>
  qwenTokenStatus: () => Promise<{ token: boolean; refreshToken: boolean }>
  setQwenSession: (input: { token?: string; refreshToken?: string }) => Promise<{ token: boolean; refreshToken: boolean }>
  clearQwenSession: () => Promise<{ token: boolean; refreshToken: boolean }>
  quit: () => Promise<void>
  exportData: () => Promise<TransferResult>
  importData: () => Promise<TransferResult>
  onRunUpdated: (callback: (runId: string) => void) => () => void
  onOpenSettings: (callback: () => void) => () => void
  onConfirmQuit: (callback: () => void) => () => void
  onExportData: (callback: () => void) => () => void
  onConfirmImport: (callback: () => void) => () => void
}

export type TransferResult =
  | { canceled: true }
  | { canceled: false; projects: number; workflows: number; runs: number; filePath: string }
