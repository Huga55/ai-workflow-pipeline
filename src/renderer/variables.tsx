import { useEffect, useState } from 'react'
import type { NamedVariable } from '@core/types'
import { errorText, Modal } from './ui'

type Draft = { id: string; originalName: string; name: string; label: string; value: string }

export function VariableEditor({ scope, projectId }: { scope: 'global' | 'project'; projectId?: string }) {
  const [items, setItems] = useState<NamedVariable[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function reload() {
    setItems(await window.pipeline.listVariables(scope, projectId))
  }

  useEffect(() => {
    void reload().catch((reason) => setError(errorText(reason)))
  }, [scope, projectId])

  function openNew() {
    setError(null)
    setDraft({ id: '', originalName: '', name: '', label: '', value: '' })
  }

  function openExisting(item: NamedVariable) {
    setError(null)
    setDraft({ id: item.id, originalName: item.name, name: item.name, label: item.label, value: displayValue(item.value) })
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      if (draft.id && draft.originalName !== draft.name.trim()) await window.pipeline.deleteVariable(draft.id)
      await window.pipeline.saveVariable({
        scope,
        projectId,
        name: draft.name,
        label: draft.label,
        value: parseDraft(draft.value)
      })
      setDraft(null)
      await reload()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const prefix = scope === 'project' ? 'project' : 'globals'

  return (
    <div>
      {error && !draft && <div className="error">{error}</div>}
      {items.map((item) => (
        <div key={item.id} className="var-row">
          <div>
            <strong>{item.label || item.name}</strong>
            <div className="meta">
              <code>{prefix}.{item.name}</code>
            </div>
          </div>
          <div className="row">
            <button className="ghost" type="button" onClick={() => openExisting(item)}>
              Изменить
            </button>
            <button className="ghost" type="button" onClick={() => void window.pipeline.deleteVariable(item.id).then(() => reload()).catch((reason) => setError(errorText(reason)))}>
              Удалить
            </button>
          </div>
        </div>
      ))}
      {!items.length && <p className="meta">Пока нет переменных.</p>}
      <button className="btn" type="button" onClick={openNew}>
        Добавить
      </button>
      {draft && (
        <Modal title={draft.id ? 'Переменная' : 'Новая переменная'} wide onClose={() => setDraft(null)}>
          {error && <div className="error">{error}</div>}
          <label className="field">
            <span>Имя</span>
            <input value={draft.name} placeholder="brand" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="field">
            <span>Подпись</span>
            <input value={draft.label} placeholder="Как показывать в списке" onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
          </label>
          <label className="field">
            <span>Значение</span>
            <textarea rows={12} value={draft.value} placeholder="Текст, который попадёт в {{...}}" onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
          </label>
          <div className="row">
            <button className="btn" type="button" disabled={saving} onClick={() => void save()}>
              Сохранить
            </button>
            <button className="ghost" type="button" onClick={() => setDraft(null)}>
              Отмена
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return JSON.stringify(value, null, 2)
}

function parseDraft(text: string): unknown {
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return text
    }
  }
  return text
}
