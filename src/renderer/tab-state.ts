export type BrowserTab<T> = {
  id: string
  route: T
}

export type BrowserTabs<T> = {
  tabs: BrowserTab<T>[]
  activeId: string
}

export function nextTabId(): string {
  return crypto.randomUUID()
}

export function createBrowserTabs<T>(route: T, id: string): BrowserTabs<T> {
  return { tabs: [{ id, route }], activeId: id }
}

export function openBrowserTab<T>(state: BrowserTabs<T>, route: T, id: string): BrowserTabs<T> {
  return { tabs: [...state.tabs, { id, route }], activeId: id }
}

export function closeBrowserTab<T>(state: BrowserTabs<T>, id: string): BrowserTabs<T> {
  if (state.tabs.length <= 1) return state
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  const activeId = state.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId
  return { tabs, activeId }
}

export function selectBrowserTab<T>(state: BrowserTabs<T>, id: string): BrowserTabs<T> {
  if (!state.tabs.some((tab) => tab.id === id) || state.activeId === id) return state
  return { ...state, activeId: id }
}

export function moveBrowserTab<T>(state: BrowserTabs<T>, delta: number): BrowserTabs<T> {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId)
  if (index < 0 || state.tabs.length < 2) return state
  const next = (index + delta + state.tabs.length) % state.tabs.length
  return { ...state, activeId: state.tabs[next].id }
}

export function jumpBrowserTab<T>(state: BrowserTabs<T>, index: number): BrowserTabs<T> {
  const tab = state.tabs[index]
  if (!tab || tab.id === state.activeId) return state
  return { ...state, activeId: tab.id }
}

export function replaceBrowserRoute<T>(state: BrowserTabs<T>, id: string, route: T): BrowserTabs<T> {
  if (!state.tabs.some((tab) => tab.id === id)) return state
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, route } : tab)) }
}
