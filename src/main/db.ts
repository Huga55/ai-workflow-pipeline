import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type { Bundle, BundleDraft, BundleProject } from '@core/bundle'
import type { EngineStore } from '@core/store'
import type {
  Artifact,
  Branch,
  ExecutionMeta,
  ExecutionStatus,
  NamedVariable,
  Project,
  Run,
  RunDetails,
  RunStatus,
  RunSummary,
  StepExecution,
  UserAction,
  Workflow,
  WorkflowDetails,
  WorkflowDraft,
  WorkflowGraph,
  WorkflowVersion
} from '@core/types'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_drafts (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_branch_id TEXT NOT NULL DEFAULT '',
  source_step_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  alias TEXT NOT NULL,
  label TEXT NOT NULL,
  item_json TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(run_id, parent_branch_id, source_step_id, item_index)
);

CREATE TABLE IF NOT EXISTS step_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  request_json TEXT,
  raw_response TEXT,
  parsed_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(run_id, step_id, branch_id, attempt)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_execution_id TEXT NOT NULL REFERENCES step_executions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS named_variables (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, project_id, name)
);

CREATE TABLE IF NOT EXISTS user_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_execution_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

export class AppDatabase {
  private constructor(private db: DatabaseSync) {}

  static open(filePath: string): AppDatabase {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const db = new DatabaseSync(filePath)
    db.exec(SCHEMA)
    return new AppDatabase(db)
  }

  listProjects(): Project[] {
    return this.all<Project>(
      `SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt
       FROM projects ORDER BY updated_at DESC`
    )
  }

  createProject(project: Project): Project {
    this.run(
      `INSERT INTO projects (id, name, description, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
      project.id,
      project.name,
      project.description,
      project.createdAt,
      project.updatedAt
    )
    return project
  }

  updateProject(id: string, patch: { name?: string; description?: string }, updatedAt: string): Project {
    const current = this.getProject(id)
    const name = patch.name ?? current.name
    const description = patch.description ?? current.description
    this.run(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`, name, description, updatedAt, id)
    return this.getProject(id)
  }

  getProject(id: string): Project {
    const row = this.get<Project>(
      `SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?`,
      id
    )
    if (!row) throw new Error('Проект не найден')
    return row
  }

  deleteProject(id: string): void {
    this.run(`DELETE FROM projects WHERE id = ?`, id)
  }

