import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { attachPaths, BUNDLE_FORMAT, BUNDLE_VERSION, detachPaths, parseBundle, type Bundle } from '@core/bundle'
import { createId, nowIso } from '@core/ids'
import { normalizeInputs, validateInputs } from '@core/inputs'
import { stableStringify } from '@core/json'
import { formatRunNumber } from '@core/labels'
import { validateGraph } from '@core/graph'
import { settleRunStatus, WorkflowEngine } from '@core/engine'
import { createRunners } from '@core/runners'
import { createNeurophotoGraph } from '@core/template'
import type { AIRequest, AIResponse, NamedVariable, Project, ProviderStatus, RunDetails, StoredFile, UserActionPayload, WorkflowDetails, WorkflowDraft, WorkflowGraph } from '@core/types'
import { AppDatabase, SqliteEngineStore } from './db'
import { createProvider, PROVIDERS } from './providers'
import { SecretStore } from './secrets'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown'
}

export class AppService {
  private engine: WorkflowEngine
  private active = new Map<string, AbortController>()

  constructor(
    private database: AppDatabase,
    private secrets: SecretStore,
    private mediaDir: string,
    private onRunUpdated: (runId: string) => void
  ) {
    const store = new SqliteEngineStore(database)
    this.engine = new WorkflowEngine(
      store,
      createRunners({
        generate: (request, signal) => this.generate(request, signal)
      })
    )
  }

  listProjects(): Project[] {
    return this.database.listProjects()
  }

