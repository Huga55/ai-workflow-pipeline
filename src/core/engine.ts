import { inferKind } from '@core/labels'
import { branchLabel } from '@core/labels'
import { chainStepIds, fanoutInnerSteps, hiddenDescendantIds, isCollectMerge, topoSort } from '@core/graph'
import { createId, nowIso } from '@core/ids'
import { applyManualAction } from '@core/manual'
import { createRunners, type StepRunner } from '@core/runners'
import type { EngineStore } from '@core/store'
import type {
  AdvanceResult,
  Artifact,
  Branch,
  BranchStatus,
  ExecutionMeta,
  StepDefinition,
  StepExecution,
  StepOutcome,
  UserActionPayload,
  VariableContext,
  WorkflowGraph
} from '@core/types'
import { previousStep, resolveReference } from '@core/variables'

export type AdvanceOptions = {
  runId: string
  graph: WorkflowGraph
  inputs: Record<string, unknown>
  globals?: Record<string, unknown>
  project?: Record<string, unknown>
  untilStepId?: string
  onlyBranchId?: string
  startManualBranches?: boolean
  retry?: { stepId: string; branchId: string }
  focus?: { stepId: string; branchId: string; mode: 'only' | 'chain' }
  allowStepIds?: Set<string>
  forceStepIds?: Set<string>
  branchNote?: string
  appendBatch?: boolean
  signal?: AbortSignal
  onProgress?: () => void
}

type Scope = {
  runId: string
  branchId: string
  parent: Scope | null
  entryStepId: string | null
  alias: string | null
  item: unknown
  index: number | null
  note: string
  noteAlias: string
}

export class WorkflowEngine {
  private store: EngineStore
  private runners: Record<StepDefinition['type'], StepRunner>

  constructor(store: EngineStore, runners?: Record<StepDefinition['type'], StepRunner>) {
    this.store = store
    this.runners = runners ?? createRunners()
  }

  async advance(options: AdvanceOptions): Promise<AdvanceResult> {
    this.sweepInterrupted(options.runId)
    if (options.retry) return this.runSingle(options, options.retry.stepId, options.retry.branchId)
    if (options.focus?.mode === 'only') return this.runSingle(options, options.focus.stepId, options.focus.branchId)
    if (options.focus?.mode === 'chain') {
      const allow = chainStepIds(options.focus.stepId, options.graph.steps)
      return this.advanceScope(this.rootScope(options.runId), options.graph.steps, {
        ...options,
        allowStepIds: allow,
        forceStepIds: allow,
        onlyBranchId: options.focus.branchId || undefined
      })
    }
    return this.advanceScope(this.rootScope(options.runId), options.graph.steps, options)
  }

  async submitUserAction(
    options: AdvanceOptions,
    executionId: string,
    payload: UserActionPayload
  ): Promise<AdvanceResult> {
    const execution = this.store.listExecutions(options.runId).find((item) => item.id === executionId)
    if (!execution) return 'failed'
    if (execution.status !== 'waiting_for_user' || !execution.meta.waiting) return 'failed'
    const applied = applyManualAction(execution.meta.waiting, payload)
    if (!applied.ok) {
      execution.error = applied.error
      this.store.updateExecution(execution)
      options.onProgress?.()
      return 'paused'
    }
    const finished = nowIso()
    execution.status = applied.skipped ? 'skipped' : 'completed'
    execution.parsed = applied.output
    execution.error = null
    execution.finishedAt = finished
    execution.durationMs = execution.startedAt ? Date.parse(finished) - Date.parse(execution.startedAt) : 0
    this.store.updateExecution(execution)
    this.store.insertArtifact(this.artifact(options.runId, execution.id, applied.output ?? null))
    this.store.insertUserAction({
      id: createId(),
      runId: options.runId,
      stepExecutionId: execution.id,
      actionType: payload.type,
      payload,
      createdAt: finished
    })
    if (applied.skipped) {
      for (const stepId of execution.meta.waiting?.skipStepIds ?? []) {
        if (!options.graph.steps.some((step) => step.id === stepId)) continue
        this.markSkipped(options, stepId, execution.branchId, applied.output)
      }
    }
    this.refreshBranchStatus(options.runId, execution.branchId)
    options.onProgress?.()
    if (applied.stopBranch) {
      this.setBranchStatus(options.runId, execution.branchId, 'cancelled')
      return 'paused'
    }
    return this.advance({
      ...options,
      retry: undefined,
      onlyBranchId: execution.branchId || undefined
    })
  }

