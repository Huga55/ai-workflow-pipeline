import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { UserActionPayload, WorkflowGraph } from '@core/types'
import type { AppService } from './service'

export function registerIpc(service: AppService, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('listProjects', () => service.listProjects())
  ipcMain.handle('createProject', (_event, input: { name: string; description?: string }) => service.createProject(input))
  ipcMain.handle('updateProject', (_event, id: string, patch: { name?: string; description?: string }) => service.updateProject(id, patch))
  ipcMain.handle('deleteProject', (_event, id: string) => service.deleteProject(id))
  ipcMain.handle('listWorkflows', (_event, projectId: string) => service.listWorkflows(projectId))
  ipcMain.handle('createWorkflow', (_event, projectId: string, input: { name: string; description?: string }) =>
    service.createWorkflow(projectId, input)
  )
  ipcMain.handle('createWorkflowFromTemplate', (_event, projectId: string, templateId: 'neurophoto') =>
    service.createWorkflowFromTemplate(projectId, templateId)
  )
  ipcMain.handle('getWorkflow', (_event, id: string, version?: number) => service.getWorkflow(id, version))
  ipcMain.handle(
    'saveWorkflow',
    (_event, id: string, input: { name: string; description: string; graph: WorkflowGraph }) => service.saveWorkflow(id, input)
  )
  ipcMain.handle('getDraft', (_event, id: string) => service.getDraft(id))
  ipcMain.handle(
    'saveDraft',
    (
      _event,
      id: string,
      input: { name: string; description: string; graph: WorkflowGraph; selectedId: string | null }
    ) => service.saveDraft(id, input)
  )
  ipcMain.on(
    'saveDraftNow',
    (
      event,
      id: string,
      input: { name: string; description: string; graph: WorkflowGraph; selectedId: string | null }
    ) => {
      service.saveDraft(id, input)
      event.returnValue = null
    }
  )
  ipcMain.handle('deleteWorkflow', (_event, id: string) => service.deleteWorkflow(id))
  ipcMain.handle('listRuns', (_event, projectId: string) => service.listRuns(projectId))
  ipcMain.handle('deleteRun', (_event, runId: string) => service.deleteRun(runId))
  ipcMain.handle('createRun', (_event, workflowId: string) => service.createRun(workflowId))
  ipcMain.handle('duplicateRun', (_event, runId: string) => service.duplicateRun(runId))
  ipcMain.handle('getRun', (_event, runId: string) => service.getRun(runId))
  ipcMain.handle('updateRunInputs', (_event, runId: string, inputs: Record<string, unknown>) => service.updateRunInputs(runId, inputs))
  ipcMain.handle('updateRunTitle', (_event, runId: string, title: string) => service.updateRunTitle(runId, title))
  ipcMain.handle('startRun', (_event, runId: string, options?: { untilStepId?: string }) => service.startRun(runId, options))
  ipcMain.handle(
    'continueRun',
    (_event, runId: string, options?: { branchId?: string; untilStepId?: string; startManualBranches?: boolean }) =>
      service.continueRun(runId, options)
  )
  ipcMain.handle('retryStep', (_event, runId: string, stepId: string, branchId: string) => service.retryStep(runId, stepId, branchId))
  ipcMain.handle('runStep', (_event, runId: string, stepId: string, branchId: string, mode: 'only' | 'chain') =>
    service.runStep(runId, stepId, branchId, mode)
  )
  ipcMain.handle('skipStep', (_event, runId: string, stepId: string, branchId: string) => service.skipStep(runId, stepId, branchId))
  ipcMain.handle('listVariables', (_event, scope: 'global' | 'project', projectId?: string) => service.listVariables(scope, projectId))
  ipcMain.handle(
    'saveVariable',
    (
      _event,
      input: { scope: 'global' | 'project'; projectId?: string; name: string; label: string; value: unknown }
    ) => service.saveVariable(input)
  )
  ipcMain.handle('deleteVariable', (_event, id: string) => service.deleteVariable(id))
  ipcMain.handle('submitUserAction', (_event, runId: string, executionId: string, payload: UserActionPayload) =>
    service.submitUserAction(runId, executionId, payload)
  )
  ipcMain.handle('cancelRun', (_event, runId: string) => service.cancelRun(runId))
  ipcMain.handle('getProviderStatus', () => service.getProviderStatus())
  ipcMain.handle('setProviderKey', (_event, providerId: string, apiKey: string) => service.setProviderKey(providerId, apiKey))
  ipcMain.handle('clearProviderKey', (_event, providerId: string) => service.clearProviderKey(providerId))
  ipcMain.handle('pickFiles', async (_event, kind: 'image' | 'file', multiple: boolean) => {
    const win = getWindow()
    const options = {
      properties: multiple ? ['openFile' as const, 'multiSelections' as const] : ['openFile' as const],
      filters: kind === 'image' ? [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] : undefined
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return service.storePickedFiles(result.filePaths, kind)
  })
  ipcMain.handle('quitApp', () => {
    app.quit()
  })
  ipcMain.handle('exportData', async () => {
    const win = getWindow()
    const result = win
      ? await dialog.showSaveDialog(win, exportDialogOptions())
      : await dialog.showSaveDialog(exportDialogOptions())
    if (result.canceled || !result.filePath) return { canceled: true }
    const filePath = result.filePath.endsWith('.pipeline') ? result.filePath : `${result.filePath}.pipeline`
    return { canceled: false, filePath, ...service.exportBundle(filePath) }
  })
  ipcMain.handle('importData', async () => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, importDialogOptions())
      : await dialog.showOpenDialog(importDialogOptions())
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const filePath = result.filePaths[0]
    return { canceled: false, filePath, ...service.importBundle(filePath) }
  })
}

function exportDialogOptions() {
  const day = new Date().toISOString().slice(0, 10)
  return {
    title: 'Экспорт данных',
    defaultPath: `pipeline-${day}.pipeline`,
    filters: [{ name: 'Файл Pipeline', extensions: ['pipeline'] }]
  }
}

function importDialogOptions() {
  return {
    title: 'Импорт данных',
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: 'Файл Pipeline', extensions: ['pipeline', 'json'] }]
  }
}
