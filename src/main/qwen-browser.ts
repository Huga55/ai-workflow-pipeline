import { existsSync, mkdirSync } from 'node:fs'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { stitchChunks, stripCodeGutter } from '@core/json'
import type { ContentPart } from '@core/types'

const CHAT_URL = 'https://chat.qwen.ai/'
const COMPOSER_SELECTORS = ['#chat-input', 'textarea.message-input-textarea', 'textarea', '[role="textbox"]']
const SEND_SELECTORS = [
  '#send-message-button',
  '.message-input-right-button-send',
  'button[aria-label="发送消息"]',
  'button[aria-label="Send"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Отправить"]'
]

export type QwenTurn = {
  runId: string
  chatKey: string
  branchId: string
  parts: ContentPart[]
  signal?: AbortSignal
}

export class QwenBrowser {
  private context: BrowserContext | null = null
  private slots = new Map<string, Page>()
  private authPage: Page | null = null
  private tail: Promise<void> = Promise.resolve()
  private storageScript = false
  private preferSavedSession = false

  constructor(
    private profileDir: string,
    private loadUrl: (runId: string, chatKey: string, branchId: string) => string | null,
    private saveUrl: (runId: string, chatKey: string, branchId: string, url: string) => void,
    private readSession: () => { token: string | null; refreshToken: string | null }
  ) {}

  async ensure(turn: QwenTurn): Promise<string | null> {
    return this.enqueue(async () => {
      await this.keepRun(turn.runId)
      return this.ensureSlot(turn)
    })
  }

  async ask(turn: QwenTurn): Promise<string> {
    return this.enqueue(async () => {
      let page = await this.readyPage(turn)
      if (!page) {
        const saved = durableChatUrl(this.loadUrl(turn.runId, turn.chatKey, turn.branchId))
        if (!saved) throw closedChatError(turn.chatKey, null)
        await this.ensureSlot(turn)
        page = await this.readyPage(turn)
      }
      if (!page) throw closedChatError(turn.chatKey, this.loadUrl(turn.runId, turn.chatKey, turn.branchId))
      const answer = await deliver(page, turn.parts, turn.signal)
      this.remember(turn, page)
      return answer
    })
  }

  async connect(): Promise<{ loggedIn: boolean }> {
    return this.enqueue(() => this.connectAccount())
  }

  async applySession(): Promise<void> {
    return this.enqueue(async () => {
      this.preferSavedSession = true
      if (!this.contextOpen()) return
      await this.installSession(this.context!, 'replace')
      this.preferSavedSession = false
    })
  }