  async skipStep(options: AdvanceOptions, stepId: string, branchId: string): Promise<AdvanceResult> {
    const step = options.graph.steps.find((item) => item.id === stepId)
    if (!step) return 'failed'
    const existing = this.effectiveExecution(options.runId, stepId, branchId)
    if (existing?.status === 'running') return 'paused'
    if (existing?.status === 'completed') return 'paused'
    this.markSkipped(options, stepId, branchId, null)
    options.onProgress?.()
    return this.advance({
      ...options,
      retry: undefined,
      focus: undefined,
      onlyBranchId: branchId || undefined
    })
  }

  private markSkipped(options: AdvanceOptions, stepId: string, branchId: string, output: unknown): void {
    const existing = this.effectiveExecution(options.runId, stepId, branchId)
    if (existing && (existing.status === 'completed' || existing.status === 'skipped' || existing.status === 'running')) return
    if (existing?.status === 'waiting_for_user') {
      existing.status = 'skipped'
      existing.parsed = output ?? existing.parsed
      existing.finishedAt = nowIso()
      existing.error = null
      this.store.updateExecution(existing)
      this.store.insertArtifact(this.artifact(options.runId, existing.id, output ?? null))
      return
    }
    const started = nowIso()
    const execution: StepExecution = {
      id: createId(),
      runId: options.runId,
      stepId,
      branchId,
      attempt: (existing?.attempt ?? 0) + 1,
      status: 'skipped',
      request: null,
      rawResponse: null,
      parsed: output ?? null,
      error: null,
      startedAt: started,
      finishedAt: started,
      durationMs: 0,
      meta: {},
      createdAt: started
    }
    this.store.insertExecution(execution)
    this.store.insertArtifact(this.artifact(options.runId, execution.id, output ?? null))
  }

  private async runSingle(options: AdvanceOptions, stepId: string, branchId: string): Promise<AdvanceResult> {
    const step = options.graph.steps.find((item) => item.id === stepId)
    if (!step) return 'failed'
    const limited: AdvanceOptions = {
      ...options,
      allowStepIds: new Set([stepId]),
      forceStepIds: new Set([stepId])
    }
    const scope = this.scopeForBranch(options.runId, branchId, null)
    if (step.iterate && step.id !== scope.entryStepId) {
      return this.runFanout(step, options.graph.steps, scope, limited, true)
    }
    return this.executeStep(step, scope, limited, true)
  }

  private rootScope(runId: string): Scope {
    return {
      runId,
      branchId: '',
      parent: null,
      entryStepId: null,
      alias: null,
      item: undefined,
      index: null,
      note: '',
      noteAlias: ''
    }
  }

  private async advanceScope(scope: Scope, steps: StepDefinition[], options: AdvanceOptions): Promise<AdvanceResult> {
    if (options.signal?.aborted) return 'paused'
    const hidden = hiddenDescendantIds(steps, scope.entryStepId)
    const local = steps.filter((step) => !hidden.has(step.id))
    const sorted = topoSort(local)
    if (!sorted.ok) return this.failScope(scope, options, sorted.message)

    for (const step of sorted.steps) {
      if (options.signal?.aborted) return 'paused'
      if (options.allowStepIds && !this.stepAllowed(step, steps, options.allowStepIds)) continue
      if (step.iterate && step.id !== scope.entryStepId) {
        const fanout = await this.runFanout(step, steps, scope, options, false)
        if (fanout !== 'completed') return fanout
        continue
      }
      const force = Boolean(options.forceStepIds?.has(step.id))
      const existing = this.effectiveExecution(options.runId, step.id, scope.branchId)
      if (!force && (existing?.status === 'completed' || existing?.status === 'skipped')) continue
      if (!force && existing?.status === 'waiting_for_user') {
        this.setBranchStatus(options.runId, scope.branchId, 'waiting_for_user')
        return 'paused'
      }
      if (!force && existing?.status === 'failed' && !existing.meta.interrupted) return 'failed'
      if (!force && existing?.status === 'cancelled') return 'paused'
      if (existing?.status === 'running') return 'paused'

      if (isCollectMerge(step)) {
        const fanoutId = step.type === 'merge' && step.config.mode === 'collect' ? step.config.fromFanoutStepId : ''
        const children = this.childBranches(options.runId, scope.branchId, fanoutId)
        if (children.some((branch) => branch.status !== 'completed')) return 'paused'
      }

      const result = await this.executeStep(step, scope, options, force)
      if (result !== 'completed') return result
      if (options.untilStepId === step.id || step.stopAfter) return 'paused'
    }
    return 'completed'
  }

