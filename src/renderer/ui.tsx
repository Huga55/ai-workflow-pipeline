import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isStoredFile, isTextWithFiles, storedFiles, toMediaUrl } from '@core/media'
import { pretty } from '@core/labels'
import type { MissingVariable } from '@core/missing-variables'
import { variableCatalog, type VariablePools } from '@core/variables'
import type { StepDefinition, WorkflowGraph } from '@core/types'

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Ошибка'
  const marker = message.lastIndexOf('Error: ')
  return marker >= 0 ? message.slice(marker + 'Error: '.length) : message
}

export function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = {
    draft: 'Черновик',
    running: 'Выполняется',
    paused: 'Пауза',
    completed: 'Готово',
    failed: 'Ошибка',
    cancelled: 'Отменён',
    pending: 'Ожидает',
    waiting_for_user: 'Ждёт вас',
    skipped: 'Пропущен'
  }
  return <span className={`pill ${status}`}>{labels[status] ?? status}</span>
}

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
}

export function JsonView({ value }: { value: unknown }) {
  if (isTextWithFiles(value)) {
    return (
      <div>
        {value.text && <pre className="json">{value.text}</pre>}
        <div className="row">
          {value.files.map((file) =>
            file.kind === 'image' ? (
              <img key={file.path} className="preview" src={toMediaUrl(file.path)} alt={file.name} />
            ) : (
              <span key={file.path} className="meta">
                {file.name}
              </span>
            )
          )}
        </div>
      </div>
    )
  }
  if (isStoredFile(value, 'image')) {
    const image = value as { path: string; name: string }
    return <img className="preview" src={toMediaUrl(image.path)} alt={image.name} />
  }
  const files = storedFiles(value)
  if (Array.isArray(value) && files.length === value.length && files.length > 0) {
    return (
      <div className="row">
        {files.map((file) =>
          file.kind === 'image' ? (
            <img key={file.path} className="preview" src={toMediaUrl(file.path)} alt={file.name} />
          ) : (
            <span key={file.path} className="meta">
              {file.name}
            </span>
          )
        )}
      </div>
    )
  }
  return <pre className="json">{pretty(value)}</pre>
}

export const VariablePoolsContext = createContext<VariablePools>({})
export const MissingVariablesContext = createContext<MissingVariable[]>([])
export const MissingFocusContext = createContext<{ fieldId: string; nonce: number } | null>(null)

export function useMissing(fieldId?: string): MissingVariable[] {
  const issues = useContext(MissingVariablesContext)
  if (!fieldId) return []
  return issues.filter((issue) => issue.fieldId === fieldId)
}