  async close(): Promise<void> {
    await this.dropContext()
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async connectAccount(): Promise<{ loggedIn: boolean }> {
    const page = await this.accountPage()
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.bringToFront().catch(() => undefined)
    await dismissCookies(page)
    await waitForShell(page)
    if (await isLoggedIn(page)) {
      await this.closeAuthPage()
      return { loggedIn: true }
    }
    const login = page.getByRole('button', { name: /^(log in|войти)$/i })
    if (await login.count()) await login.first().click()
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000)
      const shell = await page.locator('textarea.message-input-textarea, .header-right-auth-button').count()
      if (shell === 0) continue
      if (await isLoggedIn(page)) {
        await this.closeAuthPage()
        return { loggedIn: true }
      }
    }
    return { loggedIn: false }
  }

  private async accountPage(): Promise<Page> {
    if (pageOpen(this.authPage)) return this.authPage
    const page = await this.freshPage()
    this.authPage = page
    return page
  }

  private async closeAuthPage(): Promise<void> {
    const page = this.authPage
    this.authPage = null
    if (pageOpen(page)) await page.close().catch(() => undefined)
  }

  private async readyPage(turn: QwenTurn): Promise<Page | null> {
    const id = slotId(turn)
    const saved = durableChatUrl(this.loadUrl(turn.runId, turn.chatKey, turn.branchId))
    const savedId = chatIdFromUrl(saved)
    let page = this.slots.get(id)
    if (!pageOpen(page) && savedId && this.contextOpen()) {
      const found = this.context!.pages().find((item) => pageOpen(item) && chatIdFromUrl(item.url()) === savedId)
      if (found) {
        this.slots.set(id, found)
        page = found
      }
    }
    if (!pageOpen(page)) return null
    if (saved && chatIdFromUrl(page.url()) !== savedId) {
      await page.goto(saved, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await dismissCookies(page)
      await waitForComposer(page, turn.signal)
    }
    return page
  }

  private async ensureSlot(turn: QwenTurn): Promise<string | null> {
    throwIfAborted(turn.signal)
    if (await this.readyPage(turn)) return null
    const id = slotId(turn)
    const saved = durableChatUrl(this.loadUrl(turn.runId, turn.chatKey, turn.branchId))
    const page = await this.freshPage()
    this.slots.set(id, page)
    if (saved) {
      await page.goto(saved, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await dismissCookies(page)
      await waitForComposer(page, turn.signal)
      return null
    }
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await dismissCookies(page)
    await waitForComposer(page, turn.signal)
    const answer = await deliver(page, turn.parts, turn.signal)
    const url = durableChatUrl(page.url())
    if (url) this.saveUrl(turn.runId, turn.chatKey, turn.branchId, url)
    return answer
  }

  private remember(turn: QwenTurn, page: Page): void {
    const url = durableChatUrl(page.url())
    if (url) this.saveUrl(turn.runId, turn.chatKey, turn.branchId, url)
  }

  private async freshPage(): Promise<Page> {
    const context = await this.browser()
    const blank = context.pages().find((page) => pageOpen(page) && (page.url() === 'about:blank' || page.url() === ''))
    const page = blank ?? (await context.newPage())
    page.setDefaultTimeout(30_000)
    return page
  }

  private async keepRun(runId: string): Promise<void> {
    for (const [id, page] of this.slots) {
      if (id.startsWith(`${runId}\n`)) continue
      this.slots.delete(id)
      if (pageOpen(page)) await page.close().catch(() => undefined)
    }
  }

  private async tidyStartupPages(context: BrowserContext): Promise<void> {
    const pages = context.pages().filter((page) => pageOpen(page))
    for (const page of pages.slice(1)) await page.close().catch(() => undefined)
    const first = pages[0]
    if (pageOpen(first) && first.url() !== 'about:blank') await first.goto('about:blank').catch(() => undefined)
  }

  private async browser(): Promise<BrowserContext> {
    if (this.contextOpen()) return this.context!
    await this.dropContext()
    mkdirSync(this.profileDir, { recursive: true })
    const channels = ['chrome', 'msedge'] as const
    const errors: string[] = []
    for (const channel of channels) {
      try {
        const context = await chromium.launchPersistentContext(this.profileDir, {
          channel,
          headless: false,
          viewport: null,
          chromiumSandbox: true,
          ignoreDefaultArgs: ['--enable-automation'],
          args: ['--disable-blink-features=AutomationControlled']
        })
        context.on('close', () => {
          if (this.context !== context) return
          this.context = null
          this.authPage = null
          this.slots.clear()
          this.storageScript = false
        })
        this.context = context
        await this.installSession(context, this.preferSavedSession ? 'replace' : 'seed')
        await this.tidyStartupPages(context)
        this.preferSavedSession = false
        return context
      } catch (error) {
        await this.context?.close().catch(() => undefined)
        this.context = null
        this.storageScript = false
        errors.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`Не удалось открыть Chrome или Edge.\n${errors.join('\n')}`)
  }

  private contextOpen(): boolean {
    const context = this.context
    if (!context) return false
    try {
      return context.browser()?.isConnected() ?? false
    } catch {
      return false
    }
  }

  private async dropContext(): Promise<void> {
    const context = this.context
    this.context = null
    this.authPage = null
    this.slots.clear()
    this.storageScript = false
    await context?.close().catch(() => undefined)
  }

  private async installSession(context: BrowserContext, mode: 'seed' | 'replace'): Promise<void> {
    const session = this.readSession()
    const token = session.token?.trim() ?? ''
    const refreshToken = session.refreshToken?.trim() ?? ''
    if (!token && !refreshToken) return
    const existing = await context.cookies('https://chat.qwen.ai')
    const has = (name: string) => existing.some((cookie) => cookie.name === name && cookie.value)
    if (mode === 'seed' && (has('token') || has('refresh_token'))) return
    if (mode === 'replace') {
      if (token) await context.clearCookies({ name: 'token' }).catch(() => undefined)
      if (refreshToken) await context.clearCookies({ name: 'refresh_token' }).catch(() => undefined)
    }
    const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
    const cookies = [
      token && (mode === 'replace' || !has('token')) ? { name: 'token', value: token } : null,
      refreshToken && (mode === 'replace' || !has('refresh_token')) ? { name: 'refresh_token', value: refreshToken } : null
    ].filter((item): item is { name: string; value: string } => item !== null)
    if (cookies.length) {
      await context
        .addCookies(cookies.map((item) => ({ ...item, domain: '.qwen.ai', path: '/', secure: true, sameSite: 'Lax' as const, expires })))
        .catch(() => undefined)
    }
    await this.ensureStorageScript(context, { token, refreshToken })
    await this.writeStorage(context, { token, refreshToken }, mode === 'replace')
  }

  private async ensureStorageScript(context: BrowserContext, value: { token: string; refreshToken: string }): Promise<void> {
    if (this.storageScript) return
    this.storageScript = true
    await context.addInitScript((saved) => {
      try {
        if (location.hostname !== 'chat.qwen.ai') return
        if (saved.token && !localStorage.getItem('token')) localStorage.setItem('token', saved.token)
        if (saved.refreshToken && !localStorage.getItem('refresh_token')) localStorage.setItem('refresh_token', saved.refreshToken)
      } catch {
        // У about:blank нет хранилища.
      }
    }, value)
  }

  private async writeStorage(context: BrowserContext, value: { token: string; refreshToken: string }, overwrite: boolean): Promise<void> {
    for (const page of context.pages()) {
      if (!pageOpen(page)) continue
      await page
        .evaluate(
          (saved) => {
            if (location.hostname !== 'chat.qwen.ai') return
            if (saved.token && (saved.overwrite || !localStorage.getItem('token'))) localStorage.setItem('token', saved.token)
            if (saved.refreshToken && (saved.overwrite || !localStorage.getItem('refresh_token'))) {
              localStorage.setItem('refresh_token', saved.refreshToken)
            }
          },
          { ...value, overwrite }
        )
        .catch(() => undefined)
    }
  }
}

function pageOpen(page: Page | null | undefined): page is Page {
  if (!page) return false
  try {
    return !page.isClosed()
  } catch {
    return false
  }
}

function slotId(turn: Pick<QwenTurn, 'runId' | 'chatKey' | 'branchId'>): string {
  return `${turn.runId}\n${turn.chatKey}\n${turn.branchId}`
}

function durableChatUrl(url: string | null): string | null {
  if (!chatIdFromUrl(url)) return null
  return url
}

function chatIdFromUrl(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/c\/([A-Za-z0-9-]{8,})\/?(?:[?#].*)?$/)
  if (!match || match[1] === 'guest') return null
  return match[1]
}

function closedChatError(chatKey: string, url: string | null): Error {
  const hash = chatIdFromUrl(url)
  if (hash) return new Error(`Чат «${chatKey}» не открыт. Сохранённый хэш: ${hash}.`)
  return new Error(`Чат «${chatKey}» не открыт: сохранённого адреса нет. Запустите workflow ещё раз, чтобы создать его заново.`)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Остановлено')
}

async function deliver(page: Page, parts: ContentPart[], signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  await page.bringToFront().catch(() => undefined)
  const before = await answerCount(page)
  const images = parts.filter((part) => part.type === 'image').map((part) => part.path)
  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
  await dismissCookies(page)
  await confirmAge(page)
  if (images.length) await attachImages(page, images, signal)
  if (text) {
    const composer = await waitForComposer(page, signal)
    await typePrompt(composer, text)
  }
  const seen = await chatMark(page)
  await submitComposer(page, Boolean(text || images.length), signal)
  return waitForAnswer(page, before, seen, signal)
}

async function attachImages(page: Page, paths: string[], signal?: AbortSignal): Promise<void> {
  for (const filePath of paths) {
    if (!existsSync(filePath)) throw new Error(`Файл фото не найден: ${filePath}`)
  }
  const before = await page.locator('.vision-item-container').count()
  let chosen = false
  for (let attempt = 0; attempt < 3 && !chosen; attempt += 1) {
    throwIfAborted(signal)
    await page.keyboard.press('Escape').catch(() => undefined)
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 8_000 }).catch(() => null)
    const item = page.locator('.mode-select-dropdown-item').filter({ hasText: /upload attachment|загрузить/i, visible: true })
    if ((await item.count()) === 0) await page.locator('[aria-label="Select Mode"]').click()
    await item.first().waitFor({ state: 'visible', timeout: 5_000 })
    const box = await item.first().boundingBox()
    if (!box) continue
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const chooser = await chooserPromise
    if (!chooser) continue
    await chooser.setFiles(paths)
    chosen = true
  }
  if (!chosen) throw new Error('Не удалось открыть загрузку фото в Qwen.')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const total = await page.locator('.vision-item-container').count()
    const uploading = await page.locator('.vision-item-container-uploading').count()
    if (total >= before + paths.length && uploading === 0) return
    await page.waitForTimeout(400)
  }
  throw new Error('Фото не прикрепились к сообщению. Превью в поле ввода не появилось, отправка остановлена.')
}

async function waitForShell(page: Page): Promise<void> {
  await page.waitForSelector('textarea.message-input-textarea, .header-right-auth-button', { timeout: 30_000 })
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return (await page.locator('.header-right-auth-button').count()) === 0
}

async function waitForComposer(page: Page, signal?: AbortSignal): Promise<Locator> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const composer = await findVisible(page, COMPOSER_SELECTORS)
    if (composer) return composer
    await page.waitForTimeout(500)
  }
  throw new Error('Поле ввода Qwen не появилось. Войдите в аккаунт в открытом окне и запустите ещё раз.')
}