  private async runFanout(
    step: StepDefinition,
    allSteps: StepDefinition[],
    scope: Scope,
    options: AdvanceOptions,
    force: boolean
  ): Promise<AdvanceResult> {
    if (!step.iterate) return 'failed'
    const refresh = Boolean(options.forceStepIds?.has(step.id))
    let branches = this.childBranches(options.runId, scope.branchId, step.id)
    let preserved = new Set<string>()
    const errorExecution = this.effectiveExecution(options.runId, step.id, scope.branchId)
    if (!branches.length && errorExecution?.meta.fanoutError && errorExecution.status === 'failed' && !force && !refresh) {
      return 'failed'
    }
    if (!branches.length || refresh) {
      const resolved = resolveReference(step.iterate.over, this.buildContext(scope, options, step))
      if (!resolved.ok || !Array.isArray(resolved.value)) {
        await this.writeFanoutError(
          step,
          scope,
          options,
          resolved.ok ? 'Для ветвления нужен массив' : resolved.error
        )
        return 'failed'
      }
      if (!branches.length) {
        branches = resolved.value.map((item, index) => this.makeBranch(scope, step, options.runId, item, index, 0))
      } else {
        const active = branches
          .filter((branch) => branch.status !== 'cancelled')
          .sort((a, b) => a.itemIndex - b.itemIndex)
        if (options.appendBatch || active.length !== resolved.value.length) {
          preserved = new Set(branches.map((branch) => branch.id))
          const nextIndex = branches.reduce((max, branch) => Math.max(max, branch.itemIndex), -1) + 1
          const nextBatch = branches.reduce((max, branch) => Math.max(max, branch.batch ?? 0), -1) + 1
          resolved.value.forEach((item, index) => {
            branches.push(this.makeBranch(scope, step, options.runId, item, nextIndex + index, nextBatch))
          })
        } else {
          resolved.value.forEach((item, index) => {
            const existing = active[index]
            existing.item = item
            existing.label = branchLabel(item, existing.itemIndex)
            existing.alias = step.iterate?.alias || existing.alias
            existing.noteAlias = step.iterate?.noteAlias?.trim() ?? ''
            existing.status = 'pending'
            this.store.updateBranch(existing)
          })
        }
        branches = this.childBranches(options.runId, scope.branchId, step.id)
      }
      options.onProgress?.()
    }

    const inner = [step, ...fanoutInnerSteps(step.id, allSteps)]
    const jobs: { fresh: Branch; child: Scope; branchOptions: AdvanceOptions }[] = []
    for (const branch of branches) {
      if (options.signal?.aborted) return 'paused'
      const fresh = this.store.listBranches(options.runId).find((item) => item.id === branch.id) ?? branch
      if (fresh.status === 'cancelled') continue
      const keep = preserved.has(fresh.id)
      const forceInner = !keep && inner.some((item) => options.forceStepIds?.has(item.id))
      if (fresh.status === 'completed' && !forceInner) continue
      const selected = this.shouldRunBranch(fresh.id, options.onlyBranchId, options.runId)
      if (!selected) continue
      if (step.iterate.launch === 'manual' && fresh.status === 'pending') {
        const exact = options.onlyBranchId === fresh.id
        if (!exact && !options.startManualBranches) continue
      }
      if (options.onlyBranchId === fresh.id && options.branchNote !== undefined) fresh.note = options.branchNote
      const child = this.childScope(scope, fresh, step.id)
      const redo = !keep && fresh.status === 'pending' && inner.some((item) => Boolean(this.effectiveExecution(options.runId, item.id, fresh.id)))
      const branchOptions = keep
        ? { ...options, forceStepIds: new Set([...(options.forceStepIds ?? [])].filter((id) => !inner.some((item) => item.id === id))) }
        : redo
          ? { ...options, forceStepIds: new Set([...(options.forceStepIds ?? []), ...inner.map((item) => item.id)]) }
          : options
      jobs.push({ fresh, child, branchOptions })
    }

    const finish = async (job: (typeof jobs)[number]) => {
      job.fresh.status = 'running'
      this.store.updateBranch(job.fresh)
      const result = await this.advanceScope(job.child, inner, job.branchOptions)
      if (options.signal?.aborted) {
        if (result === 'completed') this.setBranchStatus(options.runId, job.fresh.id, 'completed')
        else this.keepBranchAfterStop(options.runId, job.fresh.id)
        return result === 'completed' ? 'completed' : 'paused'
      }
      if (result === 'completed') this.setBranchStatus(options.runId, job.fresh.id, 'completed')
      else if (result === 'failed') this.setBranchStatus(options.runId, job.fresh.id, 'failed')
      else if (result === 'cancelled') this.setBranchStatus(options.runId, job.fresh.id, 'cancelled')
      else this.refreshBranchStatus(options.runId, job.fresh.id)
      return result
    }
    if (step.iterate.launch === 'all') {
      for (const job of jobs) {
        job.fresh.status = 'running'
        this.store.updateBranch(job.fresh)
      }
      if (jobs.length) options.onProgress?.()
      const results = await Promise.all(jobs.map((job) => finish(job)))
      if (options.signal?.aborted) return 'paused'
      if (results.includes('cancelled')) return 'cancelled'
    } else {
      for (const job of jobs) {
        const result = await finish(job)
        if (options.signal?.aborted) return 'paused'
        if (result === 'cancelled') return 'cancelled'
      }
    }

    const after = this.childBranches(options.runId, scope.branchId, step.id)
    if (after.length === 0) return 'completed'
    if (after.every((branch) => branch.status === 'completed')) return 'completed'
    if (after.some((branch) => branch.status === 'failed') && after.every((branch) => branch.status === 'failed')) {
      return 'failed'
    }
    return 'paused'
  }

