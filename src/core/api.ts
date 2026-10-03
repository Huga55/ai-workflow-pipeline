import type {
  Project,
  ProviderStatus,
  NamedVariable,
  RunDetails,
  RunSummary,
  StoredFile,
  UserActionPayload,
  WorkflowDetails,
  WorkflowDraft,
  WorkflowGraph
} from '@core/types'

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
  getRun: (runId: string) => Promise<RunDetails>
  updateRunInputs: (runId: string, inputs: Record<string, unknown>) => Promise<RunDetails>
  updateRunTitle: (runId: string, title: string) => Promise<RunDetails>
  startRun: (runId: string, options?: { untilStepId?: string }) => Promise<RunDetails>
  continueRun: (
    runId: string,
    options?: { branchId?: string; untilStepId?: string; startManualBranches?: boolean }
  ) => Promise<RunDetails>
  retryStep: (runId: string, stepId: string, branchId: string) => Promise<RunDetails>
  runStep: (runId: string, stepId: string, branchId: string, mode: 'only' | 'chain') => Promise<RunDetails>
  skipStep: (runId: string, stepId: string, branchId: string) => Promise<RunDetails>
  listVariables: (scope: 'global' | 'project', projectId?: string) => Promise<NamedVariable[]>
  saveVariable: (input: {
    scope: 'global' | 'project'
    projectId?: string
    name: string
    label: string
    value: unknown
  }) => Promise<NamedVariable>
  deleteVariable: (id: string) => Promise<void>
  submitUserAction: (runId: string, executionId: string, payload: UserActionPayload) => Promise<RunDetails>
  cancelRun: (runId: string) => Promise<RunDetails>
  pickFiles: (kind: 'image' | 'file', multiple: boolean) => Promise<StoredFile[]>
  getProviderStatus: () => Promise<ProviderStatus>
  setProviderKey: (providerId: string, apiKey: string) => Promise<ProviderStatus>
  clearProviderKey: (providerId: string) => Promise<ProviderStatus>
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