async function findVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).last()
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator
  }
  return null
}

async function typePrompt(composer: Locator, text: string): Promise<void> {
  await composer.click()
  await composer.evaluate((element, value) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      setter?.call(element, value)
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      return
    }
    element.focus()
    element.textContent = value
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
  }, text)
}

async function dismissCookies(page: Page): Promise<void> {
  const accept = page.getByRole('button', { name: 'Accept all cookies' })
  if (await accept.count()) await accept.click().catch(() => undefined)
}

async function confirmAge(page: Page): Promise<void> {
  const modal = page.locator('.ant-modal')
  const visible = await modal.first().isVisible().catch(() => false)
  if (!visible) return
  const continueButton = modal.getByRole('button', { name: 'Continue' })
  if (await continueButton.count()) await continueButton.click()
  await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)
}

async function submitComposer(page: Page, expectClear: boolean, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal)
    await page.bringToFront().catch(() => undefined)
    const button = await findVisible(page, SEND_SELECTORS)
    if (button) await button.click()
    else await page.keyboard.press('Enter')
    await confirmAge(page)
    if (!expectClear) return
    await page.waitForTimeout(400)
    if (!(await composerText(page)).trim()) return
  }
  throw new Error('Сообщение осталось в поле ввода и не отправилось.')
}