  private async executeStep(step: StepDefinition, scope: Scope, options: AdvanceOptions, force: boolean): Promise<AdvanceResult> {
    const existing = this.effectiveExecution(options.runId, step.id, scope.branchId)
    if (!force && existing) {
      if (existing.status === 'completed' || existing.status === 'skipped') return 'completed'
      if (existing.status === 'waiting_for_user') return 'paused'
      if (existing.status === 'failed' && !existing.meta.interrupted) return 'failed'
      if (existing.status === 'cancelled') return 'paused'
      if (existing.status === 'running') return 'paused'
    }
    if (force && existing?.status === 'running') return 'paused'

    const started = nowIso()
    const execution: StepExecution = {
      id: createId(),
      runId: options.runId,
      stepId: step.id,
      branchId: scope.branchId,
      attempt: (existing?.attempt ?? 0) + 1,
      status: 'running',
      request: null,
      rawResponse: null,
      parsed: null,
      error: null,
      startedAt: started,
      finishedAt: null,
      durationMs: null,
      meta: {},
      createdAt: started
    }
    this.store.insertExecution(execution)
    options.onProgress?.()

    let outcome: StepOutcome
    try {
      outcome = await this.runners[step.type]({
        step,
        ctx: this.buildContext(scope, options, step),
        graph: options.graph,
        signal: options.signal,
        collectOutputs: (fanoutStepId, fromStepId) => this.collectOutputs(options.runId, scope.branchId, fanoutStepId, fromStepId)
      })
    } catch (error) {
      outcome = { status: 'failed', error: error instanceof Error ? error.message : 'Ошибка шага', rawResponse: null }
    }
    if (outcome.status !== 'completed' && outcome.status !== 'waiting_for_user' && (options.signal?.aborted || isAbortError(outcome.error))) {
      outcome = {
        status: 'failed',
        error: 'Остановлено',
        request: outcome.request,
        rawResponse: outcome.rawResponse ?? null,
        parsed: outcome.parsed,
        meta: { ...(outcome.meta ?? {}), interrupted: true }
      }
    }

    const finished = nowIso()
    execution.status = outcome.status
    execution.request = outcome.request ?? null
    execution.rawResponse = outcome.rawResponse ?? null
    execution.parsed = outcome.parsed ?? outcome.output ?? null
    execution.error = outcome.error ?? null
    execution.meta = { ...(outcome.meta ?? {}) }
    execution.finishedAt = outcome.status === 'waiting_for_user' ? null : finished
    execution.durationMs = Date.parse(finished) - Date.parse(started)
    this.store.updateExecution(execution)
    if (outcome.status === 'completed') {
      this.store.insertArtifact(this.artifact(options.runId, execution.id, outcome.output))
    }
    if (outcome.status === 'waiting_for_user') this.setBranchStatus(options.runId, scope.branchId, 'waiting_for_user')
    options.onProgress?.()
    if (outcome.status === 'completed') return 'completed'
    if (outcome.status === 'waiting_for_user') return 'paused'
    return 'failed'
  }

