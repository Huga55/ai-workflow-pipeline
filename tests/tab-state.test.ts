import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  closeBrowserTab,
  createBrowserTabs,
  jumpBrowserTab,
  moveBrowserTab,
  openBrowserTab,
  replaceBrowserRoute
} from '../src/renderer/tab-state.ts'

const home = { name: 'projects' as const }

describe('вкладки', () => {
  it('открывает новую и делает её активной', () => {
    const next = openBrowserTab(createBrowserTabs(home, 'a'), { name: 'project', projectId: 'p' }, 'b')
    assert.deepEqual(next.tabs.map((tab) => tab.id), ['a', 'b'])
    assert.equal(next.activeId, 'b')
    assert.deepEqual(next.tabs[1].route, { name: 'project', projectId: 'p' })
  })

  it('не закрывает единственную вкладку', () => {
    const state = createBrowserTabs(home, 'a')
    assert.equal(closeBrowserTab(state, 'a'), state)
  })

  it('после закрытия активной выбирает соседнюю справа, а у последней — слева', () => {
    const state = openBrowserTab(openBrowserTab(createBrowserTabs(home, 'a'), home, 'b'), home, 'c')
    const closedMiddle = closeBrowserTab({ ...state, activeId: 'b' }, 'b')
    assert.deepEqual(closedMiddle.tabs.map((tab) => tab.id), ['a', 'c'])
    assert.equal(closedMiddle.activeId, 'c')
    const closedTail = closeBrowserTab(state, 'c')
    assert.deepEqual(closedTail.tabs.map((tab) => tab.id), ['a', 'b'])
    assert.equal(closedTail.activeId, 'b')
  })

  it('закрытие неактивной не меняет текущую', () => {
    const state = openBrowserTab(createBrowserTabs(home, 'a'), home, 'b')
    const next = closeBrowserTab(state, 'a')
    assert.deepEqual(next.tabs.map((tab) => tab.id), ['b'])
    assert.equal(next.activeId, 'b')
  })

  it('листает по кругу и прыгает на вкладку', () => {
    const state = openBrowserTab(openBrowserTab(createBrowserTabs(home, 'a'), home, 'b'), home, 'c')
    const onFirst = { ...state, activeId: 'a' }
    assert.equal(moveBrowserTab(onFirst, -1).activeId, 'c')
    assert.equal(moveBrowserTab(state, 1).activeId, 'a')
    assert.equal(jumpBrowserTab(state, 0).activeId, 'a')
    assert.equal(jumpBrowserTab(onFirst, onFirst.tabs.length - 1).activeId, 'c')
  })

  it('меняет маршрут только у своей вкладки', () => {
    const state = openBrowserTab(createBrowserTabs(home, 'a'), home, 'b')
    const next = replaceBrowserRoute(state, 'a', { name: 'run', projectId: 'p', runId: 'r' })
    assert.equal(next.activeId, 'b')
    assert.deepEqual(next.tabs[0].route, { name: 'run', projectId: 'p', runId: 'r' })
    assert.deepEqual(next.tabs[1].route, home)
  })
})