async function composerText(page: Page): Promise<string> {
  const composer = await findVisible(page, COMPOSER_SELECTORS)
  if (!composer) return ''
  return composer.inputValue().catch(() => composer.innerText().catch(() => ''))
}

const CONNECTION_ERROR = /oops!|issue connecting to|high demand|try again later/i
const MAX_REGENERATE = 3
const ANSWER_WAIT_MS = 6 * 60 * 1000
const QUIET_READY_MS = 2000
const QUIET_UNMARKED_MS = 45_000

type ChatMark = { answers: number; banners: number; lastBanner: string }

async function waitForAnswer(page: Page, before: number, seen: ChatMark, signal?: AbortSignal): Promise<string> {
  let deadline = Date.now() + ANSWER_WAIT_MS
  let floor = before
  let stable = ''
  let stableSince = 0
  let regenerations = 0
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const choice = await choosePreferredResponse(page)
    if (choice === 'waiting' || choice === 'clicked') {
      stable = ''
      stableSince = 0
      if (choice === 'clicked') seen = await chatMark(page)
      await page.waitForTimeout(400)
      continue
    }
    const count = await answerCount(page)
    const text = count > floor ? await lastAnswer(page) : ''
    if (text && !CONNECTION_ERROR.test(text)) {
      const phase = await latestAnswerPhase(page)
      if (phase === 'generating') {
        stable = ''
        stableSince = 0
        await page.waitForTimeout(400)
        continue
      }
      const quietMs = phase === 'ready' ? QUIET_READY_MS : QUIET_UNMARKED_MS
      if (text === stable) {
        if (Date.now() - stableSince > quietMs) return preferFullCode(page, text)
      } else {
        stable = text
        stableSince = Date.now()
      }
      await page.waitForTimeout(400)
      continue
    }
    const error = await freshConnectionError(page, floor, seen)
    if (error) {
      if (regenerations >= MAX_REGENERATE) {
        throw new Error(`Qwen перегружен, повтор не помог: ${error.text}`)
      }
      await clickRegenerate(page, error.text)
      regenerations += 1
      stable = ''
      stableSince = 0
      deadline = Date.now() + ANSWER_WAIT_MS
      if (error.inAnswer) floor = Math.max(0, (await answerCount(page)) - 1)
      await waitUntilErrorClears(page, error.text, signal)
      continue
    }
    await page.waitForTimeout(400)
  }
  throw new Error(stable ? 'Ответ Qwen не перестал меняться за 6 минут.' : 'Ответ в чате Qwen не найден.')
}