  private async writeFanoutError(step: StepDefinition, scope: Scope, options: AdvanceOptions, error: string): Promise<void> {
    const existing = this.effectiveExecution(options.runId, step.id, scope.branchId)
    const started = nowIso()
    const execution: StepExecution = {
      id: createId(),
      runId: options.runId,
      stepId: step.id,
      branchId: scope.branchId,
      attempt: (existing?.attempt ?? 0) + 1,
      status: 'failed',
      request: { over: step.iterate?.over },
      rawResponse: null,
      parsed: null,
      error,
      startedAt: started,
      finishedAt: started,
      durationMs: 0,
      meta: { fanoutError: true },
      createdAt: started
    }
    this.store.insertExecution(execution)
    options.onProgress?.()
  }

  private collectOutputs(runId: string, parentBranchId: string, fanoutStepId: string, fromStepId: string): unknown[] {
    return this.childBranches(runId, parentBranchId, fanoutStepId).map((branch) => {
      const execution = this.effectiveExecution(runId, fromStepId, branch.id)
      if (execution?.status !== 'completed') return null
      return this.outputOf(runId, execution.id)
    })
  }

  private buildContext(scope: Scope, options: AdvanceOptions, step?: StepDefinition): VariableContext {
    const aliases: Record<string, unknown> = {}
    let currentItem: unknown
    let currentIndex: number | undefined
    let cursor: Scope | null = scope
    while (cursor) {
      if (cursor.item !== undefined && currentItem === undefined) {
        currentItem = cursor.item
        currentIndex = cursor.index ?? undefined
      }
      if (cursor.alias && !Object.prototype.hasOwnProperty.call(aliases, cursor.alias)) {
        aliases[cursor.alias] = cursor.item
      }
      if (cursor.noteAlias && !Object.prototype.hasOwnProperty.call(aliases, cursor.noteAlias)) {
        aliases[cursor.noteAlias] = cursor.note ?? ''
      }
      cursor = cursor.parent
    }
    const steps: VariableContext['steps'] = {}
    for (const item of options.graph.steps) {
      const output = this.findOutput(options.runId, item.id, scope)
      if (output !== undefined) steps[item.key] = { output }
    }
    const previous = step ? previousStep(step, options.graph.steps) : null
    return {
      inputs: options.inputs,
      steps,
      current_item: currentItem,
      current_index: currentIndex,
      aliases,
      globals: options.globals ?? {},
      project: options.project ?? {},
      prev: previous ? { output: this.findOutput(options.runId, previous.id, scope) } : undefined
    }
  }