function locateToken(value: string, path: string): [number, number] | null {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\{\\{\\s*(?:#if\\s+)?${escaped}\\s*\\}\\}|${escaped}`).exec(value)
  if (!match) return null
  return [match.index, match.index + match[0].length]
}

export function useMissingSelection(
  fieldId: string | undefined,
  value: string,
  ref: { current: HTMLTextAreaElement | HTMLInputElement | null }
) {
  const focus = useContext(MissingFocusContext)
  const issues = useMissing(fieldId)
  const seen = useRef('')
  useEffect(() => {
    if (!fieldId || !focus || focus.fieldId !== fieldId || !ref.current) return
    const mark = String(focus.nonce)
    if (seen.current === mark) return
    seen.current = mark
    const path = issues[0]?.path
    ref.current.focus()
    if (!path) return
    const span = locateToken(ref.current.value || value, path)
    if (span) ref.current.setSelectionRange(span[0], span[1])
  }, [focus, fieldId, value, issues, ref])
}

export function MissingNote({ fieldId }: { fieldId?: string }) {
  const issues = useMissing(fieldId)
  if (!issues.length) return null
  return (
    <p className="missing-note">
      {issues.length === 1 ? 'Здесь нет переменной ' : 'Здесь нет переменных '}
      {issues.map((issue, index) => (
        <span key={issue.path}>
          {index > 0 ? ', ' : null}
          <code>{`{{${issue.path}}}`}</code>
        </span>
      ))}
      .
      {issues.map((issue) => (issue.hint ? <span key={`${issue.path}:hint`}> {issue.hint}</span> : null))}
    </p>
  )
}

export function clipboardPlainText(data: DataTransfer | null): string | null {
  if (!data) return null
  const plain = data.getData('text/plain')
  if (plain) return plain
  const html = data.getData('text/html')
  if (!html) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style').forEach((node) => node.remove())
  return doc.body.innerText.replaceAll('\u00a0', ' ')
}

export function clipboardHasFiles(data: DataTransfer | null): boolean {
  if (!data) return false
  if (data.files.length > 0) return true
  return [...data.items].some((item) => item.kind === 'file')
}

export function installPlainPaste(): () => void {
  const onPaste = (event: ClipboardEvent) => {
    const el = event.target
    if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return
    if (el.disabled || el.readOnly) return
    if (el instanceof HTMLInputElement && !['text', 'search', 'url', '', 'password'].includes(el.type)) return
    if (clipboardHasFiles(event.clipboardData)) return
    const text = clipboardPlainText(event.clipboardData)
    if (!text) return
    event.preventDefault()
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    const caret = start + text.length
    requestAnimationFrame(() => el.setSelectionRange(caret, caret))
  }
  window.addEventListener('paste', onPaste, true)
  return () => window.removeEventListener('paste', onPaste, true)
}

type PickerPlace = { left: number; width: number; maxHeight: number; top?: number; bottom?: number }

export function VariablePicker({
  graph,
  step,
  onPick
}: {
  graph: WorkflowGraph
  step?: StepDefinition
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('')
  const [place, setPlace] = useState<PickerPlace | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const pools = useContext(VariablePoolsContext)
  const groups = variableCatalog(graph, step, pools).filter((group) => group.items.length > 0)
  const current = groups.find((group) => group.title === tab) ?? groups[0]

  function reposition() {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const margin = 8
    const gap = 6
    const width = Math.min(420, window.innerWidth - margin * 2)
    let left = rect.left
    if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width
    if (left < margin) left = margin
    const spaceBelow = window.innerHeight - rect.bottom - margin - gap
    const spaceAbove = rect.top - margin - gap
    const openUp = spaceAbove > spaceBelow
    const maxHeight = Math.min(380, Math.max(0, openUp ? spaceAbove : spaceBelow))
    setPlace(
      openUp
        ? { left, width, maxHeight, top: undefined, bottom: window.innerHeight - rect.top + gap }
        : { left, width, maxHeight, top: rect.bottom + gap, bottom: undefined }
    )
  }

  useLayoutEffect(() => {
    if (!open) return
    reposition()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onScroll = () => reposition()
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    const row = tabsRef.current
    if (!open || !row) return
    const onWheel = (event: WheelEvent) => {
      if (row.scrollWidth <= row.clientWidth + 1) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      event.preventDefault()
      row.scrollLeft += delta
    }
    row.addEventListener('wheel', onWheel, { passive: false })
    return () => row.removeEventListener('wheel', onWheel)
  }, [open, groups.length])

  useEffect(() => {
    if (!open) return
    tabsRef.current?.querySelector<HTMLButtonElement>('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [open, current?.title])

  return (
    <div className="picker">
      <button
        ref={buttonRef}
        type="button"
        className="ghost"
        onClick={() => {
          if (!open) reposition()
          setOpen((value) => !value)
        }}
      >
        Добавить переменную
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panelRef}
            className="picker-panel"
            style={{
              left: place.left,
              width: place.width,
              maxHeight: place.maxHeight,
              top: place.top ?? 'auto',
              bottom: place.bottom ?? 'auto'
            }}
          >
            {groups.length > 0 && current ? (
              <>
                <div ref={tabsRef} className="picker-tabs" role="tablist">
                  {groups.map((group) => (
                    <button
                      key={group.title}
                      type="button"
                      role="tab"
                      aria-selected={group.title === current.title}
                      className={group.title === current.title ? 'on' : undefined}
                      onClick={() => setTab(group.title)}
                    >
                      {group.title}
                    </button>
                  ))}
                </div>
                <div className="picker-items" role="tabpanel" style={{ maxHeight: Math.max(0, place.maxHeight - 52) }}>
                  {current.items.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => {
                        onPick(item.path)
                        setOpen(false)
                      }}
                    >
                      <span>{item.label}</span>
                      <code>{item.path}</code>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="meta">Нет переменных.</p>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

export function TemplateField({
  label,
  value,
  onChange,
  graph,
  step,
  rows = 5,
  readOnly = false,
  fieldId
}: {
  label: string
  value: string
  onChange: (value: string) => void
  graph: WorkflowGraph
  step?: StepDefinition
  rows?: number
  readOnly?: boolean
  fieldId?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const missing = useMissing(fieldId)
  useMissingSelection(fieldId, value, ref)
  return (
    <label className={missing.length ? 'field has-missing' : 'field'}>
      <span>{label}</span>
      <textarea ref={ref} rows={rows} value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)} />
      <MissingNote fieldId={fieldId} />
      {!readOnly && (
        <VariablePicker
          graph={graph}
          step={step}
          onPick={(path) => {
            const element = ref.current
            const token = `{{${path}}}`
            if (!element) {
              onChange(value + token)
              return
            }
            const start = element.selectionStart ?? value.length
            const end = element.selectionEnd ?? start
            onChange(value.slice(0, start) + token + value.slice(end))
          }}
        />
      )}
    </label>
  )
}

const modalClosers: (() => void)[] = []

export function Modal({
  title,
  children,
  onClose,
  wide = false
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const close = () => onCloseRef.current()
    modalClosers.push(close)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || modalClosers.at(-1) !== close) return
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      const index = modalClosers.lastIndexOf(close)
      if (index >= 0) modalClosers.splice(index, 1)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  return createPortal(
    <div className="modal-back" style={{ zIndex: 30 + modalClosers.length }} onMouseDown={onClose}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="page-head">
          <h2>{title}</h2>
          <button className="ghost" type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  )
}

export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (buttonRef.current?.contains(target) || popRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  function toggle(event: ReactMouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 280
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const below = rect.bottom + 8
    const top = below + 140 > window.innerHeight ? Math.max(8, rect.top - 140) : below
    setPlace({ top, left })
    setOpen((value) => !value)
  }

  return (
    <span className="hint">
      <button
        ref={buttonRef}
        type="button"
        className="hint-btn"
        aria-label="Что означает этот тип"
        aria-expanded={open}
        onClick={toggle}
      >
        ?
      </button>
      {open && (
        <div ref={popRef} className="hint-pop" role="tooltip" style={{ top: place.top, left: place.left }}>
          {text}
        </div>
      )}
    </span>
  )
}

export function whenText(value: string): string {
  return new Date(value).toLocaleString('ru-RU')
}
