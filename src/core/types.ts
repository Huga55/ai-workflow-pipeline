export type ArtifactKind =
  | 'text'
  | 'json'
  | 'number'
  | 'boolean'
  | 'image'
  | 'file'
  | 'array'
  | 'object'

export type InputType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'image'
  | 'image[]'
  | 'file'
  | 'file[]'
  | 'json'
  | 'json[]'
  | 'select'
  | 'multi-select'

export type StepType = 'input' | 'ai' | 'transform' | 'parse' | 'manual' | 'merge'

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'waiting_for_user'
  | 'skipped'
  | 'cancelled'

export type RunStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type BranchStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type StoredFile = {
  kind: 'image' | 'file'
  path: string
  mime: string
  name: string
}

export type InputDefinition = {
  id: string
  name: string
  label: string
  type: InputType
  required: boolean
  description: string
  defaultValue?: unknown
  options?: string[]
}

export type AIMessageDraft = {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type IterateConfig = {
  over: string
  alias: string
  launch: 'all' | 'manual'
}

export type AIStepConfig = {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  messages: AIMessageDraft[]
  outputFormat: 'text' | 'json'
  jsonSchema?: unknown
}

export type TransformStepConfig = {
  mode: 'template' | 'extract' | 'filter' | 'script'
  source?: string
  template?: string
  field?: string
  op?: 'eq' | 'neq' | 'contains' | 'truthy'
  value?: string
  script?: string
}

export type ParseStepConfig = {
  source: string
  mode: 'json' | 'regex' | 'delimiter'
  pattern?: string
  delimiter?: string
}

export type ManualMode =
  | 'select_one'
  | 'select_many'
  | 'text'
  | 'confirm'
  | 'edit_json'
  | 'upload_file'
  | 'upload_image'

export type ManualStepConfig = {
  mode: ManualMode
  source?: string
  labelField?: string
  descriptionField?: string
  prompt: string
  allowEmpty?: boolean
  skipStepIds?: string[]
}

export type MergeStepConfig =
  | {
      mode: 'object'
      sources: { key: string; ref: string }[]
    }
  | {
      mode: 'collect'
      fromFanoutStepId: string
      fromStepId: string
    }

export type InputStepConfig = {
  keys: string[]
}

export type StepConfig =
  | AIStepConfig
  | TransformStepConfig
  | ParseStepConfig
  | ManualStepConfig
  | MergeStepConfig
  | InputStepConfig

type StepBase = {
  id: string
  key: string
  name: string
  description: string
  order: number
  dependsOn: string[]
  stopAfter: boolean
  iterate: IterateConfig | null
}

export type StepDefinition = StepBase &
  (
    | { type: 'ai'; config: AIStepConfig }
    | { type: 'transform'; config: TransformStepConfig }
    | { type: 'parse'; config: ParseStepConfig }
    | { type: 'manual'; config: ManualStepConfig }
    | { type: 'merge'; config: MergeStepConfig }
    | { type: 'input'; config: InputStepConfig }
  )

export type WorkflowGraph = {
  inputs: InputDefinition[]
  steps: StepDefinition[]
}

export type Project = {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export type Workflow = {
  id: string
  projectId: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  latestVersion: number
}

export type WorkflowVersion = {
  id: string
  workflowId: string
  version: number
  graph: WorkflowGraph
  createdAt: string
}

export type WorkflowDetails = {
  workflow: Workflow
  version: WorkflowVersion
  versions: { id: string; version: number; createdAt: string }[]
}

export type WorkflowDraft = {
  name: string
  description: string
  graph: WorkflowGraph
  selectedId: string | null
  updatedAt: string
}

export type Run = {
  id: string
  projectId: string
  workflowId: string
  workflowVersionId: string
  number: number
  title: string
  status: RunStatus
  inputs: Record<string, unknown>
  error: string | null
  createdAt: string
  updatedAt: string
}

export type RunSummary = {
  id: string
  projectId: string
  workflowId: string
  workflowName: string
  versionNumber: number
  number: number
  title: string
  status: RunStatus
  createdAt: string
  updatedAt: string
}

export type Branch = {
  id: string
  runId: string
  parentBranchId: string
  sourceStepId: string
  itemIndex: number
  alias: string
  label: string
  item: unknown
  status: BranchStatus
}

export type ManualOption = {
  id: string
  label: string
  description?: string
  value: unknown
}

export type ManualWaiting = {
  mode: ManualMode
  prompt: string
  options?: ManualOption[]
  value?: unknown
  allowEmpty?: boolean
  skipStepIds?: string[]
}

export type ExecutionMeta = {
  fanoutError?: boolean
  fanoutResolved?: boolean
  waiting?: ManualWaiting
  providerResponse?: unknown
  usage?: unknown
  model?: string
  provider?: string
}

export type StepOutcome = {
  status: 'completed' | 'failed' | 'waiting_for_user'
  output?: unknown
  error?: string
  request?: unknown
  rawResponse?: string | null
  parsed?: unknown
  meta?: ExecutionMeta
}

export type StepExecution = {
  id: string
  runId: string
  stepId: string
  branchId: string
  attempt: number
  status: ExecutionStatus
  request: unknown
  rawResponse: string | null
  parsed: unknown
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  meta: ExecutionMeta
  createdAt: string
}

export type Artifact = {
  id: string
  runId: string
  stepExecutionId: string
  name: string
  kind: ArtifactKind
  value: unknown
  createdAt: string
}

export type UserAction = {
  id: string
  runId: string
  stepExecutionId: string
  actionType: string
  payload: unknown
  createdAt: string
}

export type RunDetails = {
  run: Run
  graph: WorkflowGraph
  versionNumber: number
  workflowName: string
  branches: Branch[]
  executions: StepExecution[]
  artifacts: Artifact[]
}

export type UserActionPayload =
  | { type: 'select_one'; optionId: string }
  | { type: 'select_many'; optionIds: string[] }
  | { type: 'text'; text: string }
  | { type: 'confirm'; accepted: boolean }
  | { type: 'skip' }
  | { type: 'edit_json'; value: unknown }
  | { type: 'upload'; file: StoredFile }

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; mime: string; name: string }

export type AIRequest = {
  provider: string
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: ContentPart[] }[]
  temperature?: number
  maxTokens?: number
  outputFormat: 'text' | 'json'
  jsonSchema?: unknown
}

export type AIResponse = {
  raw: string
  providerResponse: unknown
  model: string
  provider: string
  usage?: unknown
}

export interface AIProvider {
  readonly id: string
  generate(request: AIRequest, signal?: AbortSignal): Promise<AIResponse>
}

export type ProviderInfo = {
  id: string
  label: string
  implemented: boolean
  models: string[]
}

export type ProviderStatus = {
  providers: (ProviderInfo & { connected: boolean })[]
}

export type AdvanceResult = 'completed' | 'paused' | 'failed' | 'cancelled'

export type NamedVariable = {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  name: string
  label: string
  value: unknown
  updatedAt: string
}

export type VariableContext = {
  inputs: Record<string, unknown>
  steps: Record<string, { output: unknown }>
  current_item?: unknown
  current_index?: number
  aliases: Record<string, unknown>
  globals?: Record<string, unknown>
  project?: Record<string, unknown>
}