async function chatMark(page: Page): Promise<ChatMark> {
  return page.evaluate(() => {
    const banners = [...document.querySelectorAll('.qwen-messsage-status-description, .qwen-messsage-status-mobile-description')]
    const last = banners.at(-1)
    return {
      answers: document.querySelectorAll('.response-message-content').length,
      banners: banners.length,
      lastBanner: last instanceof HTMLElement ? last.innerText.trim() : ''
    }
  })
}

async function freshConnectionError(
  page: Page,
  before: number,
  seen: ChatMark
): Promise<{ text: string; inAnswer: boolean } | null> {
  const mark = await chatMark(page)
  if (mark.answers > before) {
    const text = await lastAnswer(page)
    if (CONNECTION_ERROR.test(text)) return { text, inAnswer: true }
  }
  const bannerChanged = mark.banners > seen.banners || mark.lastBanner !== seen.lastBanner
  if (bannerChanged && CONNECTION_ERROR.test(mark.lastBanner)) return { text: mark.lastBanner, inAnswer: false }
  return null
}

async function choosePreferredResponse(page: Page): Promise<'none' | 'waiting' | 'clicked'> {
  const target = await page.evaluate((errorSource) => {
    const preferRe = /i prefer this response|prefer this response|предпочита/i
    const errorRe = new RegExp(errorSource, 'i')
    const isPreferLabel = (node: Element): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false
      const text = node.innerText.replace(/\s+/g, ' ').trim()
      if (!text || text.length >= 80 || !preferRe.test(text)) return false
      return ![...node.children].some((child) => child instanceof HTMLElement && preferRe.test(child.innerText))
    }
    const buttons = [...document.querySelectorAll('button, [role="button"], div, span')].filter(isPreferLabel)
    if (!buttons.length) return { kind: 'none' as const }
    const cards = buttons.map((button) => {
      let best: HTMLElement = button
      let current = button.parentElement
      for (let depth = 0; depth < 12 && current; depth += 1) {
        const nested = buttons.filter((item) => current?.contains(item))
        if (nested.length !== 1) break
        best = current
        current = current.parentElement
      }
      return { button, card: best }
    })
    const good = cards.find(({ card }) => {
      if (errorRe.test(card.innerText)) return false
      const body = card.innerText
        .replace(preferRe, '')
        .replace(/response\s+\d+/gi, '')
        .replace(/thinking(\s+completed)?/gi, '')
        .trim()
      return body.length > 0
    })
    if (!good) {
      const stillThinking = cards.some(({ card }) => /thinking/i.test(card.innerText) && !errorRe.test(card.innerText))
      return { kind: stillThinking ? ('waiting' as const) : ('none' as const) }
    }
    good.button.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = good.button.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { kind: 'waiting' as const }
    return { kind: 'clicked' as const, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, CONNECTION_ERROR.source)
  if (target.kind !== 'clicked' || target.x === undefined || target.y === undefined) {
    return target.kind === 'waiting' ? 'waiting' : 'none'
  }
  await page.mouse.click(target.x, target.y)
  return 'clicked'
}

async function clickRegenerate(page: Page, errorText: string): Promise<void> {
  const box = await page.evaluate((needle) => {
    const sample = needle.slice(0, 80)
    const nodes = [...document.querySelectorAll('.qwen-messsage-status-description, .qwen-messsage-status-mobile-description, .response-message-content')]
    const anchor = [...nodes].reverse().find((node) => node instanceof HTMLElement && node.innerText.includes(sample))
    if (!(anchor instanceof HTMLElement)) return null
    let current: HTMLElement | null = anchor
    for (let depth = 0; depth < 8 && current; depth += 1) {
      const button = current.querySelector('.qwen-chat-package-comp-new-action-control-container-regenerate')
      if (button instanceof HTMLElement && current.querySelectorAll('.response-message-content').length <= 1) {
        button.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = button.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      current = current.parentElement
    }
    return null
  }, errorText)
  if (!box) throw new Error(`Qwen показал ошибку соединения, а кнопки повтора под ней нет.\n${errorText}`)
  await page.mouse.click(box.x, box.y)
}

async function waitUntilErrorClears(page: Page, errorText: string, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    throwIfAborted(signal)
    const visible = await page.evaluate((needle) => {
      const nodes = [...document.querySelectorAll('.response-message-content, .qwen-messsage-status-description, .qwen-messsage-status-mobile-description')]
      return nodes.some((node) => node instanceof HTMLElement && node.innerText.trim() === needle)
    }, errorText)
    if (!visible) return
    await page.waitForTimeout(400)
  }
}

async function answerCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.response-message-content').length)
}

