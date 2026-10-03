import { createContext, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isStoredFile, toMediaUrl } from '@core/media'
import { pretty } from '@core/labels'
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
  if (isStoredFile(value, 'image')) {
    const image = value as { path: string; name: string }
    return <img className="preview" src={toMediaUrl(image.path)} alt={image.name} />
  }
  if (Array.isArray(value) && value.every((item) => isStoredFile(item, 'image'))) {
    return (
      <div className="row">
        {value.map((item) => (
          <img key={(item as { path: string }).path} className="preview" src={toMediaUrl((item as { path: string }).path)} alt="" />
        ))}
      </div>
    )
  }
  return <pre className="json">{pretty(value)}</pre>
}

export const VariablePoolsContext = createContext<VariablePools>({})

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

export function installPlainPaste(): () => void {
  const onPaste = (event: ClipboardEvent) => {
    const el = event.target
    if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return
    if (el.disabled || el.readOnly) return
    if (el instanceof HTMLInputElement && !['text', 'search', 'url', '', 'password'].includes(el.type)) return
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
  const pools = useContext(VariablePoolsContext)
  const groups = variableCatalog(graph, step, pools)
  return (
    <div className="picker">
      <button type="button" className="ghost" onClick={() => setOpen((value) => !value)}>
        Вставить переменную
      </button>
      {open && (
        <div className="picker-panel">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="section-label">{group.title}</p>
              {group.items.map((item) => (
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
          ))}
        </div>
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
  readOnly = false
}: {
  label: string
  value: string
  onChange: (value: string) => void
  graph: WorkflowGraph
  step?: StepDefinition
  rows?: number
  readOnly?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <label className="field">
      <span>{label}</span>
      <textarea ref={ref} rows={rows} value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)} />
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
