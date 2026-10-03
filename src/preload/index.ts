import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PipelineApi } from '@core/api'
import type { UserActionPayload, WorkflowGraph } from '@core/types'

const api: PipelineApi = {
  listProjects: () => ipcRenderer.invoke('listProjects'),
  createProject: (input) => ipcRenderer.invoke('createProject', input),
  updateProject: (id, patch) => ipcRenderer.invoke('updateProject', id, patch),
  deleteProject: (id) => ipcRenderer.invoke('deleteProject', id),
  listWorkflows: (projectId) => ipcRenderer.invoke('listWorkflows', projectId),
  createWorkflow: (projectId, input) => ipcRenderer.invoke('createWorkflow', projectId, input),
  createWorkflowFromTemplate: (projectId, templateId) => ipcRenderer.invoke('createWorkflowFromTemplate', projectId, templateId),
  getWorkflow: (id, version) => ipcRenderer.invoke('getWorkflow', id, version),
  saveWorkflow: (id, input: { name: string; description: string; graph: WorkflowGraph }) => ipcRenderer.invoke('saveWorkflow', id, input),
  getDraft: (id) => ipcRenderer.invoke('getDraft', id),
  saveDraft: (id, input) => ipcRenderer.invoke('saveDraft', id, input),
  saveDraftNow: (id, input) => ipcRenderer.sendSync('saveDraftNow', id, input),
  deleteWorkflow: (id) => ipcRenderer.invoke('deleteWorkflow', id),
  listRuns: (projectId) => ipcRenderer.invoke('listRuns', projectId),
  deleteRun: (runId) => ipcRenderer.invoke('deleteRun', runId),
  createRun: (workflowId) => ipcRenderer.invoke('createRun', workflowId),
  duplicateRun: (runId) => ipcRenderer.invoke('duplicateRun', runId),
  getRun: (runId) => ipcRenderer.invoke('getRun', runId),
  updateRunInputs: (runId, inputs) => ipcRenderer.invoke('updateRunInputs', runId, inputs),
  updateRunTitle: (runId, title) => ipcRenderer.invoke('updateRunTitle', runId, title),
  startRun: (runId, options) => ipcRenderer.invoke('startRun', runId, options),
  continueRun: (runId, options) => ipcRenderer.invoke('continueRun', runId, options),
  retryStep: (runId, stepId, branchId) => ipcRenderer.invoke('retryStep', runId, stepId, branchId),
  runStep: (runId, stepId, branchId, mode) => ipcRenderer.invoke('runStep', runId, stepId, branchId, mode),
  skipStep: (runId, stepId, branchId) => ipcRenderer.invoke('skipStep', runId, stepId, branchId),
  listVariables: (scope, projectId) => ipcRenderer.invoke('listVariables', scope, projectId),
  saveVariable: (input) => ipcRenderer.invoke('saveVariable', input),
  deleteVariable: (id) => ipcRenderer.invoke('deleteVariable', id),
  submitUserAction: (runId, executionId, payload: UserActionPayload) => ipcRenderer.invoke('submitUserAction', runId, executionId, payload),
  cancelRun: (runId) => ipcRenderer.invoke('cancelRun', runId),
  pickFiles: (kind, multiple) => ipcRenderer.invoke('pickFiles', kind, multiple),
  getProviderStatus: () => ipcRenderer.invoke('getProviderStatus'),
  setProviderKey: (providerId, apiKey) => ipcRenderer.invoke('setProviderKey', providerId, apiKey),
  clearProviderKey: (providerId) => ipcRenderer.invoke('clearProviderKey', providerId),
  onRunUpdated: (callback) => {
    const listener = (_event: IpcRendererEvent, runId: string) => callback(runId)
    ipcRenderer.on('run:updated', listener)
    return () => ipcRenderer.removeListener('run:updated', listener)
  },
  quit: () => ipcRenderer.invoke('quitApp'),
  exportData: () => ipcRenderer.invoke('exportData'),
  importData: () => ipcRenderer.invoke('importData'),
  onOpenSettings: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:settings', listener)
    return () => ipcRenderer.removeListener('app:settings', listener)
  },
  onConfirmQuit: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:confirm-quit', listener)
    return () => ipcRenderer.removeListener('app:confirm-quit', listener)
  },
  onExportData: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:export', listener)
    return () => ipcRenderer.removeListener('app:export', listener)
  },
  onConfirmImport: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:confirm-import', listener)
    return () => ipcRenderer.removeListener('app:confirm-import', listener)
  }
}

contextBridge.exposeInMainWorld('pipeline', api)
