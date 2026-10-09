import { isStoredFile } from '@core/media'
import { createId } from '@core/ids'
import type {
  Artifact,
  Branch,
  NamedVariable,
  Run,
  StepExecution,
  UserAction,
  VariableVersion,
  Workflow,
  WorkflowGraph,
  WorkflowVersion
} from '@core/types'

export const BUNDLE_FORMAT = 'ai-workflow-pipeline'
export const BUNDLE_VERSION = 1

export type BundleProject = {
  id: string
  name: string
  description: string
  settings: unknown
  createdAt: string
  updatedAt: string
}

export type BundleDraft = {
  workflowId: string
  name: string
  description: string
  graph: WorkflowGraph
  selectedId: string | null
  updatedAt: string
}

export type BundleMedia = {
  id: string
  name: string
  mime: string
  data: string
}

export type Bundle = {
  format: typeof BUNDLE_FORMAT
  version: typeof BUNDLE_VERSION
  exportedAt: string
  projects: BundleProject[]
  workflows: Workflow[]
  versions: WorkflowVersion[]
  drafts: BundleDraft[]
  runs: Run[]
  branches: Branch[]
  executions: StepExecution[]
  artifacts: Artifact[]
  actions: UserAction[]
  variables: NamedVariable[]
  secrets: Record<string, string>
  media: BundleMedia[]
}

const TABLES = ['projects', 'workflows', 'versions', 'drafts', 'runs', 'branches', 'executions', 'artifacts', 'actions', 'variables'] as const

export function parseBundle(text: string): Bundle {
  let data: Bundle
  try {
    data = JSON.parse(text) as Bundle
  } catch {
    throw new Error('Файл не является JSON')
  }
  if (!data || data.format !== BUNDLE_FORMAT || data.version !== BUNDLE_VERSION) {
    throw new Error('Это не файл экспорта Pipeline')
  }
  for (const key of TABLES) {
    if (!Array.isArray(data[key])) throw new Error('Файл экспорта повреждён')
  }
  if (!data.secrets || typeof data.secrets !== 'object' || Array.isArray(data.secrets)) data.secrets = {}
  if (!Array.isArray(data.media)) data.media = []
  data.variables = data.variables.map((item) => normalizeImportedVariable(item))
  return data
}

export function normalizeImportedVariable(raw: unknown): NamedVariable {
  if (!raw || typeof raw !== 'object') throw new Error('Файл экспорта повреждён')
  const row = raw as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  const name = typeof row.name === 'string' ? row.name : ''
  if (!id || !name) throw new Error('Файл экспорта повреждён')
  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString()
  const versions = Array.isArray(row.versions)
    ? row.versions.map((item, index) => normalizeImportedVersion(item, id, index, updatedAt))
    : [
        {
          id: `${id}-v1`,
          version: 1,
          description: '',
          value: row.value,
          createdAt: updatedAt
        }
      ]
  if (!versions.length) throw new Error('Файл экспорта повреждён')
  return {
    id,
    scope: row.scope === 'project' ? 'project' : 'global',
    projectId: typeof row.projectId === 'string' && row.projectId ? row.projectId : null,
    name,
    label: typeof row.label === 'string' && row.label ? row.label : name,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : updatedAt,
    updatedAt,
    versions
  }
}

function normalizeImportedVersion(raw: unknown, variableId: string, index: number, fallbackAt: string): VariableVersion {
  if (!raw || typeof raw !== 'object') throw new Error('Файл экспорта повреждён')
  const row = raw as Record<string, unknown>
  const version = typeof row.version === 'number' && Number.isInteger(row.version) && row.version > 0 ? row.version : index + 1
  return {
    id: typeof row.id === 'string' && row.id ? row.id : `${variableId}-v${version}`,
    version,
    description: typeof row.description === 'string' ? row.description : '',
    value: row.value,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : fallbackAt
  }
}

export type StoredPath = { path: string; name: string; mime: string }

export function mapStoredPaths(value: unknown, mapPath: (file: StoredPath) => string): unknown {
  if (isStoredFile(value)) {
    const file = value as StoredPath
    return { ...file, path: mapPath(file) }
  }
  if (isImagePart(value)) return { ...value, path: mapPath(value) }
  if (Array.isArray(value)) return value.map((item) => mapStoredPaths(item, mapPath))
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) copy[key] = mapStoredPaths(item, mapPath)
    return copy
  }
  return value
}

export function detachPaths(value: unknown, files: Map<string, { id: string; name: string; mime: string }>): unknown {
  return mapStoredPaths(value, (file) => {
    if (file.path.startsWith('media:')) return file.path
    let saved = files.get(file.path)
    if (!saved) {
      saved = { id: createId(), name: file.name, mime: file.mime }
      files.set(file.path, saved)
    }
    return `media:${saved.id}`
  })
}

export function attachPaths(value: unknown, paths: Map<string, string>): unknown {
  return mapStoredPaths(value, (file) => {
    if (!file.path.startsWith('media:')) return file.path
    return paths.get(file.path.slice('media:'.length)) ?? file.path
  })
}

function isImagePart(value: unknown): value is { type: 'image'; path: string; mime: string; name: string } {
  if (!value || typeof value !== 'object') return false
  const part = value as Record<string, unknown>
  return part.type === 'image' && typeof part.path === 'string' && typeof part.mime === 'string' && typeof part.name === 'string'
}