async function latestAnswerPhase(page: Page): Promise<'generating' | 'ready' | 'unknown'> {
  return page.evaluate(() => {
    const shown = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const composer = document.querySelector('.message-input-container, .message-input-right-button')
    const stop = composer?.querySelector(
      '.message-input-right-button-stop, [class*="button-stop"], [aria-label="Stop"], [aria-label="Stop generating"], [aria-label="停止"], [aria-label="停止生成"], [aria-label="Остановить"]'
    )
    if (shown(stop ?? null)) return 'generating'
    const nodes = [...document.querySelectorAll('.response-message-content')].filter(
      (node) => node instanceof HTMLElement && node.innerText.trim()
    )
    const last = nodes.at(-1)
    if (!(last instanceof HTMLElement)) return 'unknown'
    let current: HTMLElement | null = last
    for (let depth = 0; depth < 14 && current; depth += 1) {
      if (current.querySelectorAll('.response-message-content').length > 1) break
      const footer = current.querySelector(
        '.copy-response-button, [class*="copy-response"], .qwen-chat-package-comp-new-action-control-container-regenerate'
      )
      if (shown(footer)) return 'ready'
      current = current.parentElement
    }
    return 'unknown'
  })
}

async function lastAnswer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.response-message-content')].filter(
      (node) => node instanceof HTMLElement && node.innerText.trim()
    )
    const last = nodes.at(-1)
    if (!(last instanceof HTMLElement)) return ''
    const markdown = last.querySelector('.qwen-markdown')
    const source = markdown instanceof HTMLElement ? markdown : last
    return source.innerText.trim()
  })
}