  private stepAllowed(step: StepDefinition, steps: StepDefinition[], allow: Set<string>): boolean {
    if (allow.has(step.id)) return true
    if (!step.iterate) return false
    return fanoutInnerSteps(step.id, steps).some((item) => allow.has(item.id))
  }

  private makeBranch(scope: Scope, step: StepDefinition, runId: string, item: unknown, index: number, batch: number): Branch {
    const branch: Branch = {
      id: createId(),
      runId,
      parentBranchId: scope.branchId,
      sourceStepId: step.id,
      itemIndex: index,
      batch,
      alias: step.iterate?.alias || 'current_item',
      label: branchLabel(item, index),
      item,
      note: '',
      noteAlias: step.iterate?.noteAlias?.trim() ?? '',
      status: 'pending'
    }
    this.store.insertBranch(branch)
    return branch
  }

  private findOutput(runId: string, stepId: string, scope: Scope): unknown {
    let cursor: Scope | null = scope
    while (cursor) {
      const execution = this.effectiveExecution(runId, stepId, cursor.branchId)
      if (execution) {
        if (execution.meta.fanoutError) return undefined
        if (execution.status === 'completed' || execution.status === 'skipped') return this.outputOf(runId, execution.id)
        return undefined
      }
      cursor = cursor.parent
    }
    return undefined
  }

  private outputOf(runId: string, executionId: string): unknown {
    return this.store.listArtifacts(runId).find((item) => item.stepExecutionId === executionId && item.name === 'output')?.value
  }

  private effectiveExecution(runId: string, stepId: string, branchId: string): StepExecution | undefined {
    const matches = this.store
      .listExecutions(runId)
      .filter((item) => item.stepId === stepId && item.branchId === branchId && !item.meta.fanoutError)
    if (!matches.length) {
      const fanoutErrors = this.store
        .listExecutions(runId)
        .filter((item) => item.stepId === stepId && item.branchId === branchId && item.meta.fanoutError)
      return fanoutErrors.sort((a, b) => b.attempt - a.attempt)[0]
    }
    return matches.sort((a, b) => b.attempt - a.attempt)[0]
  }

  private childBranches(runId: string, parentBranchId: string, sourceStepId: string): Branch[] {
    return this.store
      .listBranches(runId)
      .filter((branch) => branch.parentBranchId === parentBranchId && branch.sourceStepId === sourceStepId)
      .sort((a, b) => a.itemIndex - b.itemIndex)
  }

  private shouldRunBranch(branchId: string, onlyBranchId: string | undefined, runId: string): boolean {
    if (!onlyBranchId) return true
    return this.isOnPath(branchId, onlyBranchId, runId)
  }

  private isOnPath(branchId: string, targetId: string, runId: string): boolean {
    if (!targetId || branchId === targetId) return true
    const branches = this.store.listBranches(runId)
    const byId = new Map(branches.map((branch) => [branch.id, branch]))
    let cursor = byId.get(targetId)
    while (cursor) {
      if (cursor.id === branchId) return true
      cursor = cursor.parentBranchId ? byId.get(cursor.parentBranchId) : undefined
    }
    let other = byId.get(branchId)
    while (other) {
      if (other.id === targetId) return true
      other = other.parentBranchId ? byId.get(other.parentBranchId) : undefined
    }
    return false
  }

  private childScope(parent: Scope, branch: Branch, entryStepId: string): Scope {
    return {
      runId: parent.runId,
      branchId: branch.id,
      parent,
      entryStepId,
      alias: branch.alias,
      item: branch.item,
      index: branch.itemIndex,
      note: branch.note ?? '',
      noteAlias: branch.noteAlias ?? ''
    }
  }

  private scopeForBranch(runId: string, branchId: string, entryOverride: string | null): Scope {
    if (!branchId) return this.rootScope(runId)
    const chain: Branch[] = []
    const branches = this.store.listBranches(runId)
    let current = branches.find((branch) => branch.id === branchId)
    while (current) {
      chain.push(current)
      current = current.parentBranchId ? branches.find((branch) => branch.id === current?.parentBranchId) : undefined
    }
    chain.reverse()
    let scope = this.rootScope(runId)
    chain.forEach((branch, index) => {
      const isLeaf = index === chain.length - 1
      scope = this.childScope(scope, branch, isLeaf && entryOverride ? entryOverride : branch.sourceStepId)
    })
    return scope
  }