  touchProject(id: string, updatedAt: string): void {
    this.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, updatedAt, id)
  }

  listWorkflows(projectId: string): Workflow[] {
    return this.all<Workflow>(
      `SELECT w.id, w.project_id AS projectId, w.name, w.description, w.created_at AS createdAt, w.updated_at AS updatedAt,
              COALESCE(MAX(v.version), 0) AS latestVersion
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.workflow_id = w.id
       WHERE w.project_id = ?
       GROUP BY w.id
       ORDER BY w.updated_at DESC`,
      projectId
    )
  }

  insertWorkflow(workflow: Workflow): void {
    this.run(
      `INSERT INTO workflows (id, project_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      workflow.id,
      workflow.projectId,
      workflow.name,
      workflow.description,
      workflow.createdAt,
      workflow.updatedAt
    )
  }

  updateWorkflowMeta(id: string, name: string, description: string, updatedAt: string): void {
    this.run(`UPDATE workflows SET name = ?, description = ?, updated_at = ? WHERE id = ?`, name, description, updatedAt, id)
  }

  getWorkflowRow(id: string): Workflow {
    const row = this.get<Workflow>(
      `SELECT w.id, w.project_id AS projectId, w.name, w.description, w.created_at AS createdAt, w.updated_at AS updatedAt,
              COALESCE(MAX(v.version), 0) AS latestVersion
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.workflow_id = w.id
       WHERE w.id = ?
       GROUP BY w.id`,
      id
    )
    if (!row) throw new Error('Workflow не найден')
    return row
  }

  saveDraft(workflowId: string, draft: WorkflowDraft): void {
    this.run(
      `INSERT INTO workflow_drafts (workflow_id, payload_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      workflowId,
      JSON.stringify({ name: draft.name, description: draft.description, graph: draft.graph, selectedId: draft.selectedId }),
      draft.updatedAt
    )
  }

  getDraft(workflowId: string): WorkflowDraft | null {
    const row = this.get<{ payloadJson: string; updatedAt: string }>(
      `SELECT payload_json AS payloadJson, updated_at AS updatedAt FROM workflow_drafts WHERE workflow_id = ?`,
      workflowId
    )
    if (!row) return null
    const payload = JSON.parse(row.payloadJson) as Omit<WorkflowDraft, 'updatedAt'>
    return { ...payload, updatedAt: row.updatedAt }
  }

  clearDraft(workflowId: string): void {
    this.run(`DELETE FROM workflow_drafts WHERE workflow_id = ?`, workflowId)
  }

  deleteWorkflow(id: string): void {
    this.run(`DELETE FROM workflows WHERE id = ?`, id)
  }

  insertVersion(version: WorkflowVersion): void {
    this.run(
      `INSERT INTO workflow_versions (id, workflow_id, version, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      version.id,
      version.workflowId,
      version.version,
      JSON.stringify(version.graph),
      version.createdAt
    )
  }

  listVersionMeta(workflowId: string): { id: string; version: number; createdAt: string }[] {
    return this.all(
      `SELECT id, version, created_at AS createdAt FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC`,
      workflowId
    )
  }

  getVersion(id: string): WorkflowVersion {
    const row = this.get<VersionRow>(
      `SELECT id, workflow_id AS workflowId, version, snapshot_json AS snapshotJson, created_at AS createdAt
       FROM workflow_versions WHERE id = ?`,
      id
    )
    if (!row) throw new Error('Версия workflow не найдена')
    return { ...row, graph: JSON.parse(row.snapshotJson) as WorkflowGraph }
  }

  getVersionByNumber(workflowId: string, version: number): WorkflowVersion {
    const row = this.get<VersionRow>(
      `SELECT id, workflow_id AS workflowId, version, snapshot_json AS snapshotJson, created_at AS createdAt
       FROM workflow_versions WHERE workflow_id = ? AND version = ?`,
      workflowId,
      version
    )
    if (!row) throw new Error('Версия workflow не найдена')
    return { ...row, graph: JSON.parse(row.snapshotJson) as WorkflowGraph }
  }

  latestVersion(workflowId: string): WorkflowVersion {
    const row = this.get<VersionRow>(
      `SELECT id, workflow_id AS workflowId, version, snapshot_json AS snapshotJson, created_at AS createdAt
       FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1`,
      workflowId
    )
    if (!row) throw new Error('У workflow нет версий')
    return { ...row, graph: JSON.parse(row.snapshotJson) as WorkflowGraph }
  }

  workflowDetails(workflowId: string, versionNumber?: number): WorkflowDetails {
    const workflow = this.getWorkflowRow(workflowId)
    const version = versionNumber ? this.getVersionByNumber(workflowId, versionNumber) : this.latestVersion(workflowId)
    return { workflow, version, versions: this.listVersionMeta(workflowId) }
  }

  nextRunNumber(projectId: string): number {
    const row = this.get<{ maxNumber: number | null }>(
      `SELECT MAX(number) AS maxNumber FROM runs WHERE project_id = ?`,
      projectId
    )
    return (row?.maxNumber ?? 0) + 1
  }

  insertRun(run: Run): void {
    this.run(
      `INSERT INTO runs (id, project_id, workflow_id, workflow_version_id, number, title, status, inputs_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.projectId,
      run.workflowId,
      run.workflowVersionId,
      run.number,
      run.title,
      run.status,
      JSON.stringify(run.inputs),
      run.error,
      run.createdAt,
      run.updatedAt
    )
  }

  deleteRun(runId: string): void {
    this.run(`DELETE FROM runs WHERE id = ?`, runId)
  }

  listRuns(projectId: string): RunSummary[] {
    return this.all<RunSummary>(
      `SELECT r.id, r.project_id AS projectId, r.workflow_id AS workflowId, w.name AS workflowName,
              v.version AS versionNumber, r.number, r.title, r.status, r.created_at AS createdAt, r.updated_at AS updatedAt
       FROM runs r
       JOIN workflows w ON w.id = r.workflow_id
       JOIN workflow_versions v ON v.id = r.workflow_version_id
       WHERE r.project_id = ?
       ORDER BY r.created_at DESC`,
      projectId
    )
  }

  getRun(runId: string): RunDetails {
    const row = this.get<RunRow>(
      `SELECT r.id, r.project_id AS projectId, r.workflow_id AS workflowId, r.workflow_version_id AS workflowVersionId,
              r.number, r.title, r.status, r.inputs_json AS inputsJson, r.error, r.created_at AS createdAt, r.updated_at AS updatedAt,
              v.version AS versionNumber, v.snapshot_json AS snapshotJson, w.name AS workflowName
       FROM runs r
       JOIN workflow_versions v ON v.id = r.workflow_version_id
       JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
      runId
    )
    if (!row) throw new Error('Запуск не найден')
    return {
      run: {
        id: row.id,
        projectId: row.projectId,
        workflowId: row.workflowId,
        workflowVersionId: row.workflowVersionId,
        number: row.number,
        title: row.title,
        status: row.status as RunStatus,
        inputs: JSON.parse(row.inputsJson) as Record<string, unknown>,
        error: row.error,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      },
      graph: JSON.parse(row.snapshotJson) as WorkflowGraph,
      versionNumber: row.versionNumber,
      workflowName: row.workflowName,
      branches: this.listBranches(runId),
      executions: this.listExecutions(runId),
      artifacts: this.listArtifacts(runId)
    }
  }

  updateRunInputs(runId: string, inputs: Record<string, unknown>, updatedAt: string): void {
    this.run(`UPDATE runs SET inputs_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(inputs), updatedAt, runId)
  }

  updateRunTitle(runId: string, title: string, updatedAt: string): void {
    this.run(`UPDATE runs SET title = ?, updated_at = ? WHERE id = ?`, title, updatedAt, runId)
  }

  updateRunStatus(runId: string, status: RunStatus, error: string | null, updatedAt: string): void {
    this.run(`UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`, status, error, updatedAt, runId)
  }

  listExecutions(runId: string): StepExecution[] {
    return this.all<ExecutionRow>(
      `SELECT id, run_id AS runId, step_id AS stepId, branch_id AS branchId, attempt, status,
              request_json AS requestJson, raw_response AS rawResponse, parsed_json AS parsedJson, error,
              started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs,
              meta_json AS metaJson, created_at AS createdAt
       FROM step_executions WHERE run_id = ? ORDER BY created_at ASC`,
      runId
    ).map(mapExecution)
  }

  insertExecution(execution: StepExecution): void {
    this.run(
      `INSERT INTO step_executions (
        id, run_id, step_id, branch_id, attempt, status, request_json, raw_response, parsed_json, error,
        started_at, finished_at, duration_ms, meta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      execution.id,
      execution.runId,
      execution.stepId,
      execution.branchId,
      execution.attempt,
      execution.status,
      jsonOrNull(execution.request),
      execution.rawResponse,
      jsonOrNull(execution.parsed),
      execution.error,
      execution.startedAt,
      execution.finishedAt,
      execution.durationMs,
      JSON.stringify(execution.meta ?? {}),
      execution.createdAt
    )
  }

  updateExecution(execution: StepExecution): void {
    this.run(
      `UPDATE step_executions
       SET status = ?, request_json = ?, raw_response = ?, parsed_json = ?, error = ?,
           started_at = ?, finished_at = ?, duration_ms = ?, meta_json = ?
       WHERE id = ?`,
      execution.status,
      jsonOrNull(execution.request),
      execution.rawResponse,
      jsonOrNull(execution.parsed),
      execution.error,
      execution.startedAt,
      execution.finishedAt,
      execution.durationMs,
      JSON.stringify(execution.meta ?? {}),
      execution.id
    )
  }

  listBranches(runId: string): Branch[] {
    return this.all<BranchRow>(
      `SELECT id, run_id AS runId, parent_branch_id AS parentBranchId, source_step_id AS sourceStepId,
              item_index AS itemIndex, alias, label, item_json AS itemJson, status
       FROM branches WHERE run_id = ? ORDER BY item_index ASC`,
      runId
    ).map((row) => ({
      id: row.id,
      runId: row.runId,
      parentBranchId: row.parentBranchId,
      sourceStepId: row.sourceStepId,
      itemIndex: row.itemIndex,
      alias: row.alias,
      label: row.label,
      item: JSON.parse(row.itemJson) as unknown,
      status: row.status as Branch['status']
    }))
  }

  insertBranch(branch: Branch): void {
    this.run(
      `INSERT INTO branches (id, run_id, parent_branch_id, source_step_id, item_index, alias, label, item_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      branch.id,
      branch.runId,
      branch.parentBranchId,
      branch.sourceStepId,
      branch.itemIndex,
      branch.alias,
      branch.label,
      JSON.stringify(branch.item),
      branch.status
    )
  }

  updateBranch(branch: Branch): void {
    this.run(
      `UPDATE branches SET status = ?, label = ?, alias = ?, item_json = ? WHERE id = ?`,
      branch.status,
      branch.label,
      branch.alias,
      JSON.stringify(branch.item),
      branch.id
    )
  }

  listVariables(scope: 'global' | 'project', projectId: string | null): NamedVariable[] {
    return this.all<VariableRow>(
      `SELECT id, scope, project_id AS projectId, name, label, value_json AS valueJson, updated_at AS updatedAt
       FROM named_variables WHERE scope = ? AND project_id = ? ORDER BY name`,
      scope,
      projectId ?? ''
    ).map(mapVariable)
  }

  saveVariable(variable: NamedVariable): void {
    this.run(
      `INSERT INTO named_variables (id, scope, project_id, name, label, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, project_id, name) DO UPDATE SET
         label = excluded.label,
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      variable.id,
      variable.scope,
      variable.projectId ?? '',
      variable.name,
      variable.label,
      JSON.stringify(variable.value),
      variable.updatedAt
    )
  }

  deleteVariable(id: string): void {
    this.run(`DELETE FROM named_variables WHERE id = ?`, id)
  }

  listArtifacts(runId: string): Artifact[] {
    return this.all<ArtifactRow>(
      `SELECT id, run_id AS runId, step_execution_id AS stepExecutionId, name, kind, value_json AS valueJson, created_at AS createdAt
       FROM artifacts WHERE run_id = ?`,
      runId
    ).map((row) => ({
      id: row.id,
      runId: row.runId,
      stepExecutionId: row.stepExecutionId,
      name: row.name,
      kind: row.kind as Artifact['kind'],
      value: JSON.parse(row.valueJson) as unknown,
      createdAt: row.createdAt
    }))
  }

  insertArtifact(artifact: Artifact): void {
    this.run(
      `INSERT INTO artifacts (id, run_id, step_execution_id, name, kind, value_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      artifact.id,
      artifact.runId,
      artifact.stepExecutionId,
      artifact.name,
      artifact.kind,
      JSON.stringify(artifact.value),
      artifact.createdAt
    )
  }

  insertUserAction(action: UserAction): void {
    this.run(
      `INSERT INTO user_actions (id, run_id, step_execution_id, action_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      action.id,
      action.runId,
      action.stepExecutionId,
      action.actionType,
      JSON.stringify(action.payload),
      action.createdAt
    )
  }

  readBundle(): Omit<Bundle, 'format' | 'version' | 'exportedAt' | 'secrets' | 'media'> {
    const projects = this.all<BundleProject & { settingsJson: string }>(
      `SELECT id, name, description, settings_json AS settingsJson, created_at AS createdAt, updated_at AS updatedAt FROM projects`
    ).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      settings: JSON.parse(row.settingsJson) as unknown,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }))
    const workflows = this.all<Workflow>(
      `SELECT id, project_id AS projectId, name, description, created_at AS createdAt, updated_at AS updatedAt, 0 AS latestVersion FROM workflows`
    )
    const versions = this.all<{ id: string; workflowId: string; version: number; snapshotJson: string; createdAt: string }>(
      `SELECT id, workflow_id AS workflowId, version, snapshot_json AS snapshotJson, created_at AS createdAt FROM workflow_versions`
    ).map((row) => ({
      id: row.id,
      workflowId: row.workflowId,
      version: row.version,
      graph: JSON.parse(row.snapshotJson) as WorkflowGraph,
      createdAt: row.createdAt
    }))
    const drafts = this.all<{ workflowId: string; payloadJson: string; updatedAt: string }>(
      `SELECT workflow_id AS workflowId, payload_json AS payloadJson, updated_at AS updatedAt FROM workflow_drafts`
    ).map((row) => {
      const payload = JSON.parse(row.payloadJson) as Omit<BundleDraft, 'workflowId' | 'updatedAt'>
      return { workflowId: row.workflowId, ...payload, updatedAt: row.updatedAt }
    })
    const runs = this.all<Run & { inputsJson: string }>(
      `SELECT id, project_id AS projectId, workflow_id AS workflowId, workflow_version_id AS workflowVersionId,
              number, title, status, inputs_json AS inputsJson, error, created_at AS createdAt, updated_at AS updatedAt
       FROM runs`
    ).map((row) => ({
      id: row.id,
      projectId: row.projectId,
      workflowId: row.workflowId,
      workflowVersionId: row.workflowVersionId,
      number: row.number,
      title: row.title,
      status: row.status,
      inputs: JSON.parse(row.inputsJson) as Record<string, unknown>,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }))
    const branches = this.listAllBranches()
    const executions = this.all<ExecutionRow>(
      `SELECT id, run_id AS runId, step_id AS stepId, branch_id AS branchId, attempt, status,
              request_json AS requestJson, raw_response AS rawResponse, parsed_json AS parsedJson, error,
              started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs,
              meta_json AS metaJson, created_at AS createdAt
       FROM step_executions`
    ).map(mapExecution)
    const artifacts = this.all<ArtifactRow>(
      `SELECT id, run_id AS runId, step_execution_id AS stepExecutionId, name, kind, value_json AS valueJson, created_at AS createdAt
       FROM artifacts`
    ).map((row) => ({
      id: row.id,
      runId: row.runId,
      stepExecutionId: row.stepExecutionId,
      name: row.name,
      kind: row.kind as Artifact['kind'],
      value: JSON.parse(row.valueJson) as unknown,
      createdAt: row.createdAt
    }))
    const actions = this.all<{ id: string; runId: string; stepExecutionId: string; actionType: string; payloadJson: string; createdAt: string }>(
      `SELECT id, run_id AS runId, step_execution_id AS stepExecutionId, action_type AS actionType, payload_json AS payloadJson, created_at AS createdAt
       FROM user_actions`
    ).map((row) => ({
      id: row.id,
      runId: row.runId,
      stepExecutionId: row.stepExecutionId,
      actionType: row.actionType,
      payload: JSON.parse(row.payloadJson) as unknown,
      createdAt: row.createdAt
    }))
    const variables = this.all<VariableRow>(
      `SELECT id, scope, project_id AS projectId, name, label, value_json AS valueJson, updated_at AS updatedAt FROM named_variables`
    ).map(mapVariable)
    return { projects, workflows, versions, drafts, runs, branches, executions, artifacts, actions, variables }
  }

  writeBundle(bundle: Bundle): void {
    this.db.exec('BEGIN')
    try {
      for (const project of bundle.projects) {
        this.run(
          `INSERT INTO projects (id, name, description, settings_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             settings_json = excluded.settings_json,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          project.id,
          project.name,
          project.description,
          JSON.stringify(project.settings ?? {}),
          project.createdAt,
          project.updatedAt
        )
      }
      for (const workflow of bundle.workflows) {
        this.run(
          `INSERT INTO workflows (id, project_id, name, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             name = excluded.name,
             description = excluded.description,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          workflow.id,
          workflow.projectId,
          workflow.name,
          workflow.description,
          workflow.createdAt,
          workflow.updatedAt
        )
      }
      for (const version of bundle.versions) {
        this.run(
          `DELETE FROM workflow_versions WHERE workflow_id = ? AND version = ? AND id <> ?`,
          version.workflowId,
          version.version,
          version.id
        )
        this.run(
          `INSERT INTO workflow_versions (id, workflow_id, version, snapshot_json, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             workflow_id = excluded.workflow_id,
             version = excluded.version,
             snapshot_json = excluded.snapshot_json,
             created_at = excluded.created_at`,
          version.id,
          version.workflowId,
          version.version,
          JSON.stringify(version.graph),
          version.createdAt
        )
      }
      for (const draft of bundle.drafts) {
        this.run(
          `INSERT INTO workflow_drafts (workflow_id, payload_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(workflow_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
          draft.workflowId,
          JSON.stringify({ name: draft.name, description: draft.description, graph: draft.graph, selectedId: draft.selectedId }),
          draft.updatedAt
        )
      }
      for (const run of bundle.runs) {
        const status = run.status === 'running' ? 'paused' : run.status
        this.run(
          `INSERT INTO runs (id, project_id, workflow_id, workflow_version_id, number, title, status, inputs_json, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             workflow_id = excluded.workflow_id,
             workflow_version_id = excluded.workflow_version_id,
             number = excluded.number,
             title = excluded.title,
             status = excluded.status,
             inputs_json = excluded.inputs_json,
             error = excluded.error,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          run.id,
          run.projectId,
          run.workflowId,
          run.workflowVersionId,
          run.number,
          run.title,
          status,
          JSON.stringify(run.inputs ?? {}),
          run.error,
          run.createdAt,
          run.updatedAt
        )
      }
      for (const branch of bundle.branches) {
        this.run(
          `DELETE FROM branches WHERE run_id = ? AND parent_branch_id = ? AND source_step_id = ? AND item_index = ? AND id <> ?`,
          branch.runId,
          branch.parentBranchId,
          branch.sourceStepId,
          branch.itemIndex,
          branch.id
        )
        this.run(
          `INSERT INTO branches (id, run_id, parent_branch_id, source_step_id, item_index, alias, label, item_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             run_id = excluded.run_id,
             parent_branch_id = excluded.parent_branch_id,
             source_step_id = excluded.source_step_id,
             item_index = excluded.item_index,
             alias = excluded.alias,
             label = excluded.label,
             item_json = excluded.item_json,
             status = excluded.status`,
          branch.id,
          branch.runId,
          branch.parentBranchId,
          branch.sourceStepId,
          branch.itemIndex,
          branch.alias,
          branch.label,
          JSON.stringify(branch.item),
          branch.status
        )
      }
      for (const execution of bundle.executions) {
        const status = execution.status === 'running' ? 'failed' : execution.status
        const error = execution.status === 'running' ? execution.error || 'Импорт прервал выполнение' : execution.error
        this.run(
          `DELETE FROM step_executions WHERE run_id = ? AND step_id = ? AND branch_id = ? AND attempt = ? AND id <> ?`,
          execution.runId,
          execution.stepId,
          execution.branchId,
          execution.attempt,
          execution.id
        )
        this.run(
          `INSERT INTO step_executions (
             id, run_id, step_id, branch_id, attempt, status, request_json, raw_response, parsed_json, error,
             started_at, finished_at, duration_ms, meta_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             run_id = excluded.run_id,
             step_id = excluded.step_id,
             branch_id = excluded.branch_id,
             attempt = excluded.attempt,
             status = excluded.status,
             request_json = excluded.request_json,
             raw_response = excluded.raw_response,
             parsed_json = excluded.parsed_json,
             error = excluded.error,
             started_at = excluded.started_at,
             finished_at = excluded.finished_at,
             duration_ms = excluded.duration_ms,
             meta_json = excluded.meta_json,
             created_at = excluded.created_at`,
          execution.id,
          execution.runId,
          execution.stepId,
          execution.branchId,
          execution.attempt,
          status,
          jsonOrNull(execution.request),
          execution.rawResponse,
          jsonOrNull(execution.parsed),
          error,
          execution.startedAt,
          execution.finishedAt,
          execution.durationMs,
          JSON.stringify(execution.meta ?? {}),
          execution.createdAt
        )
      }
      for (const artifact of bundle.artifacts) {
        this.run(
          `INSERT INTO artifacts (id, run_id, step_execution_id, name, kind, value_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             run_id = excluded.run_id,
             step_execution_id = excluded.step_execution_id,
             name = excluded.name,
             kind = excluded.kind,
             value_json = excluded.value_json,
             created_at = excluded.created_at`,
          artifact.id,
          artifact.runId,
          artifact.stepExecutionId,
          artifact.name,
          artifact.kind,
          JSON.stringify(artifact.value),
          artifact.createdAt
        )
      }
      for (const action of bundle.actions) {
        this.run(
          `INSERT INTO user_actions (id, run_id, step_execution_id, action_type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             run_id = excluded.run_id,
             step_execution_id = excluded.step_execution_id,
             action_type = excluded.action_type,
             payload_json = excluded.payload_json,
             created_at = excluded.created_at`,
          action.id,
          action.runId,
          action.stepExecutionId,
          action.actionType,
          JSON.stringify(action.payload),
          action.createdAt
        )
      }
      for (const variable of bundle.variables) {
        const projectId = variable.projectId ?? ''
        this.run(
          `DELETE FROM named_variables WHERE scope = ? AND project_id = ? AND name = ? AND id <> ?`,
          variable.scope,
          projectId,
          variable.name,
          variable.id
        )
        this.run(
          `INSERT INTO named_variables (id, scope, project_id, name, label, value_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             scope = excluded.scope,
             project_id = excluded.project_id,
             name = excluded.name,
             label = excluded.label,
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
          variable.id,
          variable.scope,
          projectId,
          variable.name,
          variable.label,
          JSON.stringify(variable.value),
          variable.updatedAt
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private listAllBranches(): Branch[] {
    return this.all<BranchRow>(
      `SELECT id, run_id AS runId, parent_branch_id AS parentBranchId, source_step_id AS sourceStepId,
              item_index AS itemIndex, alias, label, item_json AS itemJson, status
       FROM branches`
    ).map((row) => ({
      id: row.id,
      runId: row.runId,
      parentBranchId: row.parentBranchId,
      sourceStepId: row.sourceStepId,
      itemIndex: row.itemIndex,
      alias: row.alias,
      label: row.label,
      item: JSON.parse(row.itemJson) as unknown,
      status: row.status as Branch['status']
    }))
  }

  private all<T>(sql: string, ...params: SQLInput[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }) as T)
  }

  private get<T>(sql: string, ...params: SQLInput[]): T | undefined {
    const row = this.db.prepare(sql).get(...params) as Record<string, SQLOutputValue> | undefined
    return row ? ({ ...row } as T) : undefined
  }

  private run(sql: string, ...params: SQLInput[]): void {
    ;(this.db.prepare(sql) as StatementSync).run(...params)
  }
}

export class SqliteEngineStore implements EngineStore {
  constructor(private database: AppDatabase) {}

  listExecutions(runId: string): StepExecution[] {
    return this.database.listExecutions(runId)
  }

  listBranches(runId: string): Branch[] {
    return this.database.listBranches(runId)
  }

  listArtifacts(runId: string): Artifact[] {
    return this.database.listArtifacts(runId)
  }

  insertExecution(execution: StepExecution): void {
    this.database.insertExecution(execution)
  }

  updateExecution(execution: StepExecution): void {
    this.database.updateExecution(execution)
  }

  insertArtifact(artifact: Artifact): void {
    this.database.insertArtifact(artifact)
  }

  insertBranch(branch: Branch): void {
    this.database.insertBranch(branch)
  }

  updateBranch(branch: Branch): void {
    this.database.updateBranch(branch)
  }

  insertUserAction(action: UserAction): void {
    this.database.insertUserAction(action)
  }
}

type SQLInput = string | number | null | bigint

type VersionRow = {
  id: string
  workflowId: string
  version: number
  snapshotJson: string
  createdAt: string
}

type RunRow = {
  id: string
  projectId: string
  workflowId: string
  workflowVersionId: string
  number: number
  title: string
  status: string
  inputsJson: string
  error: string | null
  createdAt: string
  updatedAt: string
  versionNumber: number
  snapshotJson: string
  workflowName: string
}

type ExecutionRow = {
  id: string
  runId: string
  stepId: string
  branchId: string
  attempt: number
  status: string
  requestJson: string | null
  rawResponse: string | null
  parsedJson: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  metaJson: string
  createdAt: string
}

type BranchRow = {
  id: string
  runId: string
  parentBranchId: string
  sourceStepId: string
  itemIndex: number
  alias: string
  label: string
  itemJson: string
  status: string
}

type VariableRow = {
  id: string
  scope: string
  projectId: string
  name: string
  label: string
  valueJson: string
  updatedAt: string
}

type ArtifactRow = {
  id: string
  runId: string
  stepExecutionId: string
  name: string
  kind: string
  valueJson: string
  createdAt: string
}

function mapVariable(row: VariableRow): NamedVariable {
  return {
    id: row.id,
    scope: row.scope === 'project' ? 'project' : 'global',
    projectId: row.projectId || null,
    name: row.name,
    label: row.label,
    value: JSON.parse(row.valueJson) as unknown,
    updatedAt: row.updatedAt
  }
}

function mapExecution(row: ExecutionRow): StepExecution {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    branchId: row.branchId,
    attempt: row.attempt,
    status: row.status as ExecutionStatus,
    request: row.requestJson ? (JSON.parse(row.requestJson) as unknown) : null,
    rawResponse: row.rawResponse,
    parsed: row.parsedJson ? (JSON.parse(row.parsedJson) as unknown) : null,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    meta: JSON.parse(row.metaJson) as ExecutionMeta,
    createdAt: row.createdAt
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}