async function preferFullCode(page: Page, fallback: string): Promise<string> {
  const copied = await copiedCode(page).catch(() => null)
  if (copied && preferAnswer(copied, fallback) === copied) return copied
  const scrolled = await readFullCode(page).catch(() => null)
  return preferAnswer(scrolled, fallback)
}

function preferAnswer(candidate: string | null, fallback: string): string {
  if (!candidate) return fallback
  const clean = stripCodeGutter(candidate)
  if (clean.startsWith('{') || clean.startsWith('[')) return clean
  if (numberedViewport(fallback) && clean.length > 40) return clean
  if (clean.length > fallback.length) return clean
  return fallback
}

function numberedViewport(text: string): boolean {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  let numbers = 0
  for (const line of lines) {
    if (/^(json|javascript|js|ts|txt|text)$/i.test(line)) continue
    if (!/^\d+$/.test(line)) break
    numbers += 1
  }
  return numbers >= 5
}

async function copiedCode(page: Page): Promise<string | null> {
  const scope = page.locator('.response-message-content').last().locator('.qwen-markdown')
  const button = scope
    .locator('[class*="copy" i], button[aria-label*="copy" i], button[aria-label*="копир" i], button[aria-label*="复制" i]')
    .last()
  if (!(await button.count())) return null
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://chat.qwen.ai' }).catch(() => undefined)
  await button.click({ timeout: 2000 })
  const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')
  return text.trim() || null
}

async function readFullCode(page: Page): Promise<string | null> {
  const chunks = await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, 40))
    const messages = [...document.querySelectorAll('.response-message-content')].filter(
      (node) => node instanceof HTMLElement && node.innerText.trim()
    )
    const last = messages.at(-1)
    if (!(last instanceof HTMLElement)) return []
    const markdown = last.querySelector('.qwen-markdown')
    const scope = markdown instanceof HTMLElement ? markdown : last
    const looksJson = (text: string) => /"\w+"\s*:/.test(text)
    const codeColumn = (host: HTMLElement): string => {
      let best = ''
      for (const node of [host, ...host.querySelectorAll('*')]) {
        if (!(node instanceof HTMLElement)) continue
        const text = node.innerText.trim()
        if (!looksJson(text)) continue
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
        const numeric = lines.filter((line) => /^\d+$/.test(line)).length
        if (lines.length && numeric >= lines.length * 0.4) continue
        if (text.length > best.length) best = text
      }
      return best
    }
    let host: HTMLElement | null = null
    let viewport = Infinity
    let fallback: HTMLElement | null = null
    let fallbackLength = 0
    for (const node of [scope, ...scope.querySelectorAll('*')]) {
      if (!(node instanceof HTMLElement)) continue
      const text = node.innerText
      if (!looksJson(text)) continue
      if (text.length > fallbackLength) {
        fallback = node
        fallbackLength = text.length
      }
      const scrollable = node.scrollHeight > node.clientHeight + 24 && node.clientHeight > 40
      if (scrollable && node.clientHeight < viewport) {
        host = node
        viewport = node.clientHeight
      }
    }
    host = host ?? fallback
    if (!host) return []
    const chunks: string[] = []
    const push = () => {
      const piece = codeColumn(host)
      if (piece) chunks.push(piece)
    }
    if (host.scrollHeight <= host.clientHeight + 24) {
      push()
      return chunks
    }
    host.scrollTop = 0
    await sleep(30)
    for (let step = 0; step < 80; step += 1) {
      push()
      if (host.scrollTop + host.clientHeight >= host.scrollHeight - 2) break
      host.scrollTop += Math.max(24, host.clientHeight - 16)
      await sleep(30)
    }
    push()
    return chunks
  })
  if (!chunks.length) return null
  return stitchChunks(chunks).trim()
}
