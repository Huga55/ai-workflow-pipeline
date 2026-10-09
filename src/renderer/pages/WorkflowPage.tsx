import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createId } from '@core/ids'
import { createInput, createStep } from '@core/factories'
import { topoSort, validateGraph } from '@core/graph'
import { INPUT_TYPE_LABEL, STEP_TYPE_HINT, STEP_TYPE_LABEL, slugify, uniqueKey } from '@core/labels'
import { latestVariableVersion, type VariablePools } from '@core/variables'
import type { AIMessageDraft, InputDefinition, InputType, StepDefinition, StepType, WorkflowDetails, WorkflowGraph } from '@core/types'
import { formatWorkflowJson, parseWorkflowJson, type WorkflowJsonDocument } from '@core/workflow-json'
import { copyText, errorText, Hint, TemplateField, VariablePoolsContext } from '../ui'

const STEP_TYPES: StepType[] = ['ai', 'transform', 'parse', 'fanout', 'manual', 'merge', 'input']
const INPUT_TYPES = Object.keys(INPUT_TYPE_LABEL) as InputType[]

export function WorkflowPage({
  projectId,
  workflowId,
  version,
  onBack,
  onVersion,
  onOpenRun,
  notify
}: {
  projectId: string
  workflowId: string
  version?: number
  onBack: () => void
  onVersion: (version?: number) => void
  onOpenRun: (runId: string) => void
  notify: (message: string) => void
}) {
  const [details, setDetails] = useState<WorkflowDetails | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [graph, setGraph] = useState<WorkflowGraph>({ inputs: [], steps: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [restored, setRestored] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const snapshot = useRef({ name: '', description: '', graph, selectedId, dirty: false })
  const [pools, setPools] = useState<VariablePools>({})
  const [view, setView] = useState<'builder' | 'json'>('builder')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const jsonEdited = useRef(false)
  const jsonTextRef = useRef(jsonText)
  jsonTextRef.current = jsonText
  const readOnly = Boolean(version && details && version !== details.workflow.latestVersion)
  const structureLocked = readOnly || view === 'json'

  useEffect(() => {
    void Promise.all([window.pipeline.listVariables('global'), window.pipeline.listVariables('project', projectId)])
      .then(([globals, project]) =>
        setPools({
          globals: globals.map((item) => ({
            name: item.name,
            label: item.label || item.name,
            version: latestVariableVersion(item)?.version
          })),
          project: project.map((item) => ({
            name: item.name,
            label: item.label || item.name,
            version: latestVariableVersion(item)?.version
          }))
        })
      )
      .catch(() => undefined)
  }, [projectId])

  useEffect(() => {
    jsonEdited.current = false
    setJsonError(null)
    let cancelled = false
    void Promise.all([
      window.pipeline.getWorkflow(workflowId, version),
      version || typeof window.pipeline.getDraft !== 'function' ? Promise.resolve(null) : window.pipeline.getDraft(workflowId)
    ])
      .then(([next, draft]) => {
        if (cancelled) return
        setDetails(next)
        if (draft) {
          setName(draft.name)
          setDescription(draft.description)
          setGraph(draft.graph)
          setJsonText(formatWorkflowJson({ name: draft.name, description: draft.description, graph: draft.graph }))
          setSelectedId(draft.selectedId ?? draft.graph.steps[0]?.id ?? null)
          setDirty(true)
          setRestored(true)
          return
        }
        setName(next.workflow.name)
        setDescription(next.workflow.description)
        setGraph(next.version.graph)
        setJsonText(formatWorkflowJson({ name: next.workflow.name, description: next.workflow.description, graph: next.version.graph }))
        setSelectedId(next.version.graph.steps[0]?.id ?? null)
        setDirty(false)
        setRestored(false)
      })
      .catch((reason) => {
        if (!cancelled) setError(errorText(reason))
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, version])

  useEffect(() => {
    snapshot.current = { name, description, graph, selectedId, dirty }
  })

  useEffect(() => {
    if (jsonEdited.current) return
    setJsonText(formatWorkflowJson({ name, description, graph }))
  }, [name, description, graph])

  useEffect(() => {
    if (!dirty || readOnly) return
    const timer = window.setTimeout(() => {
      const current = snapshot.current
      if (typeof window.pipeline.saveDraft !== 'function') return
      void window.pipeline
        .saveDraft(workflowId, {
          name: current.name,
          description: current.description,
          graph: current.graph,
          selectedId: current.selectedId
        })
        .catch((reason) => setError(errorText(reason)))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [dirty, name, description, graph, selectedId, readOnly, workflowId])

  useEffect(() => {
    const flush = () => {
      if (readOnly || typeof window.pipeline.saveDraftNow !== 'function') return
      const current = snapshot.current
      let draft = {
        name: current.name,
        description: current.description,
        graph: current.graph,
        selectedId: current.selectedId
      }
      if (jsonEdited.current) {
        const parsed = parseWorkflowJson(jsonTextRef.current, { previous: current.graph })
        if (parsed.ok) {
          draft = {
            name: parsed.document.name,
            description: parsed.document.description,
            graph: parsed.document.graph,
            selectedId: current.selectedId
          }
        } else if (!current.dirty) return
      } else if (!current.dirty) return
      window.pipeline.saveDraftNow(workflowId, draft)
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [readOnly, workflowId, version])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function applyDocument(document: WorkflowJsonDocument) {
    jsonEdited.current = false
    setName(document.name)
    setDescription(document.description)
    setGraph(document.graph)
    setJsonText(formatWorkflowJson(document))
    setJsonError(null)
    setDirty(true)
    const ids = new Set([...document.graph.inputs.map((input) => input.id), ...document.graph.steps.map((step) => step.id)])
    setSelectedId((current) => (current && ids.has(current) ? current : (document.graph.steps[0]?.id ?? document.graph.inputs[0]?.id ?? null)))
  }

  function documentForSave(): WorkflowJsonDocument | null {
    if (!jsonEdited.current) return { name, description, graph }
    const parsed = parseWorkflowJson(jsonText, { previous: graph })
    if (!parsed.ok) {
      setView('json')
      setJsonError(parsed.errors.join('\n'))
      return null
    }
    applyDocument(parsed.document)
    return parsed.document
  }

  function openBuilder() {
    if (jsonEdited.current) {
      const parsed = parseWorkflowJson(jsonText, { previous: graph })
      if (!parsed.ok) {
        setJsonError(parsed.errors.join('\n'))
        return
      }
      applyDocument(parsed.document)
    }
    setView('builder')
  }

  function onJsonKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const el = event.currentTarget
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = `${jsonText.slice(0, start)}  ${jsonText.slice(end)}`
    jsonEdited.current = true
    setJsonText(next)
    setJsonError(null)
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 2
    })
  }

  async function save() {
    if (readOnly) return
    const document = documentForSave()
    if (!document) return
    try {
      const next = await window.pipeline.saveWorkflow(workflowId, {
        name: document.name,
        description: document.description,
        graph: document.graph
      })
      setDetails(next)
      setDirty(false)
      snapshot.current = { ...snapshot.current, name: document.name, description: document.description, graph: document.graph, dirty: false }
      setRestored(false)
      notify(`Сохранено: версия ${next.version.version}`)
      if (version) onVersion(undefined)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  function edit(next: WorkflowGraph) {
    setGraph(next)
    setDirty(true)
    snapshot.current = { name, description, graph: next, selectedId, dirty: true }
    if (typeof window.pipeline.saveDraft !== 'function') return
    void window.pipeline
      .saveDraft(workflowId, { name, description, graph: next, selectedId })
      .catch((reason) => setError(errorText(reason)))
  }

  const selected = graph.steps.find((step) => step.id === selectedId) ?? null
  const issues = validateGraph(graph)

  if (!details) return <div className="page">{error ? <div className="error">{error}</div> : 'Загрузка…'}</div>

  const orderedSteps = topoSort(graph.steps)
  return (
    <VariablePoolsContext.Provider value={pools}>
    <div className="split">
      <aside className="rail">
        <button className="ghost" type="button" onClick={onBack}>
          К проекту
        </button>
        <p className="section-label">Входы</p>
        {graph.inputs.map((input) => (
          <button key={input.id} className="step-tab" type="button" onClick={() => setSelectedId(input.id)}>
            <span>{input.label}</span>
            <small>{input.type}</small>
          </button>
        ))}
        {!structureLocked && (
          <button
            className="ghost"
            type="button"
            onClick={() => {
              const input = createInput({ label: 'Новый вход' })
              const taken = new Set(graph.inputs.map((item) => item.name))
              input.name = uniqueKey(slugify(input.label), taken)
              edit({ ...graph, inputs: [...graph.inputs, input] })
              setSelectedId(input.id)
            }}
          >
            Добавить вход
          </button>
        )}
        <p className="section-label">Граф шагов</p>
        <div className="flow">
          {orderedSteps.ok &&
            orderedSteps.steps.map((step, index) => (
              <div key={step.id} className="flow-col">
                {index > 0 && <div className="flow-edge" />}
                <button className={`flow-node ${selectedId === step.id ? 'active' : ''}`} type="button" onClick={() => setSelectedId(step.id)}>
                  <span>{step.name}</span>
                  <small title={STEP_TYPE_HINT[step.type]}>{STEP_TYPE_LABEL[step.type]}</small>
                  {step.iterate && <em>массив → отдельные ветки</em>}
                </button>
              </div>
            ))}
        </div>
        {!structureLocked && (
          <div className="row" style={{ marginTop: 8 }}>
            {STEP_TYPES.map((type) => (
              <span key={type} className="type-chip">
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    const step = createStep(type, graph)
                    edit({ ...graph, steps: [...graph.steps, step] })
                    setSelectedId(step.id)
                  }}
                >
                  {STEP_TYPE_LABEL[type]}
                </button>
                <Hint text={STEP_TYPE_HINT[type]} />
              </span>
            ))}
          </div>
        )}
      </aside>
      <section className="inspector">
        <div className="split-head">
          <div>
            <input className="inline-input" value={name} disabled={readOnly || view === 'json'} onChange={(event) => { setName(event.target.value); setDirty(true) }} />
            <p className="meta">Версия {details.version.version}{dirty ? ' · черновик пишется сам' : ''}</p>
            {restored && <p className="meta">Черновик восстановлен после закрытия. «Сохранить версию» закрепит его.</p>}
          </div>
          <div className="row">
            <button className={view === 'builder' ? 'btn' : 'ghost'} type="button" onClick={openBuilder}>
              Конструктор
            </button>
            <button className={view === 'json' ? 'btn' : 'ghost'} type="button" onClick={() => setView('json')}>
              JSON
            </button>
            <select
              value={version ?? details.workflow.latestVersion}
              onChange={(event) => {
                const next = Number(event.target.value)
                onVersion(next === details.workflow.latestVersion ? undefined : next)
              }}
            >
              {details.versions.map((item) => (
                <option key={item.id} value={item.version}>
                  v{item.version}
                </option>
              ))}
            </select>
            <button className="btn" type="button" disabled={readOnly} onClick={() => void save()}>
              Сохранить версию
            </button>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                void window.pipeline.createRun(workflowId).then((run) => onOpenRun(run.run.id)).catch((reason) => setError(errorText(reason)))
              }}
            >
              Новый запуск
            </button>
          </div>
        </div>
        {view === 'builder' && (
        <label className="field">
          <span>Описание</span>
          <input value={description} disabled={readOnly} onChange={(event) => { setDescription(event.target.value); setDirty(true) }} />
        </label>
        )}
        {readOnly && <div className="banner">Просмотр старой версии. Сохранение создаёт изменения только из последней версии.</div>}
        {error && <div className="error">{error}</div>}
        {view === 'json' ? (
          <div>
            <p className="field-note">
              Объект с полями name, description, inputs и steps. Его можно целиком собрать в модели и вставить сюда. id лучше не писать: для новых шагов приложение создаст свои, а уже существующие оставит по ключу. dependsOn пишется ключом шага. Если текст изменился, сохранение проверяет синтаксис, форму шагов и граф.
            </p>
            <div className="row" style={{ marginBottom: 8 }}>
              <button
                className="ghost"
                type="button"
                onClick={() => void copyText(jsonText).then(() => notify('JSON скопирован'))}
              >
                Копировать
              </button>
            </div>
            <textarea
              className="json-editor"
              value={jsonText}
              disabled={readOnly}
              spellCheck={false}
              wrap="off"
              onChange={(event) => {
                jsonEdited.current = true
                setJsonText(event.target.value)
                setJsonError(null)
              }}
              onKeyDown={onJsonKeyDown}
            />
            {jsonError && <div className="error">{jsonError}</div>}
            {!jsonError && jsonText !== formatWorkflowJson({ name, description, graph }) && (
              <p className="meta">JSON изменён. Проверка выполнится при сохранении или при возврате в конструктор.</p>
            )}
          </div>
        ) : (
          <>
        {!!issues.length && <div className="banner">{issues.join('\n')}</div>}
        {graph.inputs.find((input) => input.id === selectedId) && (
          <InputEditor
            input={graph.inputs.find((input) => input.id === selectedId)!}
            readOnly={readOnly}
            onChange={(input) => edit({ ...graph, inputs: graph.inputs.map((item) => (item.id === input.id ? input : item)) })}
            onDelete={() => {
              edit({ ...graph, inputs: graph.inputs.filter((item) => item.id !== selectedId) })
              setSelectedId(null)
            }}
          />
        )}
        {selected && (
          <StepEditor
            graph={graph}
            step={selected}
            readOnly={readOnly}
            onChange={(step) => edit({ ...graph, steps: graph.steps.map((item) => (item.id === step.id ? step : item)) })}
            onDelete={() => {
              edit({
                ...graph,
                steps: graph.steps
                  .filter((item) => item.id !== selected.id)
                  .map((item) => ({ ...item, dependsOn: item.dependsOn.filter((dep) => dep !== selected.id) }))
              })
              setSelectedId(null)
            }}
            onMove={(direction) => {
              const ordered = [...graph.steps].sort((a, b) => a.order - b.order)
              const index = ordered.findIndex((item) => item.id === selected.id)
              const swap = index + direction
              if (swap < 0 || swap >= ordered.length) return
              const next = ordered.map((item, itemIndex) => ({ ...item, order: itemIndex + 1 }))
              const current = next[index]
              next[index] = next[swap]
              next[swap] = current
              edit({ ...graph, steps: next.map((item, itemIndex) => ({ ...item, order: itemIndex + 1 })) })
            }}
          />
        )}
          </>
        )}
      </section>
    </div>
    </VariablePoolsContext.Provider>
  )
}

function InputEditor({
  input,
  readOnly,
  onChange,
  onDelete
}: {
  input: InputDefinition
  readOnly: boolean
  onChange: (input: InputDefinition) => void
  onDelete: () => void
}) {
  return (
    <div>
      <h2>Вход</h2>
      <label className="field">
        <span>Подпись</span>
        <input value={input.label} disabled={readOnly} onChange={(event) => onChange({ ...input, label: event.target.value })} />
      </label>
      <label className="field">
        <span>Имя переменной</span>
        <input value={input.name} disabled={readOnly} onChange={(event) => onChange({ ...input, name: event.target.value })} />
      </label>
      <label className="field">
        <span>Тип</span>
        <select value={input.type} disabled={readOnly} onChange={(event) => onChange({ ...input, type: event.target.value as InputType })}>
          {INPUT_TYPES.map((type) => (
            <option key={type} value={type}>
              {INPUT_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={input.required} disabled={readOnly} onChange={(event) => onChange({ ...input, required: event.target.checked })} />
        Обязательный
      </label>
      <label className="field">
        <span>Описание</span>
        <textarea value={input.description} disabled={readOnly} onChange={(event) => onChange({ ...input, description: event.target.value })} />
      </label>
      {(input.type === 'select' || input.type === 'multi-select') && (
        <label className="field">
          <span>Варианты, по одному на строку</span>
          <textarea
            value={(input.options ?? []).join('\n')}
            disabled={readOnly}
            onChange={(event) => onChange({ ...input, options: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })}
          />
        </label>
      )}
      {!readOnly && (
        <button className="danger" type="button" onClick={onDelete}>
          Удалить вход
        </button>
      )}
    </div>
  )
}

function StepEditor({
  graph,
  step,
  readOnly,
  onChange,
  onDelete,
  onMove
}: {
  graph: WorkflowGraph
  step: StepDefinition
  readOnly: boolean
  onChange: (step: StepDefinition) => void
  onDelete: () => void
  onMove: (direction: number) => void
}) {
  return (
    <div>
      <div className="row">
        <h2 style={{ flex: 1 }}>{step.name}</h2>
        <button className="ghost" type="button" disabled={readOnly} onClick={() => onMove(-1)}>
          Выше
        </button>
        <button className="ghost" type="button" disabled={readOnly} onClick={() => onMove(1)}>
          Ниже
        </button>
      </div>
      <label className="field">
        <span>Название</span>
        <input value={step.name} disabled={readOnly} onChange={(event) => onChange({ ...step, name: event.target.value })} />
      </label>
      <label className="field">
        <span>Ключ для переменных</span>
        <input value={step.key} disabled={readOnly} onChange={(event) => onChange({ ...step, key: event.target.value })} />
      </label>
      <label className="field">
        <span>Тип</span>
        <select
          value={step.type}
          disabled={readOnly}
          onChange={(event) => {
            const fresh = createStep(event.target.value as StepType, { ...graph, steps: graph.steps.filter((item) => item.id !== step.id) })
            onChange({
              ...fresh,
              id: step.id,
              key: step.key,
              name: step.name,
              description: step.description,
              order: step.order,
              dependsOn: step.dependsOn,
              stopAfter: step.stopAfter,
              iterate: fresh.type === 'fanout' ? fresh.iterate : step.type === 'fanout' ? null : step.iterate
            })
          }}
        >
          {STEP_TYPES.map((type) => (
            <option key={type} value={type}>
              {STEP_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
        <p className="field-note">{STEP_TYPE_HINT[step.type]}</p>
      </label>
      <label className="field">
        <span>Зависит от</span>
        <select
          multiple
          value={step.dependsOn}
          disabled={readOnly}
          onChange={(event) =>
            onChange({
              ...step,
              dependsOn: [...event.target.selectedOptions].map((option) => option.value)
            })
          }
        >
          {graph.steps
            .filter((item) => item.id !== step.id)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={step.stopAfter} disabled={readOnly} onChange={(event) => onChange({ ...step, stopAfter: event.target.checked })} />
        Остановиться после этого шага
      </label>
      {step.type !== 'fanout' && (
      <fieldset>
        <legend className="section-label">Ветвление</legend>
        <p className="field-note">Если предыдущий шаг вернул массив, этот шаг выполнится отдельно для каждого элемента. Для новой схемы удобнее отдельный шаг «Элементы», а этот переключатель оставлен для уже собранных цепочек.</p>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(step.iterate)}
            disabled={readOnly}
            onChange={(event) =>
              onChange({
                ...step,
                iterate: event.target.checked ? { over: '', alias: 'item', launch: 'all' } : null
              })
            }
          />
          Выполнять для каждого элемента массива
        </label>
        {step.iterate && (
          <>
            <TemplateField label="Массив" value={step.iterate.over} graph={graph} step={step} readOnly={readOnly} rows={2} onChange={(over) => onChange({ ...step, iterate: { ...step.iterate!, over } })} />
            <label className="field">
              <span>Имя элемента</span>
              <input
                value={step.iterate.alias}
                disabled={readOnly}
                onChange={(event) => onChange({ ...step, iterate: { ...step.iterate!, alias: event.target.value } })}
              />
            </label>
            <label className="field">
              <span>Запуск веток</span>
              <select
                value={step.iterate.launch}
                disabled={readOnly}
                onChange={(event) =>
                  onChange({ ...step, iterate: { ...step.iterate!, launch: event.target.value as 'all' | 'manual' } })
                }
              >
                <option value="all">Все сразу</option>
                <option value="manual">Вручную, по одной</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(step.iterate.noteAlias)}
                disabled={readOnly}
                onChange={(event) =>
                  onChange({
                    ...step,
                    iterate: { ...step.iterate!, noteAlias: event.target.checked ? step.iterate!.noteAlias || 'note' : '' }
                  })
                }
              />
              Свой текст для каждого элемента
            </label>
            {step.iterate.noteAlias ? (
              <label className="field">
                <span>Имя этого текста</span>
                <input
                  value={step.iterate.noteAlias}
                  disabled={readOnly}
                  onChange={(event) => onChange({ ...step, iterate: { ...step.iterate!, noteAlias: event.target.value } })}
                />
                <p className="field-note">
                  Перед запуском элемента можно дописать текст. В этом шаге и внутри его веток он доступен как {`{{${step.iterate.noteAlias || 'note'}}}`}. Пустое поле подставится пустой строкой.
                </p>
              </label>
            ) : null}
          </>
        )}
      </fieldset>
      )}
      <StepConfig graph={graph} step={step} readOnly={readOnly} onChange={onChange} />
      {!readOnly && (
        <button className="danger" type="button" onClick={onDelete}>
          Удалить шаг
        </button>
      )}
    </div>
  )
}

function StepConfig({
  graph,
  step,
  readOnly,
  onChange
}: {
  graph: WorkflowGraph
  step: StepDefinition
  readOnly: boolean
  onChange: (step: StepDefinition) => void
}) {
  if (step.type === 'ai') {
    return (
      <div>
        <label className="field">
          <span>Модель</span>
          <input value={step.config.model} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, model: event.target.value } })} />
        </label>
        <label className="field">
          <span>Temperature</span>
          <input
            type="number"
            step="0.1"
            value={step.config.temperature ?? ''}
            disabled={readOnly}
            onChange={(event) =>
              onChange({
                ...step,
                config: { ...step.config, temperature: event.target.value === '' ? undefined : Number(event.target.value) }
              })
            }
          />
        </label>
        <label className="field">
          <span>Формат ответа</span>
          <select
            value={step.config.outputFormat}
            disabled={readOnly}
            onChange={(event) => onChange({ ...step, config: { ...step.config, outputFormat: event.target.value as 'text' | 'json' } })}
          >
            <option value="json">JSON</option>
            <option value="text">Текст</option>
          </select>
        </label>
        {step.config.outputFormat === 'json' && (
          <SchemaField
            value={step.config.jsonSchema}
            readOnly={readOnly}
            onChange={(jsonSchema) => onChange({ ...step, config: { ...step.config, jsonSchema } })}
          />
        )}
        <div className="messages">
          {step.config.messages.map((message) => (
            <div key={message.id} className="message">
              <label className="field">
                <span>Роль</span>
                <select
                  value={message.role}
                  disabled={readOnly}
                  onChange={(event) => updateMessage(step, message.id, { role: event.target.value as AIMessageDraft['role'] }, onChange)}
                >
                  <option value="system">system</option>
                  <option value="user">user</option>
                  <option value="assistant">assistant</option>
                </select>
              </label>
              <TemplateField
                label="Текст"
                value={message.content}
                graph={graph}
                step={step}
                readOnly={readOnly}
                onChange={(content) => updateMessage(step, message.id, { content }, onChange)}
              />
            </div>
          ))}
        </div>
        {!readOnly && (
          <button
            className="ghost"
            type="button"
            onClick={() =>
              onChange({
                ...step,
                config: { ...step.config, messages: [...step.config.messages, { id: createId(), role: 'user', content: '' }] }
              })
            }
          >
            Добавить сообщение
          </button>
        )}
      </div>
    )
  }
  if (step.type === 'transform') {
    return (
      <div>
        <label className="field">
          <span>Режим</span>
          <select
            value={step.config.mode}
            disabled={readOnly}
            onChange={(event) => onChange({ ...step, config: { ...step.config, mode: event.target.value as typeof step.config.mode } })}
          >
            <option value="template">Шаблон</option>
            <option value="extract">Извлечь значение</option>
            <option value="filter">Фильтр массива</option>
            <option value="script">Скрипт</option>
          </select>
        </label>
        {step.config.mode === 'template' && (
          <TemplateField label="Шаблон" value={step.config.template ?? ''} graph={graph} step={step} readOnly={readOnly} onChange={(template) => onChange({ ...step, config: { ...step.config, template } })} />
        )}
        {step.config.mode === 'extract' && (
          <TemplateField label="Источник" value={step.config.source ?? ''} graph={graph} step={step} readOnly={readOnly} rows={2} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
        )}
        {step.config.mode === 'filter' && (
          <>
            <TemplateField label="Массив" value={step.config.source ?? ''} graph={graph} step={step} readOnly={readOnly} rows={2} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
            <label className="field">
              <span>Поле</span>
              <input value={step.config.field ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, field: event.target.value } })} />
            </label>
          </>
        )}
        {step.config.mode === 'script' && (
          <label className="field">
            <span>Тело функции, доступен ctx</span>
            <textarea value={step.config.script ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, script: event.target.value } })} />
          </label>
        )}
      </div>
    )
  }
  if (step.type === 'fanout') {
    const iterate = step.iterate ?? { over: '', alias: 'item', launch: 'manual' as const }
    return (
      <div>
        <p className="field-note">
          Шаг только раскладывает массив. Шаги ниже него идут внутри каждой ветки, даже если ещё не запускались. Общим остаётся только шаг «Сборка», который собирает эти ветки. Элемент читается как{' '}
          <code>{`{{steps.${step.key}.output}}`}</code> или <code>{`{{${iterate.alias || 'item'}}}`}</code>. Ручной текст добавляется отдельным ручным шагом после этого.
        </p>
        <TemplateField
          label="Массив"
          value={iterate.over}
          graph={graph}
          step={step}
          readOnly={readOnly}
          rows={2}
          onChange={(over) => onChange({ ...step, type: 'fanout', iterate: { ...iterate, over }, config: {} })}
        />
        <label className="field">
          <span>Имя элемента</span>
          <input
            value={iterate.alias}
            disabled={readOnly}
            onChange={(event) => onChange({ ...step, type: 'fanout', iterate: { ...iterate, alias: event.target.value }, config: {} })}
          />
        </label>
        <label className="field">
          <span>Запуск веток</span>
          <select
            value={iterate.launch}
            disabled={readOnly}
            onChange={(event) =>
              onChange({
                ...step,
                type: 'fanout',
                iterate: { ...iterate, launch: event.target.value as 'all' | 'manual' },
                config: {}
              })
            }
          >
            <option value="all">Все сразу</option>
            <option value="manual">Вручную, по одной</option>
          </select>
        </label>
      </div>
    )
  }
  if (step.type === 'parse') {
    return (
      <div>
        <p className="field-note">Лучше просить AI шаг вернуть JSON по схеме. Разбор нужен, когда на руках уже есть текст или JSON-строка и из них надо получить массив для ветвления.</p>
        <TemplateField label="Источник" value={step.config.source} graph={graph} step={step} readOnly={readOnly} rows={2} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
        <label className="field">
          <span>Режим</span>
          <select
            value={step.config.mode}
            disabled={readOnly}
            onChange={(event) => onChange({ ...step, config: { ...step.config, mode: event.target.value as typeof step.config.mode } })}
          >
            <option value="json">JSON</option>
            <option value="regex">Regex</option>
            <option value="delimiter">Разделитель</option>
          </select>
        </label>
        {step.config.mode === 'regex' && (
          <label className="field">
            <span>Шаблон с именованными группами</span>
            <input value={step.config.pattern ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, pattern: event.target.value } })} />
          </label>
        )}
        {step.config.mode === 'delimiter' && (
          <label className="field">
            <span>Разделитель</span>
            <input value={step.config.delimiter ?? '\\n\\n'} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, delimiter: event.target.value } })} />
          </label>
        )}
      </div>
    )
  }
  if (step.type === 'manual') {
    return (
      <div>
        <label className="field">
          <span>Действие</span>
          <select
            value={step.config.mode}
            disabled={readOnly}
            onChange={(event) => onChange({ ...step, config: { ...step.config, mode: event.target.value as typeof step.config.mode } })}
          >
            <option value="select_one">Выбрать один</option>
            <option value="select_many">Выбрать несколько</option>
            <option value="text">Ввести текст</option>
            <option value="confirm">Подтвердить</option>
            <option value="edit_json">Править JSON</option>
            <option value="upload_image">Загрузить изображение</option>
            <option value="upload_file">Загрузить файл</option>
          </select>
        </label>
        <label className="field">
          <span>Подсказка</span>
          <input value={step.config.prompt} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, prompt: event.target.value } })} />
        </label>
        <TemplateField label="Источник" value={step.config.source ?? ''} graph={graph} step={step} readOnly={readOnly} rows={2} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
        <label className="check">
          <input type="checkbox" checked={Boolean(step.config.allowEmpty)} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, allowEmpty: event.target.checked } })} />
          {step.type === 'manual' && step.config.mode === 'text' ? 'Можно оставить пустым' : 'Можно ничего не выбирать'}
        </label>
        <label className="field">
          <span>Если пропустить, не выполнять</span>
          <select
            multiple
            value={step.config.skipStepIds ?? []}
            disabled={readOnly}
            onChange={(event) =>
              onChange({
                ...step,
                config: { ...step.config, skipStepIds: [...event.target.selectedOptions].map((option) => option.value) }
              })
            }
          >
            {graph.steps
              .filter((item) => item.id !== step.id)
              .sort((a, b) => a.order - b.order)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
          <p className="field-note">Для случая «модель задала вопросы». Если вопросов нет, на запуске нажмите «Пропустить» — отмеченные шаги, обычно следующий AI с вашими ответами, не вызовут модель.</p>
        </label>
      </div>
    )
  }
  if (step.type === 'merge' && step.config.mode === 'object') {
    const sources = step.config.sources
    return (
      <div>
        {sources.map((source, index) => (
          <div key={index} className="message">
            <label className="field">
              <span>Ключ</span>
              <input
                value={source.key}
                disabled={readOnly}
                onChange={(event) => {
                  const next = sources.map((item, itemIndex) => (itemIndex === index ? { ...item, key: event.target.value } : item))
                  onChange({ ...step, config: { mode: 'object', sources: next } })
                }}
              />
            </label>
            <TemplateField
              label="Значение"
              value={source.ref}
              graph={graph}
              step={step}
              readOnly={readOnly}
              rows={2}
              onChange={(ref) => {
                const next = sources.map((item, itemIndex) => (itemIndex === index ? { ...item, ref } : item))
                onChange({ ...step, config: { mode: 'object', sources: next } })
              }}
            />
          </div>
        ))}
      </div>
    )
  }
  if (step.type === 'input') {
    return (
      <div>
        {graph.inputs.map((input) => (
          <label key={input.id} className="check">
            <input
              type="checkbox"
              checked={step.config.keys.includes(input.name)}
              disabled={readOnly}
              onChange={(event) => {
                const keys = event.target.checked ? [...step.config.keys, input.name] : step.config.keys.filter((key) => key !== input.name)
                onChange({ ...step, config: { keys } })
              }}
            />
            {input.label}
          </label>
        ))}
      </div>
    )
  }
  return null
}

function updateMessage(
  step: Extract<StepDefinition, { type: 'ai' }>,
  id: string,
  patch: Partial<AIMessageDraft>,
  onChange: (step: StepDefinition) => void
) {
  onChange({
    ...step,
    config: {
      ...step.config,
      messages: step.config.messages.map((message) => (message.id === id ? { ...message, ...patch } : message))
    }
  })
}

function SchemaField({ value, readOnly, onChange }: { value: unknown; readOnly: boolean; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '')
  const [localError, setLocalError] = useState<string | null>(null)
  useEffect(() => {
    setText(value ? JSON.stringify(value, null, 2) : '')
  }, [value])
  return (
    <label className="field">
      <span>JSON Schema</span>
      <textarea
        value={text}
        disabled={readOnly}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (!text.trim()) {
            setLocalError(null)
            onChange(undefined)
            return
          }
          try {
            onChange(JSON.parse(text))
            setLocalError(null)
          } catch {
            setLocalError('Schema должна быть валидным JSON')
          }
        }}
      />
      {localError && <span>{localError}</span>}
    </label>
  )
}
