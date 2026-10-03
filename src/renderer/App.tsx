import { useEffect, useState } from 'react'
import type { ProviderStatus } from '@core/types'
import { ProjectPage } from './pages/ProjectPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { RunPage } from './pages/RunPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { VariableEditor } from './variables'
import { errorText, installPlainPaste, Modal } from './ui'

export type Route =
  | { name: 'projects' }
  | { name: 'project'; projectId: string }
  | { name: 'workflow'; projectId: string; workflowId: string; version?: number }
  | { name: 'run'; projectId: string; runId: string }

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'projects' })
  const [settings, setSettings] = useState(false)
  const [quitAsk, setQuitAsk] = useState(false)
  const [importAsk, setImportAsk] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  async function exportData() {
    try {
      const result = await window.pipeline.exportData()
      if (result.canceled) return
      setToast(`Сохранено: ${result.projects} проектов, ${result.workflows} workflow, ${result.runs} запусков`)
    } catch (reason) {
      setToast(errorText(reason))
    }
  }

  async function importData() {
    setImportAsk(false)
    try {
      const result = await window.pipeline.importData()
      if (result.canceled) return
      setEpoch((value) => value + 1)
      setRoute({ name: 'projects' })
      setToast(`Импортировано: ${result.projects} проектов, ${result.workflows} workflow, ${result.runs} запусков`)
    } catch (reason) {
      setToast(errorText(reason))
    }
  }

  useEffect(() => {
    return window.pipeline.onOpenSettings(() => setSettings(true))
  }, [])

  useEffect(() => {
    if (typeof window.pipeline.onConfirmQuit !== 'function') return
    return window.pipeline.onConfirmQuit(() => setQuitAsk(true))
  }, [])

  useEffect(() => {
    if (typeof window.pipeline.onExportData !== 'function') return
    return window.pipeline.onExportData(() => {
      void exportData()
    })
  }, [])

  useEffect(() => {
    if (typeof window.pipeline.onConfirmImport !== 'function') return
    return window.pipeline.onConfirmImport(() => setImportAsk(true))
  }, [])

  useEffect(() => installPlainPaste(), [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setRoute({ name: 'projects' })}>
          <strong>Pipeline</strong>
          <span>Сборка AI-workflow</span>
        </button>
        <div className="top-actions">
          <button className="ghost" type="button" onClick={() => void exportData()}>
            Экспорт
          </button>
          <button className="ghost" type="button" onClick={() => setImportAsk(true)}>
            Импорт
          </button>
          <button className="ghost" type="button" onClick={() => setSettings(true)}>
            Настройки
          </button>
        </div>
      </header>
      <main className="stage" key={epoch}>
        {route.name === 'projects' && <ProjectsPage onOpen={(projectId) => setRoute({ name: 'project', projectId })} />}
        {route.name === 'project' && (
          <ProjectPage
            projectId={route.projectId}
            onBack={() => setRoute({ name: 'projects' })}
            onOpenWorkflow={(workflowId) => setRoute({ name: 'workflow', projectId: route.projectId, workflowId })}
            onOpenRun={(runId) => setRoute({ name: 'run', projectId: route.projectId, runId })}
          />
        )}
        {route.name === 'workflow' && (
          <WorkflowPage
            projectId={route.projectId}
            workflowId={route.workflowId}
            version={route.version}
            onBack={() => setRoute({ name: 'project', projectId: route.projectId })}
            onVersion={(version) => setRoute({ ...route, version })}
            onOpenRun={(runId) => setRoute({ name: 'run', projectId: route.projectId, runId })}
            notify={setToast}
          />
        )}
        {route.name === 'run' && (
          <RunPage
            runId={route.runId}
            onBack={() => setRoute({ name: 'project', projectId: route.projectId })}
            onOpenWorkflow={(workflowId, version) => setRoute({ name: 'workflow', projectId: route.projectId, workflowId, version })}
            onOpenRun={(nextRunId) => setRoute({ name: 'run', projectId: route.projectId, runId: nextRunId })}
            notify={setToast}
          />
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
      {settings && <Settings onClose={() => setSettings(false)} />}
      {importAsk && (
        <Modal title="Импорт данных" onClose={() => setImportAsk(false)}>
          <p className="lede">
            Файл добавит проекты, workflow, запуски, переменные, файлы и ключи провайдеров. Записи с теми же id будут заменены.
            Остальные текущие данные останутся.
          </p>
          <div className="row">
            <button className="btn" type="button" onClick={() => void importData()}>
              Выбрать файл
            </button>
            <button className="ghost" type="button" onClick={() => setImportAsk(false)}>
              Отмена
            </button>
          </div>
        </Modal>
      )}
      {quitAsk && (
        <Modal title="Выход" onClose={() => setQuitAsk(false)}>
          <p className="lede">Выйти из приложения?</p>
          <div className="row">
            <button className="danger" type="button" onClick={() => void window.pipeline.quit()}>
              Выйти
            </button>
            <button className="btn" type="button" onClick={() => setQuitAsk(false)}>
              Остаться
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Settings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setStatus(await window.pipeline.getProviderStatus())
  }

  useEffect(() => {
    void reload().catch((reason) => setError(errorText(reason)))
  }, [])

  const openai = status?.providers.find((item) => item.id === 'openai')

  return (
    <Modal title="Провайдеры" onClose={onClose}>
      <p className="lede">Ключ хранится в main-процессе и не попадает в интерфейс обратно.</p>
      {error && <div className="error">{error}</div>}
      <p>
        OpenAI: <StatusWord connected={openai?.connected} />
      </p>
      <label className="field">
        <span>API-ключ OpenAI</span>
        <input type="password" value={key} placeholder="sk-..." onChange={(event) => setKey(event.target.value)} />
      </label>
      <div className="row">
        <button
          className="btn"
          type="button"
          onClick={() => {
            void window.pipeline
              .setProviderKey('openai', key)
              .then((next) => {
                setStatus(next)
                setKey('')
              })
              .catch((reason) => setError(errorText(reason)))
          }}
        >
          Сохранить ключ
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            void window.pipeline.clearProviderKey('openai').then(setStatus).catch((reason) => setError(errorText(reason)))
          }}
        >
          Удалить
        </button>
      </div>
      <h3 style={{ marginTop: 22 }}>Глобальные переменные</h3>
      <p className="meta">Доступны в любом проекте как {'{{globals.имя}}'}.</p>
      <VariableEditor scope="global" />
      <div className="section-label">Дальше без смены движка</div>
      {status?.providers
        .filter((item) => item.id !== 'openai')
        .map((item) => (
          <p key={item.id} className="meta">
            {item.label}: интерфейс провайдера готов, вызов ещё не подключён
          </p>
        ))}
    </Modal>
  )
}

function StatusWord({ connected }: { connected?: boolean }) {
  return <strong>{connected ? 'подключён' : 'нет ключа'}</strong>
}
