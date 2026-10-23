import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { pathsFromUriList } from '@core/clipboard-files'
import type { RunStepOptions, UserActionPayload, WorkflowGraph } from '@core/types'
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
  ipcMain.handle('resetRun', (_event, runId: string) => service.resetRun(runId))
  ipcMain.handle('getRun', (_event, runId: string) => service.getRun(runId))
  ipcMain.handle('updateRunInputs', (_event, runId: string, inputs: Record<string, unknown>) => service.updateRunInputs(runId, inputs))
  ipcMain.handle('updateRunTitle', (_event, runId: string, title: string) => service.updateRunTitle(runId, title))
  ipcMain.handle('setRunVersion', (_event, runId: string, versionNumber: number) => service.setRunVersion(runId, versionNumber))
  ipcMain.handle('startRun', (_event, runId: string, options?: { untilStepId?: string }) => service.startRun(runId, options))
  ipcMain.handle(
    'continueRun',
    (_event, runId: string, options?: { branchId?: string; untilStepId?: string; startManualBranches?: boolean; note?: string }) =>
      service.continueRun(runId, options)
  )
  ipcMain.handle('retryStep', (_event, runId: string, stepId: string, branchId: string) => service.retryStep(runId, stepId, branchId))
  ipcMain.handle(
    'runStep',
    (_event, runId: string, stepId: string, branchId: string, mode: 'only' | 'chain', options?: RunStepOptions) =>
      service.runStep(runId, stepId, branchId, mode, options)
  )
  ipcMain.handle('skipStep', (_event, runId: string, stepId: string, branchId: string) => service.skipStep(runId, stepId, branchId))
  ipcMain.handle('repairStepJson', (_event, runId: string, stepId: string, branchId: string) =>
    service.repairStepJson(runId, stepId, branchId)
  )
  ipcMain.handle(
    'acceptManualAnswer',
    (_event, runId: string, stepId: string, branchId: string, text: string, continueAfter?: boolean) =>
      service.acceptManualAnswer(runId, stepId, branchId, text, continueAfter)
  )
  ipcMain.handle('listVariables', (_event, scope: 'global' | 'project', projectId?: string) => service.listVariables(scope, projectId))
  ipcMain.handle(
    'saveVariable',
    (
      _event,
      input: { scope: 'global' | 'project'; projectId?: string; name: string; label: string; value: unknown; description?: string }
    ) => service.saveVariable(input)
  )
  ipcMain.handle('updateVariable', (_event, input: { id: string; name: string; label: string }) => service.updateVariable(input))
  ipcMain.handle(
    'addVariableVersion',
    (_event, input: { id: string; value: unknown; description?: string }) => service.addVariableVersion(input)
  )
  ipcMain.handle('updateVariableVersion', (_event, input: { id: string; description: string }) => service.updateVariableVersion(input))
  ipcMain.handle('deleteVariableVersion', (_event, id: string) => service.deleteVariableVersion(id))
  ipcMain.handle('deleteVariable', (_event, id: string) => service.deleteVariable(id))
  ipcMain.handle('submitUserAction', (_event, runId: string, executionId: string, payload: UserActionPayload) =>
    service.submitUserAction(runId, executionId, payload)
  )
  ipcMain.handle('cancelRun', (_event, runId: string) => service.cancelRun(runId))
  ipcMain.handle('getProviderStatus', () => service.getProviderStatus())
  ipcMain.handle('setProviderKey', (_event, providerId: string, apiKey: string) => service.setProviderKey(providerId, apiKey))
  ipcMain.handle('clearProviderKey', (_event, providerId: string) => service.clearProviderKey(providerId))
  ipcMain.handle('connectQwen', () => service.connectQwen())
  ipcMain.handle('qwenTokenStatus', () => service.qwenTokenStatus())
  ipcMain.handle('setQwenSession', (_event, input: { token?: string; refreshToken?: string }) => service.setQwenSession(input))
  ipcMain.handle('clearQwenSession', () => service.clearQwenSession())
  ipcMain.handle('pickFiles', async (_event, kind: 'image' | 'file' | 'auto', multiple: boolean) => {
    const win = getWindow()
    const options = {
      properties: multiple ? ['openFile' as const, 'multiSelections' as const] : ['openFile' as const],
      filters: kind === 'image' ? [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] : undefined
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return service.storePickedFiles(result.filePaths, kind)
  })
  ipcMain.handle('storeMedia', (_event, items: { name: string; mime: string; bytes: Uint8Array; kind: 'image' | 'file' }[]) =>
    service.storeMedia(items)
  )
  ipcMain.handle('pasteMedia', (_event, accept: 'image' | 'file' | 'any') => pasteClipboardMedia(service, accept))
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

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

async function pasteClipboardMedia(service: AppService, accept: 'image' | 'file' | 'any') {
  const items = await clipboard.read()
  const paths: string[] = []
  const images: { mime: string; bytes: Uint8Array }[] = []
  for (const item of items) {
    for (const type of item.types) {
      const payload = await clipboardPayload(item, type)
      if (!payload) continue
      if (isFileListType(type)) {
        paths.push(...droppedPaths(Buffer.from(payload.bytes), type.toLowerCase().includes('filenamew') ? 0 : -1, type.toLowerCase().includes('filenamew')))
        continue
      }
      if (type === 'text/uri-list' || type === 'public.file-url') {
        paths.push(...pathsFromUriList(payload.text).filter((filePath) => existsSync(filePath)))
        continue
      }
      if (!looksLikeImage(type, payload.bytes)) continue
      const mime = imageMime(type, payload.bytes)
      images.push({ mime, bytes: payload.bytes })
    }
  }
  const found = [...new Set(paths)]
  const picked = found.filter((filePath) => accept !== 'image' || IMAGE_EXT.has(path.extname(filePath).toLowerCase()))
  if (picked.length) return service.storePickedFiles(picked, accept === 'any' ? 'auto' : accept)
  const image = images.find((item) => item.mime === 'image/png') ?? images[0]
  if (!image) return []
  const ext = image.mime === 'image/jpeg' ? 'jpg' : image.mime === 'image/webp' ? 'webp' : image.mime === 'image/gif' ? 'gif' : 'png'
  return service.storeMedia([
    {
      name: `clipboard.${ext}`,
      mime: image.mime,
      bytes: image.bytes,
      kind: accept === 'file' ? 'file' : 'image'
    }
  ])
}

async function clipboardPayload(item: Electron.ClipboardItem, type: string): Promise<{ bytes: Uint8Array; text: string } | null> {
  try {
    const payload = await item.getType(type)
    if (typeof payload === 'string') return { bytes: new TextEncoder().encode(payload), text: payload }
    if (!payload || typeof payload !== 'object' || !('arrayBuffer' in payload) || typeof payload.arrayBuffer !== 'function') return null
    const bytes = new Uint8Array(await payload.arrayBuffer())
    const text = 'text' in payload && typeof payload.text === 'function' ? await payload.text() : new TextDecoder().decode(bytes)
    return { bytes, text }
  } catch {
    return null
  }
}

function isFileListType(type: string): boolean {
  const lower = type.toLowerCase()
  return lower.includes('cf_hdrop') || lower.includes('filenamew')
}

function looksLikeImage(type: string, bytes: Uint8Array): boolean {
  const lower = type.toLowerCase()
  if (lower.startsWith('image/')) return true
  if (!/png|jpe?g|gif|webp|bmp/.test(lower)) return false
  return isPng(bytes) || isJpeg(bytes) || isGif(bytes)
}

function imageMime(type: string, bytes: Uint8Array): string {
  if (type.toLowerCase().startsWith('image/')) return type === 'image/jpg' ? 'image/jpeg' : type
  if (isJpeg(bytes)) return 'image/jpeg'
  if (isGif(bytes)) return 'image/gif'
  return 'image/png'
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8
}

function isGif(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
}

function droppedPaths(buffer: Buffer, offset = -1, wide = false): string[] {
  if (!buffer.length) return []
  let start = offset
  let isWide = wide
  if (start < 0) {
    if (buffer.length < 20) return []
    start = buffer.readUInt32LE(0)
    isWide = buffer.readUInt32LE(16) !== 0
  }
  if (start < 0 || start >= buffer.length) return []
  const text = buffer.slice(start).toString(isWide ? 'utf16le' : 'utf8')
  return text
    .split('\u0000')
    .map((item) => item.trim())
    .filter((item) => item && existsSync(item))
}

function importDialogOptions() {
  return {
    title: 'Импорт данных',
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: 'Файл Pipeline', extensions: ['pipeline', 'json'] }]
  }
}
