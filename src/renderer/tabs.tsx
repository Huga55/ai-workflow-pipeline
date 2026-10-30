import { createContext, useContext, useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { routeKey, routeLabel, type Route } from './route'
import type { BrowserTab } from './tab-state'

const SetTabTitleContext = createContext<(title: string) => void>(() => {})
const TabActiveContext = createContext(true)
const OpenTabContext = createContext<(route: Route) => void>(() => {})

export function useTabTitle(title: string) {
  const setTitle = useContext(SetTabTitleContext)
  useEffect(() => {
    const next = title.trim()
    if (next) setTitle(next)
  }, [title, setTitle])
}

export function useTabActive() {
  return useContext(TabActiveContext)
}

export function useOpenTab() {
  return useContext(OpenTabContext)
}

export function TabProviders({
  active,
  onTitle,
  onOpen,
  children
}: {
  active: boolean
  onTitle: (title: string) => void
  onOpen: (route: Route) => void
  children: ReactNode
}) {
  return (
    <TabActiveContext.Provider value={active}>
      <SetTabTitleContext.Provider value={onTitle}>
        <OpenTabContext.Provider value={onOpen}>{children}</OpenTabContext.Provider>
      </SetTabTitleContext.Provider>
    </TabActiveContext.Provider>
  )
}

export function TabTitleReset({ route, onTitle }: { route: Route; onTitle: (title: string) => void }) {
  const key = routeKey(route)
  const label = useRef(routeLabel(route))
  label.current = routeLabel(route)
  useLayoutEffect(() => {
    onTitle(label.current)
  }, [key, onTitle])
  return null
}

export function navHandlers(here: () => void, tab: () => void) {
  return {
    onMouseDown(event: ReactMouseEvent) {
      if (event.button === 1) event.preventDefault()
    },
    onAuxClick(event: ReactMouseEvent) {
      if (event.button !== 1) return
      event.preventDefault()
      tab()
    },
    onClick(event: ReactMouseEvent) {
      if (event.button !== 0) return
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        tab()
        return
      }
      here()
    }
  }
}

export function TabBar({
  tabs,
  activeId,
  titles,
  onSelect,
  onClose,
  onNew
}: {
  tabs: BrowserTab<Route>[]
  activeId: string
  titles: Record<string, string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}) {
  const activeRef = useRef<HTMLDivElement>(null)
  const canClose = tabs.length > 1

  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId, tabs.length])

  return (
    <div className="tabstrip" role="tablist" aria-label="Вкладки">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        const label = titles[tab.id] || routeLabel(tab.route)
        return (
          <div
            key={tab.id}
            ref={active ? activeRef : undefined}
            id={`tab-${tab.id}`}
            className={active ? 'tab active' : 'tab'}
            role="tab"
            aria-selected={active}
            title={label}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault()
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              event.preventDefault()
              onClose(tab.id)
            }}
            onClick={() => onSelect(tab.id)}
          >
            <span className="tab-label">{label}</span>
            {canClose && (
              <button
                className="tab-close"
                type="button"
                aria-label={`Закрыть «${label}»`}
                title="Закрыть"
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
      <button className="tab-add" type="button" aria-label="Новая вкладка" title="Новая вкладка (Ctrl+T)" onClick={onNew}>
        +
      </button>
    </div>
  )
}
