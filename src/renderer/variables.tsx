import { useEffect, useState } from 'react'
import type { NamedVariable, VariableVersion } from '@core/types'
import { latestVariableVersion } from '@core/variables'
import { errorText, Modal } from './ui'

type CreateDraft = { name: string; label: string; description: string; value: string }
type Confirm = { title: string; text: string; action: () => Promise<void> }

export function VariableEditor({ scope, projectId }: { scope: 'global' | 'project'; projectId?: string }) {
  const [items, setItems] = useState<NamedVariable[]>([])
  const [creating, setCreating] = useState<CreateDraft | null>(null)
  const [editing, setEditing] = useState<NamedVariable | null>(null)
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [nextDescription, setNextDescription] = useState('')
  const [nextValue, setNextValue] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)

  async function reload() {
    const next = await window.pipeline.listVariables(scope, projectId)
    setItems(next)
    return next
  }

  useEffect(() => {
    void reload().catch((reason) => setError(errorText(reason)))
  }, [scope, projectId])

  function openCreate() {
    setError(null)
    setCreating({ name: '', label: '', description: '', value: '' })
  }

  function openExisting(item: NamedVariable) {
    const current = latestVariableVersion(item)
    setError(null)
    setEditing(item)
    setName(item.name)
    setLabel(item.label)
    setNextDescription('')
    setNextValue(displayValue(current?.value))
    setNotes(Object.fromEntries((item.versions ?? []).map((version) => [version.id, version.description])))
  }

  function refreshOpen(item: NamedVariable, keepIdentity = false) {
    setEditing(item)
    if (!keepIdentity) {
      setName(item.name)
      setLabel(item.label)
    }
    setNotes(Object.fromEntries((item.versions ?? []).map((version) => [version.id, version.description])))
  }

  async function createVariable() {
    if (!creating) return
    setSaving(true)
    setError(null)
    try {
      await window.pipeline.saveVariable({
        scope,
        projectId,
        name: creating.name,
        label: creating.label,
        description: creating.description,
        value: parseDraft(creating.value)
      })
      setCreating(null)
      await reload()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  async function saveIdentity() {
    if (!editing) return
    setSaving(true)
    setError(null)
    try {
      const saved = await window.pipeline.updateVariable({ id: editing.id, name, label })
      refreshOpen(saved)
      await reload()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  async function addVersion() {
    if (!editing) return
    setSaving(true)
    setError(null)
    try {
      const saved = await window.pipeline.addVariableVersion({
        id: editing.id,
        description: nextDescription,
        value: parseDraft(nextValue)
      })
      setNextDescription('')
      setNextValue(displayValue(latestVariableVersion(saved)?.value))
      refreshOpen(saved, true)
      await reload()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  async function saveNote(version: VariableVersion) {
    setSaving(true)
    setError(null)
    try {
      const saved = await window.pipeline.updateVariableVersion({ id: version.id, description: notes[version.id] ?? '' })
      refreshOpen(saved, true)
      await reload()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  function askDeleteVariable(item: NamedVariable) {
    setConfirm({
      title: 'Удалить переменную',
      text: `Удалить «${item.name}» вместе со всеми версиями?`,
      action: async () => {
        await window.pipeline.deleteVariable(item.id)
        if (editing?.id === item.id) setEditing(null)
        await reload()
      }
    })
  }

  function askDeleteVersion(version: VariableVersion) {
    setConfirm({
      title: 'Удалить версию',
      text: `Удалить версию ${version.version}? Имя переменной останется, текущей станет последняя из оставшихся.`,
      action: async () => {
        const saved = await window.pipeline.deleteVariableVersion(version.id)
        setNextValue(displayValue(latestVariableVersion(saved)?.value))
        refreshOpen(saved, true)
        await reload()
      }
    })
  }

  const prefix = scope === 'project' ? 'project' : 'globals'
  const versions = editing ? [...(editing.versions ?? [])].sort((a, b) => b.version - a.version) : []
  const current = editing ? latestVariableVersion(editing) : undefined
  const identityDirty = Boolean(editing && (name !== editing.name || label !== editing.label))

  return (
    <div>
      {error && !creating && !editing && <div className="error">{error}</div>}
      {items.map((item) => {
        const latest = latestVariableVersion(item)
        return (
          <div key={item.id} className="var-row">
            <div>
              <strong>{item.label || item.name}</strong>
              <div className="meta">
                <code>{prefix}.{item.name}</code>
                {latest && <span> v{latest.version}</span>}
                {latest?.description && <span> · {latest.description}</span>}
              </div>
            </div>
            <div className="row">
              <button className="ghost" type="button" onClick={() => openExisting(item)}>
                Изменить
              </button>
              <button className="ghost" type="button" onClick={() => askDeleteVariable(item)}>
                Удалить
              </button>
            </div>
          </div>
        )
      })}
      {!items.length && <p className="meta">Пока нет переменных.</p>}
      <button className="btn" type="button" onClick={openCreate}>
        Добавить
      </button>
      {creating && (
        <Modal title="Новая переменная" wide onClose={() => setCreating(null)}>
          {error && <div className="error">{error}</div>}
          <VariableFields
            name={creating.name}
            label={creating.label}
            description={creating.description}
            value={creating.value}
            onName={(value) => setCreating({ ...creating, name: value })}
            onLabel={(value) => setCreating({ ...creating, label: value })}
            onDescription={(value) => setCreating({ ...creating, description: value })}
            onValue={(value) => setCreating({ ...creating, value: value })}
          />
          <div className="row">
            <button className="btn" type="button" disabled={saving} onClick={() => void createVariable()}>
              Сохранить
            </button>
            <button className="ghost" type="button" onClick={() => setCreating(null)}>
              Отмена
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal title="Переменная" wide onClose={() => setEditing(null)}>
          {error && <div className="error">{error}</div>}
          <p className="lede">Имя одно на все версии. Новое значение сохраняется следующей версией, в шагах берётся последняя.</p>
          <label className="field">
            <span>Имя</span>
            <input value={name} placeholder="brand" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>Подпись</span>
            <input value={label} placeholder="Как показывать в списке" onChange={(event) => setLabel(event.target.value)} />
          </label>
          {identityDirty && (
            <button className="ghost" type="button" disabled={saving} onClick={() => void saveIdentity()}>
              Сохранить имя
            </button>
          )}
          <p className="section-label">Версии</p>
          {versions.map((version) => (
            <div key={version.id} className="version-card">
              <div className="version-head">
                <strong>
                  v{version.version}
                  {version.id === current?.id ? ' · текущая' : ''}
                </strong>
                {versions.length > 1 && (
                  <button className="ghost" type="button" onClick={() => askDeleteVersion(version)}>
                    Удалить
                  </button>
                )}
              </div>
              <label className="field">
                <span>Описание</span>
                <input
                  value={notes[version.id] ?? ''}
                  placeholder="Что изменилось"
                  onChange={(event) => setNotes({ ...notes, [version.id]: event.target.value })}
                />
              </label>
              {(notes[version.id] ?? '') !== version.description && (
                <button className="ghost" type="button" disabled={saving} onClick={() => void saveNote(version)}>
                  Сохранить описание
                </button>
              )}
              <pre className="json">{displayValue(version.value)}</pre>
            </div>
          ))}
          <p className="section-label">Новая версия</p>
          <label className="field">
            <span>Описание</span>
            <input
              value={nextDescription}
              placeholder="Необязательно"
              onChange={(event) => setNextDescription(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Значение</span>
            <textarea rows={8} value={nextValue} onChange={(event) => setNextValue(event.target.value)} />
          </label>
          <div className="row">
            <button className="btn" type="button" disabled={saving} onClick={() => void addVersion()}>
              Сохранить как v{(current?.version ?? 0) + 1}
            </button>
            <button className="ghost" type="button" onClick={() => setEditing(null)}>
              Закрыть
            </button>
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <p className="lede">{confirm.text}</p>
          <div className="row">
            <button
              className="danger"
              type="button"
              onClick={() => {
                void confirm
                  .action()
                  .then(() => setConfirm(null))
                  .catch((reason) => {
                    setConfirm(null)
                    setError(errorText(reason))
                  })
              }}
            >
              Удалить
            </button>
            <button className="ghost" type="button" onClick={() => setConfirm(null)}>
              Оставить
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function VariableFields({
  name,
  label,
  description,
  value,
  onName,
  onLabel,
  onDescription,
  onValue
}: {
  name: string
  label: string
  description: string
  value: string
  onName: (value: string) => void
  onLabel: (value: string) => void
  onDescription: (value: string) => void
  onValue: (value: string) => void
}) {
  return (
    <>
      <label className="field">
        <span>Имя</span>
        <input value={name} placeholder="brand" onChange={(event) => onName(event.target.value)} />
      </label>
      <label className="field">
        <span>Подпись</span>
        <input value={label} placeholder="Как показывать в списке" onChange={(event) => onLabel(event.target.value)} />
      </label>
      <label className="field">
        <span>Описание версии</span>
        <input value={description} placeholder="Необязательно" onChange={(event) => onDescription(event.target.value)} />
      </label>
      <label className="field">
        <span>Значение</span>
        <textarea rows={12} value={value} placeholder="Текст, который попадёт в {{...}}" onChange={(event) => onValue(event.target.value)} />
      </label>
    </>
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
