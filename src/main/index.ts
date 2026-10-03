import { app, BrowserWindow, Menu, net, protocol } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodePath } from '@core/media'
import { AppDatabase } from './db'
import { registerIpc } from './ipc'
import { SecretStore } from './secrets'
import { AppService } from './service'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pipeline',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | null = null

function createWindow(): void {
  window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#141210',
    title: 'AI Workflow Pipeline',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Файл',
        submenu: [
          { label: 'Экспорт данных…', click: () => window?.webContents.send('app:export') },
          { label: 'Импорт данных…', click: () => window?.webContents.send('app:confirm-import') },
          { type: 'separator' },
          { label: 'Настройки', click: () => window?.webContents.send('app:settings') },
          { type: 'separator' },
          {
            label: 'Выход',
            accelerator: 'CommandOrControl+Q',
            click: () => window?.webContents.send('app:confirm-quit')
          }
        ]
      },
      {
        label: 'Правка',
        submenu: [
          { role: 'undo', label: 'Отменить' },
          { role: 'redo', label: 'Повторить' },
          { type: 'separator' },
          { role: 'cut', label: 'Вырезать' },
          { role: 'copy', label: 'Копировать' },
          { role: 'paste', label: 'Вставить' },
          { role: 'selectAll', label: 'Выделить всё' }
        ]
      },
      {
        label: 'Вид',
        submenu: [
          { role: 'reload', label: 'Обновить' },
          { role: 'toggleDevTools', label: 'Инструменты разработчика' }
        ]
      }
    ])
  )

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))

  window.on('closed', () => {
    window = null
  })
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const mediaDir = path.join(userData, 'media')
  mkdirSync(mediaDir, { recursive: true })
  const database = AppDatabase.open(path.join(userData, 'pipeline.sqlite'))
  const secrets = new SecretStore(path.join(userData, 'secrets.bin'))
  const service = new AppService(database, secrets, mediaDir, (runId) => {
    window?.webContents.send('run:updated', runId)
  })
  registerIpc(service, () => window)

  protocol.handle('pipeline', (request) => {
    const url = new URL(request.url)
    const encoded = decodeURIComponent(url.pathname.replace(/^\//, ''))
    let filePath = ''
    try {
      filePath = path.resolve(decodePath(encoded))
    } catch {
      return new Response('Bad path', { status: 400 })
    }
    const root = path.resolve(mediaDir)
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(filePath).href)
  })

  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
