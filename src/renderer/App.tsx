import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderStatus } from '@core/types'
import { ProjectPage } from './pages/ProjectPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { RunPage } from './pages/RunPage'
import { WorkflowPage } from './pages/WorkflowPage'
import type { Route } from './route'
import {
  closeBrowserTab,
  createBrowserTabs,
  jumpBrowserTab,
  moveBrowserTab,
  nextTabId,
  openBrowserTab,
  replaceBrowserRoute,
  selectBrowserTab,
  type BrowserTabs
} from './tab-state'
import { TabBar, TabProviders, TabTitleReset } from './tabs'
import { VariableEditor } from './variables'
import { errorText, installPlainPaste, Modal } from './ui'

export type { Route }

export function App() {
  const [browser, setBrowser] = useState<BrowserTabs<Route>>(() => createBrowserTabs({ name: 'projects' }, nextTabId()))
  const [titles, setTitles] = useState<Record<string, string>>({})
  const browserRef = useRef(browser)
  browserRef.current = browser
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
      setTitles({})
      setBrowser(createBrowserTabs({ name: 'projects' }, nextTabId()))
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

  const setTabTitle = useCallback((id: string, title: string) => {
    setTitles((prev) => (prev[id] === title ? prev : { ...prev, [id]: title }))
  }, [])

  const openTab = useCallback((route: Route) => {
    setBrowser((state) => openBrowserTab(state, route, nextTabId()))
  }, [])

  function closeTab(id: string) {
    const current = browserRef.current
    if (current.tabs.length <= 1 || !current.tabs.some((tab) => tab.id === id)) return
    setBrowser((state) => closeBrowserTab(state, id))
    setTitles((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  function go(id: string, route: Route) {
    setBrowser((state) => replaceBrowserRoute(state, id, route))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 't' && !event.shiftKey) {
        event.preventDefault()
        setBrowser((state) => openBrowserTab(state, { name: 'projects' }, nextTabId()))
        return
      }
      if (key === 'w' && !event.shiftKey) {
        event.preventDefault()
        const current = browserRef.current
        if (current.tabs.length <= 1) return
        const id = current.activeId
        setBrowser((state) => closeBrowserTab(state, id))
        setTitles((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        setBrowser((state) => moveBrowserTab(state, event.shiftKey ? -1 : 1))
        return
      }
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault()
        setBrowser((state) => jumpBrowserTab(state, event.key === '9' ? state.tabs.length - 1 : Number(event.key) - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => go(browser.activeId, { name: 'projects' })}>
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
      <TabBar
        tabs={browser.tabs}
        activeId={browser.activeId}
        titles={titles}
        onSelect={(id) => setBrowser((state) => selectBrowserTab(state, id))}
        onClose={closeTab}
        onNew={() => openTab({ name: 'projects' })}
      />
      <main className="stage" key={epoch}>
        {browser.tabs.map((tab) => (
          <TabPane
            key={tab.id}
            id={tab.id}
            route={tab.route}
            active={tab.id === browser.activeId}
            onRoute={(route) => go(tab.id, route)}
            onTitle={setTabTitle}
            onOpen={openTab}
            notify={setToast}
          />
        ))}
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

function TabPane({
  id,
  route,
  active,
  onRoute,
  onTitle,
  onOpen,
  notify
}: {
  id: string
  route: Route
  active: boolean
  onRoute: (route: Route) => void
  onTitle: (id: string, title: string) => void
  onOpen: (route: Route) => void
  notify: (message: string) => void
}) {
  const report = useCallback((title: string) => onTitle(id, title), [id, onTitle])
  return (
    <div className="tab-pane" hidden={!active} role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>
      <TabProviders active={active} onTitle={report} onOpen={onOpen}>
        <TabTitleReset route={route} onTitle={report} />
        <RouteView route={route} onRoute={onRoute} notify={notify} />
      </TabProviders>
    </div>
  )
}

function RouteView({
  route,
  onRoute,
  notify
}: {
  route: Route
  onRoute: (route: Route) => void
  notify: (message: string) => void
}) {
  return (
    <>
      {route.name === 'projects' && <ProjectsPage onOpen={(projectId) => onRoute({ name: 'project', projectId })} />}
      {route.name === 'project' && (
        <ProjectPage
          projectId={route.projectId}
          onBack={() => onRoute({ name: 'projects' })}
          onOpenWorkflow={(workflowId) => onRoute({ name: 'workflow', projectId: route.projectId, workflowId })}
          onOpenRun={(runId) => onRoute({ name: 'run', projectId: route.projectId, runId })}
        />
      )}
      {route.name === 'workflow' && (
        <WorkflowPage
          projectId={route.projectId}
          workflowId={route.workflowId}
          version={route.version}
          onBack={() => onRoute({ name: 'project', projectId: route.projectId })}
          onVersion={(version) => onRoute({ ...route, version })}
          onOpenRun={(runId) => onRoute({ name: 'run', projectId: route.projectId, runId })}
          notify={notify}
        />
      )}
      {route.name === 'run' && (
        <RunPage
          runId={route.runId}
          onBack={() => onRoute({ name: 'project', projectId: route.projectId })}
          onOpenWorkflow={(workflowId, version) => onRoute({ name: 'workflow', projectId: route.projectId, workflowId, version })}
          onOpenRun={(nextRunId) => onRoute({ name: 'run', projectId: route.projectId, runId: nextRunId })}
          notify={notify}
        />
      )}
    </>
  )
}

function Settings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [qwen, setQwen] = useState<'unknown' | 'checking' | 'in' | 'out'>('unknown')
  const [qwenToken, setQwenToken] = useState('')
  const [qwenRefresh, setQwenRefresh] = useState('')
  const [qwenSaved, setQwenSaved] = useState({ token: false, refreshToken: false })

  async function reload() {
    setStatus(await window.pipeline.getProviderStatus())
  }

  useEffect(() => {
    void reload().catch((reason) => setError(errorText(reason)))
    void window.pipeline
      .qwenTokenStatus()
      .then(setQwenSaved)
      .catch((reason) => setError(errorText(reason)))
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
      <h3 style={{ marginTop: 22 }}>Qwen</h3>
      <p>
        Аккаунт:{' '}
        <strong>{qwen === 'checking' ? 'проверяю…' : qwen === 'in' ? 'вошёл' : qwen === 'out' ? 'не вошёл' : 'не проверен'}</strong>
        {' · '}
        token: <strong>{qwenSaved.token ? 'сохранён' : 'не задан'}</strong>
        {' · '}
        refresh: <strong>{qwenSaved.refreshToken ? 'сохранён' : 'не задан'}</strong>
      </p>
      <label className="field">
        <span>Token</span>
        <input type="password" value={qwenToken} placeholder="кука token" onChange={(event) => setQwenToken(event.target.value)} />
      </label>
      <label className="field">
        <span>Refresh token</span>
        <input
          type="password"
          value={qwenRefresh}
          placeholder="кука refresh_token"
          onChange={(event) => setQwenRefresh(event.target.value)}
        />
      </label>
      <p className="meta">
        В своём Chrome: F12 → Application → Cookies → https://chat.qwen.ai. Нужны две куки: token и refresh_token. Одного token мало: он быстро протухает, и сайт снова показывает вход. Сохранение записывает их в окно Qwen. Уже открытый вход при следующем запуске не затирается.
      </p>
      <div className="row">
        <button
          className="btn"
          type="button"
          onClick={() => {
            setError(null)
            void window.pipeline
              .setQwenSession({ token: qwenToken, refreshToken: qwenRefresh })
              .then((result) => {
                setQwenToken('')
                setQwenRefresh('')
                setQwenSaved(result)
              })
              .catch((reason) => setError(errorText(reason)))
          }}
        >
          Сохранить
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            setError(null)
            void window.pipeline
              .clearQwenSession()
              .then((result) => {
                setQwenToken('')
                setQwenRefresh('')
                setQwenSaved(result)
              })
              .catch((reason) => setError(errorText(reason)))
          }}
        >
          Удалить
        </button>
      </div>
      <p className="meta">Проверка открывает обычное окно Chrome. Если Qwen показывает проверку, пройдите её в этом окне один раз. Если входа нет, войдите почтой Qwen: вход через Google в этом окне не проходит.</p>
      <button
        className="btn"
        type="button"
        disabled={qwen === 'checking'}
        onClick={() => {
          setQwen('checking')
          setError(null)
          void window.pipeline
            .connectQwen()
            .then((result) => setQwen(result.loggedIn ? 'in' : 'out'))
            .catch((reason) => {
              setQwen('out')
              setError(errorText(reason))
            })
        }}
      >
        Проверить и войти
      </button>
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