  private artifact(runId: string, executionId: string, value: unknown): Artifact {
    return {
      id: createId(),
      runId,
      stepExecutionId: executionId,
      name: 'output',
      kind: inferKind(value),
      value,
      createdAt: nowIso()
    }
  }

  private keepBranchAfterStop(runId: string, branchId: string): void {
    const branch = this.store.listBranches(runId).find((item) => item.id === branchId)
    if (!branch || branch.status === 'waiting_for_user' || branch.status === 'cancelled' || branch.status === 'completed') return
    this.setBranchStatus(runId, branchId, 'paused')
  }

  private setBranchStatus(runId: string, branchId: string, status: BranchStatus): void {
    if (!branchId) return
    const branch = this.store.listBranches(runId).find((item) => item.id === branchId)
    if (!branch || branch.status === status) return
    branch.status = status
    this.store.updateBranch(branch)
  }

  private refreshBranchStatus(runId: string, branchId: string): void {
    if (!branchId) return
    const branch = this.store.listBranches(runId).find((item) => item.id === branchId)
    if (!branch) return
    const executions = this.store.listExecutions(runId).filter((item) => item.branchId === branchId)
    const latest = new Map<string, StepExecution>()
    for (const execution of executions) {
      const prev = latest.get(execution.stepId)
      if (!prev || execution.attempt > prev.attempt) latest.set(execution.stepId, execution)
    }
    const values = [...latest.values()]
    let status: BranchStatus = branch.status
    if (values.some((item) => item.status === 'waiting_for_user')) status = 'waiting_for_user'
    else if (values.some((item) => item.status === 'running')) status = 'running'
    else if (values.some((item) => item.status === 'failed')) status = 'failed'
    this.setBranchStatus(runId, branchId, status)
  }

  private sweepInterrupted(runId: string): void {
    for (const execution of this.store.listExecutions(runId)) {
      if (execution.status !== 'running') continue
      execution.status = 'failed'
      execution.error = 'Выполнение прервано'
      execution.finishedAt = nowIso()
      this.store.updateExecution(execution)
    }
  }

  private failScope(scope: Scope, options: AdvanceOptions, message: string): AdvanceResult {
    void scope
    options.onProgress?.()
    const started = nowIso()
    const execution: StepExecution = {
      id: createId(),
      runId: options.runId,
      stepId: 'graph',
      branchId: '',
      attempt: 1,
      status: 'failed',
      request: null,
      rawResponse: null,
      parsed: null,
      error: message,
      startedAt: started,
      finishedAt: started,
      durationMs: 0,
      meta: {} as ExecutionMeta,
      createdAt: started
    }
    this.store.insertExecution(execution)
    return 'failed'
  }
}

export function isAbortError(error: string | null | undefined): boolean {
  if (!error) return false
  return error === 'Остановлено' || /abort/i.test(error)
}

export function settleRunStatus(result: AdvanceResult, store: EngineStore, runId: string, graph: WorkflowGraph): 'paused' | 'completed' | 'failed' | 'cancelled' {
  if (result === 'cancelled') return 'cancelled'
  if (result === 'failed') return 'failed'
  const branches = store.listBranches(runId)
  if (branches.some((branch) => branch.status !== 'completed' && branch.status !== 'cancelled')) return 'paused'
  const executions = store.listExecutions(runId)
  if (executions.some((item) => item.status === 'waiting_for_user' || item.status === 'failed' || item.status === 'running')) {
    return 'paused'
  }
  const hidden = hiddenDescendantIds(graph.steps, null)
  for (const step of graph.steps) {
    if (hidden.has(step.id) || step.iterate) continue
    const latest = executions
      .filter((item) => item.stepId === step.id && item.branchId === '' && !item.meta.fanoutError)
      .sort((a, b) => b.attempt - a.attempt)[0]
    if (!latest || (latest.status !== 'completed' && latest.status !== 'skipped')) return 'paused'
  }
  if (result === 'paused') return 'paused'
  return 'completed'
}