  exportBundle(filePath: string): { projects: number; workflows: number; runs: number } {
    const snapshot = this.database.readBundle()
    const files = new Map<string, { id: string; name: string; mime: string }>()
    const detach = <T>(value: T): T => detachPaths(value, files) as T
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: nowIso(),
      projects: snapshot.projects.map((project) => ({ ...project, settings: detach(project.settings) })),
      workflows: snapshot.workflows,
      versions: snapshot.versions.map((version) => ({ ...version, graph: detach(version.graph) })),
      drafts: snapshot.drafts.map((draft) => ({ ...draft, graph: detach(draft.graph) })),
      runs: snapshot.runs.map((run) => ({ ...run, inputs: detach(run.inputs) })),
      branches: snapshot.branches.map((branch) => ({ ...branch, item: detach(branch.item) })),
      executions: snapshot.executions.map((execution) => ({
        ...execution,
        request: detach(execution.request),
        parsed: detach(execution.parsed),
        meta: detach(execution.meta)
      })),
      artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact, value: detach(artifact.value) })),
      actions: snapshot.actions.map((action) => ({ ...action, payload: detach(action.payload) })),
      variables: snapshot.variables.map((variable) => ({ ...variable, value: detach(variable.value) })),
      secrets: this.secrets.entries(),
      media: []
    }
    for (const [filePathOnDisk, file] of files) {
      if (!existsSync(filePathOnDisk)) continue
      bundle.media.push({
        id: file.id,
        name: file.name,
        mime: file.mime,
        data: readFileSync(filePathOnDisk).toString('base64')
      })
    }
    writeFileSync(filePath, JSON.stringify(bundle), 'utf8')
    return { projects: bundle.projects.length, workflows: bundle.workflows.length, runs: bundle.runs.length }
  }

  importBundle(filePath: string): { projects: number; workflows: number; runs: number } {
    if (this.active.size) throw new Error('Дождитесь окончания текущего запуска и повторите импорт')
    const bundle = parseBundle(readFileSync(filePath, 'utf8'))
    mkdirSync(this.mediaDir, { recursive: true })
    const paths = new Map<string, string>()
    for (const file of bundle.media) {
      const ext = extensionFor(file.name, file.mime)
      const target = path.join(this.mediaDir, `${file.id}${ext}`)
      writeFileSync(target, Buffer.from(file.data, 'base64'))
      paths.set(file.id, target)
    }
    const attach = <T>(value: T): T => attachPaths(value, paths) as T
    this.database.writeBundle({
      ...bundle,
      projects: bundle.projects.map((project) => ({ ...project, settings: attach(project.settings) })),
      versions: bundle.versions.map((version) => ({ ...version, graph: attach(version.graph) })),
      drafts: bundle.drafts.map((draft) => ({ ...draft, graph: attach(draft.graph) })),
      runs: bundle.runs.map((run) => ({ ...run, inputs: attach(run.inputs) })),
      branches: bundle.branches.map((branch) => ({ ...branch, item: attach(branch.item) })),
      executions: bundle.executions.map((execution) => ({
        ...execution,
        request: attach(execution.request),
        parsed: attach(execution.parsed),
        meta: attach(execution.meta)
      })),
      artifacts: bundle.artifacts.map((artifact) => ({ ...artifact, value: attach(artifact.value) })),
      actions: bundle.actions.map((action) => ({ ...action, payload: attach(action.payload) })),
      variables: bundle.variables.map((variable) => ({ ...variable, value: attach(variable.value) }))
    })
    for (const [providerId, apiKey] of Object.entries(bundle.secrets)) {
      if (apiKey.trim()) this.secrets.set(providerId, apiKey)
    }
    return { projects: bundle.projects.length, workflows: bundle.workflows.length, runs: bundle.runs.length }
  }

  createProject(input: { name: string; description?: string }): Project {
    const timestamp = nowIso()
    return this.database.createProject({
      id: createId(),
      name: input.name.trim() || 'Новый проект',
      description: input.description?.trim() ?? '',
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }

  updateProject(id: string, patch: { name?: string; description?: string }): Project {
    return this.database.updateProject(id, { name: patch.name?.trim(), description: patch.description?.trim() }, nowIso())
  }

  deleteProject(id: string): void {
    this.database.deleteProject(id)
  }

  listWorkflows(projectId: string) {
    return this.database.listWorkflows(projectId)
  }

  createWorkflow(projectId: string, input: { name: string; description?: string }, graph: WorkflowGraph = { inputs: [], steps: [] }): WorkflowDetails {
    this.database.getProject(projectId)
    const timestamp = nowIso()
    const id = createId()
    this.database.insertWorkflow({
      id,
      projectId,
      name: input.name.trim() || 'Новый workflow',
      description: input.description?.trim() ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
      latestVersion: 1
    })
    this.database.insertVersion({
      id: createId(),
      workflowId: id,
      version: 1,
      graph,
      createdAt: timestamp
    })
    this.database.touchProject(projectId, timestamp)
    return this.database.workflowDetails(id)
  }

  createWorkflowFromTemplate(projectId: string, templateId: 'neurophoto'): WorkflowDetails {
    if (templateId !== 'neurophoto') throw new Error('Неизвестный шаблон')
    return this.createWorkflow(
      projectId,
      {
        name: 'Full Product Shoot',
        description: 'Идентификаторы, паспорт, концепции, кадры и структурированный промпт.'
      },
      createNeurophotoGraph()
    )
  }

  getWorkflow(id: string, version?: number): WorkflowDetails {
    return this.database.workflowDetails(id, version)
  }

  saveWorkflow(id: string, input: { name: string; description: string; graph: WorkflowGraph }): WorkflowDetails {
    const timestamp = nowIso()
    const current = this.database.latestVersion(id)
    this.database.updateWorkflowMeta(id, input.name.trim() || 'Без названия', input.description.trim(), timestamp)
    if (stableStringify(current.graph) !== stableStringify(input.graph)) {
      this.database.insertVersion({
        id: createId(),
        workflowId: id,
        version: current.version + 1,
        graph: input.graph,
        createdAt: timestamp
      })
    }
    const workflow = this.database.getWorkflowRow(id)
    this.database.touchProject(workflow.projectId, timestamp)
    this.database.clearDraft(id)
    return this.database.workflowDetails(id)
  }

  getDraft(id: string): WorkflowDraft | null {
    const draft = this.database.getDraft(id)
    if (!draft) return null
    const latest = this.database.latestVersion(id)
    const workflow = this.database.getWorkflowRow(id)
    const same =
      draft.name === workflow.name &&
      draft.description === workflow.description &&
      stableStringify(draft.graph) === stableStringify(latest.graph)
    if (same) {
      this.database.clearDraft(id)
      return null
    }
    return draft
  }

  saveDraft(id: string, input: { name: string; description: string; graph: WorkflowGraph; selectedId: string | null }): void {
    this.database.saveDraft(id, { ...input, updatedAt: nowIso() })
  }

  deleteWorkflow(id: string): void {
    const workflow = this.database.getWorkflowRow(id)
    this.database.deleteWorkflow(id)
    this.database.touchProject(workflow.projectId, nowIso())
  }

  listRuns(projectId: string) {
    return this.database.listRuns(projectId)
  }

  deleteRun(runId: string): void {
    if (this.active.has(runId)) throw new Error('Этот запуск сейчас выполняется. Сначала остановите его.')
    this.database.deleteRun(runId)
  }

  createRun(workflowId: string): RunDetails {
    const details = this.database.workflowDetails(workflowId)
    const timestamp = nowIso()
    const number = this.database.nextRunNumber(details.workflow.projectId)
    const id = createId()
    this.database.insertRun({
      id,
      projectId: details.workflow.projectId,
      workflowId,
      workflowVersionId: details.version.id,
      number,
      title: formatRunNumber(number),
      status: 'draft',
      inputs: normalizeInputs(details.version.graph, {}),
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    this.database.touchProject(details.workflow.projectId, timestamp)
    return this.database.getRun(id)
  }

  duplicateRun(runId: string): RunDetails {
    const existing = this.database.getRun(runId)
    const latest = this.database.latestVersion(existing.run.workflowId)
    const timestamp = nowIso()
    const number = this.database.nextRunNumber(existing.run.projectId)
    const id = createId()
    this.database.insertRun({
      id,
      projectId: existing.run.projectId,
      workflowId: existing.run.workflowId,
      workflowVersionId: latest.id,
      number,
      title: formatRunNumber(number),
      status: 'draft',
      inputs: normalizeInputs(latest.graph, existing.run.inputs),
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    return this.database.getRun(id)
  }

  getRun(runId: string): RunDetails {
    return this.database.getRun(runId)
  }

  updateRunInputs(runId: string, inputs: Record<string, unknown>): RunDetails {
    const details = this.database.getRun(runId)
    if (details.executions.length) throw new Error('Входы нельзя менять после старта запуска')
    this.database.updateRunInputs(runId, normalizeInputs(details.graph, inputs), nowIso())
    return this.database.getRun(runId)
  }

  updateRunTitle(runId: string, title: string): RunDetails {
    this.database.updateRunTitle(runId, title.trim() || 'Запуск', nowIso())
    return this.database.getRun(runId)
  }

  listVariables(scope: 'global' | 'project', projectId?: string): NamedVariable[] {
    return this.database.listVariables(scope, scope === 'project' ? projectId || null : null)
  }

  saveVariable(input: { scope: 'global' | 'project'; projectId?: string; name: string; label: string; value: unknown }): NamedVariable {
    const name = input.name.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error('Имя переменной: латиница, цифры и _, начинается с буквы')
    }
    const projectId = input.scope === 'project' ? input.projectId || null : null
    if (input.scope === 'project' && !projectId) throw new Error('Не указан проект')
    const variable: NamedVariable = {
      id: createId(),
      scope: input.scope,
      projectId,
      name,
      label: input.label.trim() || name,
      value: input.value,
      updatedAt: nowIso()
    }
    this.database.saveVariable(variable)
    return this.database.listVariables(input.scope, projectId).find((item) => item.name === name) ?? variable
  }

  deleteVariable(id: string): void {
    this.database.deleteVariable(id)
  }

  async startRun(runId: string, options?: { untilStepId?: string }): Promise<RunDetails> {
    const details = this.guardRunnable(runId)
    const inputErrors = validateInputs(details.graph, details.run.inputs)
    if (inputErrors.length) throw new Error(inputErrors.join('\n'))
    return this.advance(runId, { untilStepId: options?.untilStepId })
  }

  async continueRun(
    runId: string,
    options?: { branchId?: string; untilStepId?: string; startManualBranches?: boolean }
  ): Promise<RunDetails> {
    this.guardRunnable(runId)
    return this.advance(runId, options ?? {})
  }

  async retryStep(runId: string, stepId: string, branchId: string): Promise<RunDetails> {
    this.guardRunnable(runId)
    return this.advance(runId, { retry: { stepId, branchId } })
  }

  async runStep(runId: string, stepId: string, branchId: string, mode: 'only' | 'chain'): Promise<RunDetails> {
    this.guardRunnable(runId)
    return this.advance(runId, { focus: { stepId, branchId, mode } })
  }

  async skipStep(runId: string, stepId: string, branchId: string): Promise<RunDetails> {
    this.guardRunnable(runId)
    return this.withLock(runId, (signal) => this.engine.skipStep(this.baseOptions(runId, signal), stepId, branchId))
  }

  async submitUserAction(runId: string, executionId: string, payload: UserActionPayload): Promise<RunDetails> {
    const details = this.guardRunnable(runId)
    const execution = details.executions.find((item) => item.id === executionId)
    if (!execution || execution.status !== 'waiting_for_user') throw new Error('Этот шаг не ждёт действия')
    return this.withLock(runId, async (signal) => {
      const base = this.baseOptions(runId, signal)
      return this.engine.submitUserAction({ ...base, onlyBranchId: execution.branchId || undefined }, executionId, payload)
    })
  }

  async cancelRun(runId: string): Promise<RunDetails> {
    const controller = this.active.get(runId)
    if (controller) {
      controller.abort()
      return this.database.getRun(runId)
    }
    this.database.updateRunStatus(runId, 'cancelled', null, nowIso())
    return this.database.getRun(runId)
  }

  storePickedFiles(filePaths: string[], kind: 'image' | 'file'): StoredFile[] {
    mkdirSync(this.mediaDir, { recursive: true })
    return filePaths.map((filePath) => {
      const ext = path.extname(filePath).toLowerCase()
      const name = path.basename(filePath)
      const stored = path.join(this.mediaDir, `${createId()}${ext}`)
      copyFileSync(filePath, stored)
      return {
        kind,
        path: stored,
        mime: MIME[ext] || (kind === 'image' ? 'image/png' : 'application/octet-stream'),
        name
      }
    })
  }

  getProviderStatus(): ProviderStatus {
    return {
      providers: PROVIDERS.map((provider) => ({
        ...provider,
        connected: provider.implemented && this.secrets.has(provider.id)
      }))
    }
  }

  setProviderKey(providerId: string, apiKey: string): ProviderStatus {
    const provider = PROVIDERS.find((item) => item.id === providerId)
    if (!provider?.implemented) throw new Error('Этот провайдер пока нельзя подключить')
    if (!apiKey.trim()) throw new Error('Введите API-ключ')
    this.secrets.set(providerId, apiKey)
    return this.getProviderStatus()
  }

  clearProviderKey(providerId: string): ProviderStatus {
    this.secrets.clear(providerId)
    return this.getProviderStatus()
  }

  private async generate(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const apiKey = this.secrets.get(request.provider)
    if (!apiKey) throw new Error(`Нет API-ключа для провайдера «${request.provider}». Добавьте его в настройках.`)
    return createProvider(request.provider, apiKey).generate(request, signal)
  }

  private guardRunnable(runId: string): RunDetails {
    if (this.active.has(runId)) throw new Error('Этот запуск уже выполняется')
    const details = this.database.getRun(runId)
    const errors = validateGraph(details.graph)
    if (errors.length) throw new Error(errors.join('\n'))
    if (details.run.status === 'cancelled') throw new Error('Запуск отменён')
    return details
  }

  private advance(
    runId: string,
    options: {
      untilStepId?: string
      branchId?: string
      startManualBranches?: boolean
      retry?: { stepId: string; branchId: string }
      focus?: { stepId: string; branchId: string; mode: 'only' | 'chain' }
    }
  ): Promise<RunDetails> {
    return this.withLock(runId, (signal) =>
      this.engine.advance({
        ...this.baseOptions(runId, signal),
        untilStepId: options.untilStepId,
        onlyBranchId: options.branchId,
        startManualBranches: options.startManualBranches,
        retry: options.retry,
        focus: options.focus
      })
    )
  }

  private async withLock(runId: string, work: (signal: AbortSignal) => Promise<'completed' | 'paused' | 'failed' | 'cancelled'>): Promise<RunDetails> {
    const controller = new AbortController()
    this.active.set(runId, controller)
    this.database.updateRunStatus(runId, 'running', null, nowIso())
    this.onRunUpdated(runId)
    try {
      const result = await work(controller.signal)
      const details = this.database.getRun(runId)
      const status = controller.signal.aborted ? 'cancelled' : settleRunStatus(result, new SqliteEngineStore(this.database), runId, details.graph)
      const error = status === 'failed' ? this.latestError(details) : null
      this.database.updateRunStatus(runId, status, error, nowIso())
      return this.database.getRun(runId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка выполнения'
      if (controller.signal.aborted) this.database.updateRunStatus(runId, 'cancelled', null, nowIso())
      else this.database.updateRunStatus(runId, 'failed', message, nowIso())
      throw error
    } finally {
      this.active.delete(runId)
      this.onRunUpdated(runId)
    }
  }

  private baseOptions(runId: string, signal: AbortSignal) {
    const details = this.database.getRun(runId)
    return {
      runId,
      graph: details.graph,
      inputs: details.run.inputs,
      globals: this.variableMap('global', null),
      project: this.variableMap('project', details.run.projectId),
      signal,
      onProgress: () => this.onRunUpdated(runId)
    }
  }

  private variableMap(scope: 'global' | 'project', projectId: string | null): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const item of this.database.listVariables(scope, projectId)) values[item.name] = item.value
    return values
  }

  private latestError(details: RunDetails): string | null {
    const failed = [...details.executions].reverse().find((item) => item.status === 'failed' && item.error)
    return failed?.error ?? 'Выполнение остановилось из-за ошибки'
  }
}

function extensionFor(name: string, mime: string): string {
  const ext = path.extname(name).toLowerCase()
  if (ext && ext.length <= 8) return ext
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'application/pdf') return '.pdf'
  return ''
}
