import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createId } from '@core/ids'
import { builderFlowLayout, placeStepAfterDependency, type BuilderSideBranch } from '@core/builder-flow'
import { createInput, createLinkedStep, createStep } from '@core/factories'
import { effectiveStep, validateGraph } from '@core/graph'
import { INPUT_TYPE_LABEL, STEP_TYPE_HINT, STEP_TYPE_LABEL, slugify, uniqueKey } from '@core/labels'
import {
  expandSharedMessage,
  findDuplicateGroups,
  isSharedRef,
  matchingSharedKey,
  messageSignature,
  retargetSharedKey,
  shareMatchingMessages,
  whenText,
  type DuplicateMessageGroup
} from '@core/shared-messages'
import { findMissingVariables } from '@core/missing-variables'
import { latestVariableVersion, type VariablePools } from '@core/variables'
import type { AIMessageBody, BranchLaunch, InputDefinition, InputType, MessageWhen, SharedMessage, StepDefinition, StepType, WorkflowChat, WorkflowDetails, WorkflowGraph, WorkflowSnippet } from '@core/types'
import { formatWorkflowJson, parseWorkflowJson, type WorkflowJsonDocument } from '@core/workflow-json'
import {
  copyText,
  errorText,
  Hint,
  MissingFocusContext,
  MissingNote,
  MissingVariablesContext,
  TemplateField,
  useMissing,
  useMissingSelection,
  VariablePicker,
  VariablePoolsContext
} from '../ui'

const STEP_TYPES: StepType[] = ['ai', 'transform', 'parse', 'fanout', 'manual', 'merge', 'input']
const INPUT_TYPES = Object.keys(INPUT_TYPE_LABEL) as InputType[]

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const ids = new Set(left)
  return right.every((id) => ids.has(id))
}

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
  const [graph, setGraph] = useState<WorkflowGraph>({ inputs: [], snippets: [], steps: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [restored, setRestored] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const snapshot = useRef({ name: '', description: '', graph, selectedId, dirty: false })
  const [pools, setPools] = useState<VariablePools>({})
  const [missingFocus, setMissingFocus] = useState<{ fieldId: string; nonce: number } | null>(null)
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
    const graphIssues = validateGraph(document.graph)
    if (graphIssues.length) {
      setError(graphIssues.join('\n'))
      return
    }
    try {
      const next = await window.pipeline.saveWorkflow(workflowId, {
        name: document.name,
        description: document.description,
        graph: document.graph
      })
      setError(null)
      setDetails(next)
      setDirty(false)
      snapshot.current = { ...snapshot.current, name: document.name, description: document.description, graph: document.graph, dirty: false }
      setRestored(false)
      const bumped = next.version.version !== details?.version.version
      notify(bumped ? `Сохранено: версия ${next.version.version}` : `Сохранено в версии ${next.version.version}`)
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
  const missing = useMemo(() => findMissingVariables(graph, pools), [graph, pools])
  const missingTargets = useMemo(() => new Set(missing.map((item) => item.targetId)), [missing])
  const issues = validateGraph(graph)
  const duplicates = findDuplicateGroups(graph)

  if (!details) return <div className="page">{error ? <div className="error">{error}</div> : 'Загрузка…'}</div>

  const flow = builderFlowLayout(graph.steps)
  return (
    <VariablePoolsContext.Provider value={pools}>
    <MissingVariablesContext.Provider value={missing}>
    <MissingFocusContext.Provider value={missingFocus}>
    <div className="split">
      <aside className="rail">
        <button className="ghost" type="button" onClick={onBack}>
          К проекту
        </button>
        <p className="section-label">Входы</p>
        {graph.inputs.map((input) => (
          <button key={input.id} className={tabClass(selectedId === input.id, missingTargets.has(input.id))} type="button" onClick={() => setSelectedId(input.id)}>
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
        <p className="section-label">Фрагменты</p>
        {(graph.snippets ?? []).map((snippet) => (
          <button key={snippet.key} className={tabClass(selectedId === `snippet:${snippet.key}`, missingTargets.has(`snippet:${snippet.key}`))} type="button" onClick={() => setSelectedId(`snippet:${snippet.key}`)}>
            <span>{snippet.key}</span>
            <small>{`{{snippets.${snippet.key}}}`}</small>
          </button>
        ))}
        {!structureLocked && (
          <button
            className="ghost"
            type="button"
            onClick={() => {
              const taken = new Set((graph.snippets ?? []).map((item) => item.key))
              const key = uniqueKey('block', taken)
              const snippets = [...(graph.snippets ?? []), { key, content: '' }]
              edit({ ...graph, snippets })
              setSelectedId(`snippet:${key}`)
            }}
          >
            Добавить фрагмент
          </button>
        )}
        <p className="section-label">Общие сообщения</p>
        {(graph.sharedMessages ?? []).map((shared) => (
          <button key={shared.id} className={tabClass(selectedId === `shared:${shared.key}`, missingTargets.has(`shared:${shared.key}`))} type="button" onClick={() => setSelectedId(`shared:${shared.key}`)}>
            <span>{shared.name || shared.key}</span>
            <small>{shared.key}</small>
          </button>
        ))}
        {!structureLocked && (
          <button
            className="ghost"
            type="button"
            onClick={() => {
              const taken = new Set((graph.sharedMessages ?? []).map((item) => item.key))
              const key = uniqueKey('message', taken)
              const sharedMessages = [
                ...(graph.sharedMessages ?? []),
                { id: createId(), key, name: 'Общее сообщение', role: 'user' as const, content: '' }
              ]
              edit({ ...graph, sharedMessages })
              setSelectedId(`shared:${key}`)
            }}
          >
            Добавить общее
          </button>
        )}
        {graph.runtime === 'playwright' && (
          <>
            <p className="section-label">Чаты</p>
            {(graph.chats ?? []).map((chat) => (
              <button key={chat.key} className={tabClass(selectedId === `chat:${chat.key}`, missingTargets.has(`chat:${chat.key}`))} type="button" onClick={() => setSelectedId(`chat:${chat.key}`)}>
                <span>{chat.key}</span>
                <small>{chat.scope === 'branch' ? 'в каждой ветке' : 'на запуск'}</small>
              </button>
            ))}
            {!structureLocked && (
              <button
                className="ghost"
                type="button"
                onClick={() => {
                  const taken = new Set((graph.chats ?? []).map((item) => item.key))
                  const key = uniqueKey('assistant', taken)
                  const chats = [...(graph.chats ?? []), { key, instruction: '', scope: 'run' as const }]
                  edit({ ...graph, chats })
                  setSelectedId(`chat:${key}`)
                }}
              >
                Добавить чат
              </button>
            )}
          </>
        )}
        <p className="section-label">Граф шагов</p>
        <div className="flow">
          {flow.orphans.map((side) => (
            <SideBranchBox key={side.root.id} side={side} graph={graph} selectedId={selectedId} missingTargets={missingTargets} onSelect={setSelectedId} />
          ))}
          {flow.blocks.map((block, index) => (
            <div key={block.step.id} className="flow-col">
              {(index > 0 || flow.orphans.length > 0) && <div className="flow-edge" />}
              <FlowNodeButton step={block.step} graph={graph} selectedId={selectedId} warn={missingTargets.has(block.step.id)} onSelect={setSelectedId} />
              {block.sides.map((side) => (
                <SideBranchBox key={side.root.id} side={side} graph={graph} selectedId={selectedId} missingTargets={missingTargets} onSelect={setSelectedId} />
              ))}
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
        <>
        <label className="field">
          <span>Описание</span>
          <input value={description} disabled={readOnly} onChange={(event) => { setDescription(event.target.value); setDirty(true) }} />
        </label>
        <label className="field">
          <span>Основа</span>
          <select
            value={graph.runtime ?? 'api'}
            disabled={readOnly}
            onChange={(event) => {
              if (event.target.value === 'playwright') {
                edit({ ...graph, runtime: 'playwright', chats: graph.chats ?? [] })
                return
              }
              edit({
                ...graph,
                runtime: undefined,
                chats: undefined,
                steps: graph.steps.map(clearStepChat)
              })
            }}
          >
            <option value="api">API-запрос</option>
            <option value="playwright">Playwright, чаты Qwen</option>
          </select>
          <p className="field-note">
            {graph.runtime === 'playwright'
              ? 'На запуске открываются чаты из преднастройки. Шаг дописывает в выбранный чат только новый текст. Новый запуск создаёт чаты заново.'
              : 'Каждый AI-шаг сам отправляет весь свой контекст в API.'}
          </p>
        </label>
        </>
        )}
        {readOnly && <div className="banner">Просмотр старой версии. Сохранение создаёт изменения только из последней версии.</div>}
        {error && <div className="error">{error}</div>}
        {view === 'json' ? (
          <div>
            <p className="field-note">
              Объект с полями name, description, inputs и steps. Повторяющиеся сообщения — sharedMessages, ссылка в шаге — shared. Для чатов Qwen в корне ещё runtime и chats. Его можно целиком собрать в модели и вставить сюда. id лучше не писать: для новых шагов приложение создаст свои, а уже существующие оставит по ключу. dependsOn пишется ключом шага. Если текст изменился, сохранение проверяет синтаксис, форму шагов и граф.
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
        {missingGroups(missing).map((group) => (
          <div className="banner" key={group.fieldId}>
            <p>
              {group.place}, {group.field}: {group.items.length === 1 ? 'переменная' : 'переменные'}{' '}
              {group.items.map((item) => `{{${item.path}}}`).join(', ')} {group.items.length === 1 ? 'не найдена' : 'не найдены'}.
            </p>
            {group.items.map((item) =>
              item.hint ? (
                <p key={item.path} className="meta">
                  {item.hint}
                </p>
              ) : null
            )}
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setSelectedId(group.targetId)
                setMissingFocus({ fieldId: group.fieldId, nonce: Date.now() })
              }}
            >
              Открыть
            </button>
          </div>
        ))}
        {!readOnly &&
          duplicates.map((group) => (
            <div className="banner" key={group.signature}>
              <p>
                Одинаковое сообщение в шагах {group.places.map((place) => `«${place.stepName}»`).join(', ')}: роль, текст и условие совпадают.
                {' '}
                {group.preview}
              </p>
              <button className="ghost" type="button" onClick={() => edit(shareMatchingMessages(graph, group.signature))}>
                {group.sharedKey ? 'Заменить общим везде' : 'Сделать общим и заменить везде'}
              </button>
            </div>
          ))}
        {selectedId?.startsWith('shared:') && (
          <SharedMessageEditor
            shared={(graph.sharedMessages ?? []).find((item) => item.key === selectedId.slice('shared:'.length)) ?? null}
            graph={graph}
            readOnly={readOnly}
            onChange={(shared, previousKey) => {
              const sharedMessages = (graph.sharedMessages ?? []).map((item) => (item.key === previousKey ? shared : item))
              edit({ ...graph, sharedMessages, steps: retargetSharedKey(graph.steps, previousKey, shared.key) })
              setSelectedId(`shared:${shared.key}`)
            }}
            onDelete={(key) => {
              edit(expandSharedMessage(graph, key))
              setSelectedId(null)
            }}
          />
        )}
        {selectedId?.startsWith('snippet:') && (
          <SnippetEditor
            snippet={(graph.snippets ?? []).find((item) => item.key === selectedId.slice('snippet:'.length)) ?? null}
            graph={graph}
            readOnly={readOnly}
            onChange={(snippet, previousKey) => {
              const snippets = (graph.snippets ?? []).map((item) => (item.key === previousKey ? snippet : item))
              edit({ ...graph, snippets })
              setSelectedId(`snippet:${snippet.key}`)
            }}
            onDelete={(key) => {
              edit({ ...graph, snippets: (graph.snippets ?? []).filter((item) => item.key !== key) })
              setSelectedId(null)
            }}
          />
        )}
        {selectedId?.startsWith('chat:') && graph.runtime === 'playwright' && (
          <ChatEditor
            chat={(graph.chats ?? []).find((item) => item.key === selectedId.slice('chat:'.length)) ?? null}
            graph={graph}
            readOnly={readOnly}
            onChange={(chat, previousKey) => {
              const chats = (graph.chats ?? []).map((item) => (item.key === previousKey ? chat : item))
              const steps = graph.steps.map((step) =>
                step.type === 'ai' && step.config.chat === previousKey ? { ...step, config: { ...step.config, chat: chat.key } } : step
              )
              edit({ ...graph, chats, steps })
              setSelectedId(`chat:${chat.key}`)
            }}
            onDelete={(key) => {
              edit({ ...graph, chats: (graph.chats ?? []).filter((item) => item.key !== key) })
              setSelectedId(null)
            }}
          />
        )}
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
            duplicates={duplicates}
            onOpenShared={(key) => setSelectedId(`shared:${key}`)}
            onShare={(signature) => edit(shareMatchingMessages(graph, signature))}
            onChange={(step) => {
              const previous = graph.steps.find((item) => item.id === step.id)
              let steps = graph.steps.map((item) => (item.id === step.id ? step : item))
              const depsChanged = !previous || !sameIds(previous.dependsOn, step.dependsOn)
              const sideChanged = Boolean(previous?.sideBranch) !== Boolean(step.sideBranch)
              if (depsChanged || sideChanged) steps = placeStepAfterDependency(steps, step.id)
              edit({ ...graph, steps })
            }}
            onLink={() => {
              const linked = createLinkedStep(selected, graph)
              edit({ ...graph, steps: [...graph.steps, linked] })
              setSelectedId(linked.id)
            }}
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
    </MissingFocusContext.Provider>
    </MissingVariablesContext.Provider>
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

function FlowNodeButton({
  step,
  graph,
  selectedId,
  warn = false,
  onSelect
}: {
  step: StepDefinition
  graph: WorkflowGraph
  selectedId: string | null
  warn?: boolean
  onSelect: (id: string) => void
}) {
  const resolved = effectiveStep(step, graph.steps)
  return (
    <button className={`flow-node${selectedId === step.id ? ' active' : ''}${warn ? ' warn' : ''}`} type="button" onClick={() => onSelect(step.id)}>
      <span>{step.name}</span>
      <small title={STEP_TYPE_HINT[resolved.type]}>
        {STEP_TYPE_LABEL[resolved.type]}
        {step.use ? ` ← ${step.use}` : ''}
      </small>
      {step.iterate && <em>массив → отдельные ветки</em>}
      {step.sideBranch && <em>доп. ветка</em>}
    </button>
  )
}

function SideBranchBox({
  side,
  graph,
  selectedId,
  missingTargets,
  onSelect
}: {
  side: BuilderSideBranch
  graph: WorkflowGraph
  selectedId: string | null
  missingTargets: Set<string>
  onSelect: (id: string) => void
}) {
  return (
    <div className="side-branch">
      <div className="side-branch-label">Доп. ветка</div>
      {side.steps.map((step, index) => (
        <div key={step.id} className="flow-col">
          {index > 0 && <div className="flow-edge" />}
          <FlowNodeButton step={step} graph={graph} selectedId={selectedId} warn={missingTargets.has(step.id)} onSelect={onSelect} />
        </div>
      ))}
    </div>
  )
}

function clearStepChat(step: StepDefinition): StepDefinition {
  if (step.type !== 'ai' || !step.config.chat) return step
  const { chat: _chat, ...config } = step.config
  return { ...step, config }
}

function tabClass(active: boolean, warn = false): string {
  return `step-tab${active ? ' active' : ''}${warn ? ' warn' : ''}`
}

function missingGroups(issues: ReturnType<typeof findMissingVariables>) {
  const groups: { fieldId: string; targetId: string; place: string; field: string; items: typeof issues }[] = []
  for (const issue of issues) {
    const group = groups.find((item) => item.fieldId === issue.fieldId)
    if (group) group.items.push(issue)
    else groups.push({ fieldId: issue.fieldId, targetId: issue.targetId, place: issue.place, field: issue.field, items: [issue] })
  }
  return groups
}

function ChatEditor({
  chat,
  graph,
  readOnly,
  onChange,
  onDelete
}: {
  chat: WorkflowChat | null
  graph: WorkflowGraph
  readOnly: boolean
  onChange: (chat: WorkflowChat, previousKey: string) => void
  onDelete: (key: string) => void
}) {
  if (!chat) return <p className="meta">Чат не найден</p>
  return (
    <div>
      <h2>Чат</h2>
      <label className="field">
        <span>Ключ</span>
        <input value={chat.key} disabled={readOnly} onChange={(event) => onChange({ ...chat, key: event.target.value }, chat.key)} />
        <p className="field-note">Шаг выбирает этот чат по ключу.</p>
      </label>
      <label className="field">
        <span>Где живёт</span>
        <select
          value={chat.scope}
          disabled={readOnly}
          onChange={(event) => onChange({ ...chat, scope: event.target.value as WorkflowChat['scope'] }, chat.key)}
        >
          <option value="run">Один на весь запуск</option>
          <option value="branch">Свой в каждой ветке</option>
        </select>
      </label>
      <TemplateField
        label="Инструкция"
        value={chat.instruction}
        graph={graph}
        readOnly={readOnly}
        rows={10}
        fieldId={`chat:${chat.key}:instruction`}
        onChange={(instruction) => onChange({ ...chat, instruction }, chat.key)}
      />
      <p className="field-note">Уходит один раз, когда AI-шаг впервые использует этот чат. Дальше шаги пишут в уже открытый. Можно вставить переменную и фото.</p>
      {!readOnly && (
        <button className="danger" type="button" onClick={() => onDelete(chat.key)}>
          Удалить чат
        </button>
      )}
    </div>
  )
}

function SharedMessageEditor({
  shared,
  graph,
  readOnly,
  onChange,
  onDelete
}: {
  shared: SharedMessage | null
  graph: WorkflowGraph
  readOnly: boolean
  onChange: (shared: SharedMessage, previousKey: string) => void
  onDelete: (key: string) => void
}) {
  if (!shared) return <p className="meta">Общее сообщение не найдено</p>
  const usedBy = graph.steps.filter(
    (step) => step.type === 'ai' && !step.use && step.config.messages.some((message) => isSharedRef(message) && message.shared === shared.key)
  )
  const body: AIMessageBody = { id: shared.id, role: shared.role, content: shared.content, ...(shared.when ? { when: shared.when } : {}) }
  return (
    <div>
      <h2>Общее сообщение</h2>
      <p className="field-note">Роль, текст и условие одни на весь workflow. В шаге меняется только положение среди других сообщений.</p>
      <label className="field">
        <span>Название</span>
        <input value={shared.name} disabled={readOnly} onChange={(event) => onChange({ ...shared, name: event.target.value }, shared.key)} />
      </label>
      <label className="field">
        <span>Ключ</span>
        <input value={shared.key} disabled={readOnly} onChange={(event) => onChange({ ...shared, key: event.target.value }, shared.key)} />
        <p className="field-note">В сообщении шага: {`{ "shared": "${shared.key || 'ключ'}" }`}</p>
      </label>
      <label className="field">
        <span>Роль</span>
        <select
          value={shared.role}
          disabled={readOnly}
          onChange={(event) => onChange({ ...shared, role: event.target.value as SharedMessage['role'] }, shared.key)}
        >
          <option value="system">system</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
        </select>
      </label>
      <TemplateField
        label="Текст"
        value={shared.content}
        graph={graph}
        readOnly={readOnly}
        fieldId={`shared:${shared.key}:content`}
        onChange={(content) => onChange({ ...shared, content }, shared.key)}
      />
      <MessageWhenField
        message={body}
        graph={graph}
        readOnly={readOnly}
        fieldId={`shared:${shared.key}:when`}
        onChange={(when) => onChange({ ...shared, when }, shared.key)}
      />
      <p className="field-note">
        {usedBy.length
          ? `Стоит в шагах ${usedBy.map((step) => `«${step.name}»`).join(', ')}.`
          : 'Пока ни один шаг его не вставил.'}
      </p>
      {!readOnly && (
        <button className="danger" type="button" onClick={() => onDelete(shared.key)}>
          Удалить общее
        </button>
      )}
      {!readOnly && usedBy.length > 0 && <p className="field-note">Удаление вернёт текст в каждый шаг, где стояла ссылка.</p>}
    </div>
  )
}

function SharedMessageSlot({
  sharedKey,
  shared,
  onOpen
}: {
  sharedKey: string
  shared: SharedMessage | undefined
  onOpen: () => void
}) {
  if (!shared) return <p className="error">Нет общего сообщения «{sharedKey}»</p>
  return (
    <div>
      <p className="field-note">Текст, роль и условие правятся в общем сообщении. Здесь можно сдвинуть его или убрать из шага.</p>
      <p>
        <strong>{shared.name || shared.key}</strong> <span className="meta">{shared.role}</span>
      </p>
      <p className="meta">{whenText(shared.when)}</p>
      <pre className="json">{shared.content || 'Пустой текст'}</pre>
      <button className="ghost" type="button" onClick={onOpen}>
        Открыть общее
      </button>
    </div>
  )
}

function SnippetEditor({
  snippet,
  graph,
  readOnly,
  onChange,
  onDelete
}: {
  snippet: WorkflowSnippet | null
  graph: WorkflowGraph
  readOnly: boolean
  onChange: (snippet: WorkflowSnippet, previousKey: string) => void
  onDelete: (key: string) => void
}) {
  if (!snippet) return <p className="meta">Фрагмент не найден</p>
  return (
    <div>
      <h2>Фрагмент</h2>
      <label className="field">
        <span>Ключ</span>
        <input
          value={snippet.key}
          disabled={readOnly}
          onChange={(event) => onChange({ ...snippet, key: event.target.value }, snippet.key)}
        />
        <p className="field-note">В промптах: {`{{snippets.${snippet.key || 'ключ'}}}`}</p>
      </label>
      <TemplateField
        label="Текст"
        value={snippet.content}
        graph={graph}
        readOnly={readOnly}
        rows={10}
        fieldId={`snippet:${snippet.key}:content`}
        onChange={(content) => onChange({ ...snippet, content }, snippet.key)}
      />
      {!readOnly && (
        <button className="danger" type="button" onClick={() => onDelete(snippet.key)}>
          Удалить фрагмент
        </button>
      )}
    </div>
  )
}

function StepEditor({
  graph,
  step,
  readOnly,
  duplicates,
  onOpenShared,
  onShare,
  onChange,
  onDelete,
  onLink,
  onMove
}: {
  graph: WorkflowGraph
  step: StepDefinition
  readOnly: boolean
  duplicates: DuplicateMessageGroup[]
  onOpenShared: (key: string) => void
  onShare: (signature: string) => void
  onChange: (step: StepDefinition) => void
  onDelete: () => void
  onLink: () => void
  onMove: (direction: number) => void
}) {
  const resolved = effectiveStep(step, graph.steps)
  const linked = Boolean(step.use)
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
        {!readOnly && !linked && (
          <button className="ghost" type="button" onClick={onLink}>
            Ссылка на этот шаг
          </button>
        )}
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
        <span>Ссылка на шаг (use)</span>
        <select
          value={step.use ?? ''}
          disabled={readOnly}
          onChange={(event) => {
            const use = event.target.value || undefined
            if (!use) {
              const { use: _drop, ...rest } = step
              onChange(rest as StepDefinition)
              return
            }
            const source = graph.steps.find((item) => item.key === use)
            if (!source) return
            const from = effectiveStep(source, graph.steps)
            onChange({
              ...step,
              use,
              type: from.type,
              config: structuredClone(from.config)
            } as StepDefinition)
          }}
        >
          <option value="">Нет — свой config</option>
          {graph.steps
            .filter((item) => item.id !== step.id && item.key !== step.key)
            .map((item) => (
              <option key={item.id} value={item.key}>
                {item.name} ({item.key})
              </option>
            ))}
        </select>
        <p className="field-note">
          Если задано, type и config берутся из того шага. Здесь можно менять только положение, зависимости и ветвление.
        </p>
      </label>
      <label className="field">
        <span>Тип</span>
        <select
          value={resolved.type}
          disabled={readOnly || linked}
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
        <p className="field-note">{STEP_TYPE_HINT[resolved.type]}</p>
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
        <p className="field-note">Шаг встанет сразу после этой зависимости. Доп. ветки одного шага идут целиком, одна за другой, а следующий шаг основной ветки — после них.</p>
      </label>
      <label className="check">
        <input type="checkbox" checked={step.stopAfter} disabled={readOnly} onChange={(event) => onChange({ ...step, stopAfter: event.target.checked })} />
        Остановиться после этого шага
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(step.sideBranch)}
          disabled={readOnly}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { ...step, sideBranch: true }
                : (() => {
                    const { sideBranch: _drop, ...rest } = step
                    return rest as StepDefinition
                  })()
            )
          }
        />
        Дополнительная ветка в схеме
      </label>
      <p className="field-note">Рисуется рамкой под шагом, от которого зависит, вместе со своей цепочкой. Основную колонку не расширяет.</p>
      {resolved.type !== 'fanout' && (
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
            <TemplateField label="Массив" value={step.iterate.over} graph={graph} step={step} readOnly={readOnly} rows={2} fieldId={`step:${step.id}:over`} onChange={(over) => onChange({ ...step, iterate: { ...step.iterate!, over } })} />
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
                  onChange({ ...step, iterate: { ...step.iterate!, launch: event.target.value as BranchLaunch } })
                }
              >
                <option value="all">Все сразу</option>
                <option value="sequence">Последовательно</option>
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
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(step.iterate.appendOnRerun)}
                disabled={readOnly}
                onChange={(event) =>
                  onChange({
                    ...step,
                    iterate: { ...step.iterate!, appendOnRerun: event.target.checked || undefined }
                  })
                }
              />
              Каждый повтор — новый ряд
            </label>
            <p className="field-note">Другой массив добавляется новым рядом. Если разбор снова вернул те же элементы, ряд не копируется.</p>
          </>
        )}
      </fieldset>
      )}
      {linked ? (
        <p className="banner">
          Содержимое шага из <code>{step.use}</code>. Правьте оригинал; здесь меняются только положение и ветвление.
        </p>
      ) : null}
      <StepConfig
        graph={graph}
        step={resolved}
        readOnly={readOnly || linked}
        duplicates={duplicates}
        onOpenShared={onOpenShared}
        onShare={readOnly || linked ? undefined : onShare}
        onChange={linked ? () => undefined : onChange}
      />
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
  duplicates,
  onOpenShared,
  onShare,
  onChange
}: {
  graph: WorkflowGraph
  step: StepDefinition
  readOnly: boolean
  duplicates: DuplicateMessageGroup[]
  onOpenShared: (key: string) => void
  onShare?: (signature: string) => void
  onChange: (step: StepDefinition) => void
}) {
  const promptRef = useRef<HTMLInputElement>(null)
  const promptMissing = useMissing(step.type === 'manual' ? `step:${step.id}:prompt` : undefined)
  useMissingSelection(`step:${step.id}:prompt`, step.type === 'manual' ? step.config.prompt : '', promptRef)
  if (step.type === 'ai') {
    const playwright = graph.runtime === 'playwright'
    return (
      <div>
        {playwright && (
          <label className="field">
            <span>Чат</span>
            <select
              value={step.config.chat ?? ''}
              disabled={readOnly}
              onChange={(event) =>
                onChange({
                  ...step,
                  config: { ...step.config, chat: event.target.value, provider: 'qwen', model: step.config.model || 'qwen' }
                })
              }
            >
              <option value="">Выберите чат</option>
              {(graph.chats ?? []).map((chat) => (
                <option key={chat.key} value={chat.key}>
                  {chat.key}
                </option>
              ))}
            </select>
            <p className="field-note">Каждое сообщение с ролью user уходит отдельно, сверху вниз, и ждёт ответ. Результат шага — ответ на последнее отправленное. Если чат ещё не открыт, его инструкция уходит перед этими сообщениями. system и assistant в чат не пишутся.</p>
          </label>
        )}
        {!playwright && (
        <label className="field">
          <span>Модель</span>
          <input value={step.config.model} disabled={readOnly} onChange={(event) => onChange({ ...step, config: { ...step.config, model: event.target.value } })} />
        </label>
        )}
        {!playwright && (
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
        )}
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
          {step.config.messages.map((message, index) => {
            const shared = isSharedRef(message) ? (graph.sharedMessages ?? []).find((item) => item.key === message.shared) : undefined
            const sameShared = !isSharedRef(message) ? matchingSharedKey(graph, message) : undefined
            const sameGroup = !isSharedRef(message) ? duplicates.find((item) => item.signature === messageSignature(message)) : undefined
            const otherSteps = sameGroup?.places.filter((place) => place.stepId !== step.id) ?? []
            const suggest = !readOnly && !isSharedRef(message) && (sameShared || otherSteps.length > 0)
            return (
              <div key={message.id} className={isSharedRef(message) ? 'message message-shared' : suggest ? 'message message-suggest' : 'message'}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="meta">{isSharedRef(message) ? `Общее ${index + 1}` : `Сообщение ${index + 1}`}</span>
                  {!readOnly && (
                    <div className="row">
                      <button className="ghost" type="button" disabled={index === 0} onClick={() => moveMessage(step, index, -1, onChange)}>
                        Выше
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        disabled={index === step.config.messages.length - 1}
                        onClick={() => moveMessage(step, index, 1, onChange)}
                      >
                        Ниже
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() =>
                          onChange({
                            ...step,
                            config: { ...step.config, messages: step.config.messages.filter((item) => item.id !== message.id) }
                          })
                        }
                      >
                        Удалить
                      </button>
                    </div>
                  )}
                </div>
                {isSharedRef(message) ? (
                  <SharedMessageSlot
                    sharedKey={message.shared}
                    shared={shared}
                    onOpen={() => onOpenShared(message.shared)}
                  />
                ) : (
                  <>
                    {suggest && onShare && (
                      <div className="banner">
                        <p>
                          {sameShared
                            ? `Совпадает с общим «${(graph.sharedMessages ?? []).find((item) => item.key === sameShared)?.name || sameShared}».${otherSteps.length ? ` Такое же есть в шагах ${otherSteps.map((place) => `«${place.stepName}»`).join(', ')}.` : ''} Ссылка встанет во все такие сообщения, в шаге останется только положение.`
                            : `Такое же сообщение есть в шагах ${otherSteps.map((place) => `«${place.stepName}»`).join(', ')}. Его можно сделать общим: роль, текст и условие станут одними, во всех этих шагах останется только положение.`}
                        </p>
                        <button className="ghost" type="button" onClick={() => onShare(messageSignature(message))}>
                          {sameShared ? 'Заменить общим везде' : 'Сделать общим'}
                        </button>
                      </div>
                    )}
                    <label className="field">
                      <span>Роль</span>
                      <select
                        value={message.role}
                        disabled={readOnly}
                        onChange={(event) => updateMessage(step, message.id, { role: event.target.value as AIMessageBody['role'] }, onChange)}
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
                      fieldId={`step:${step.id}:message:${message.id}`}
                      onChange={(content) => updateMessage(step, message.id, { content }, onChange)}
                    />
                    <MessageWhenField
                      fieldId={`step:${step.id}:message:${message.id}:when`}
                      message={message}
                      graph={graph}
                      step={step}
                      readOnly={readOnly}
                      onChange={(when) => updateMessage(step, message.id, { when }, onChange)}
                    />
                  </>
                )}
              </div>
            )
          })}
        </div>
        {!readOnly && (
          <div className="row">
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
            {(graph.sharedMessages ?? []).length > 0 && (
              <label className="field" style={{ margin: 0, minWidth: 220 }}>
                <span>Вставить общее</span>
                <select
                  value=""
                  onChange={(event) => {
                    const key = event.target.value
                    if (!key) return
                    onChange({
                      ...step,
                      config: { ...step.config, messages: [...step.config.messages, { id: createId(), shared: key }] }
                    })
                  }}
                >
                  <option value="">Вставить общее…</option>
                  {(graph.sharedMessages ?? []).map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name || item.key}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
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
          <TemplateField label="Шаблон" value={step.config.template ?? ''} graph={graph} step={step} readOnly={readOnly} fieldId={`step:${step.id}:template`} onChange={(template) => onChange({ ...step, config: { ...step.config, template } })} />
        )}
        {step.config.mode === 'extract' && (
          <TemplateField label="Источник" value={step.config.source ?? ''} graph={graph} step={step} readOnly={readOnly} rows={2} fieldId={`step:${step.id}:source`} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
        )}
        {step.config.mode === 'filter' && (
          <>
            <TemplateField label="Массив" value={step.config.source ?? ''} graph={graph} step={step} readOnly={readOnly} rows={2} fieldId={`step:${step.id}:source`} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
            <MissingNote fieldId={`step:${step.id}:value`} />
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
          fieldId={`step:${step.id}:over`}
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
                iterate: { ...iterate, launch: event.target.value as BranchLaunch },
                config: {}
              })
            }
          >
            <option value="all">Все сразу</option>
            <option value="sequence">Последовательно</option>
            <option value="manual">Вручную, по одной</option>
          </select>
          <p className="field-note">Последовательно ветки идут сами, одна за другой. Следующее сообщение в общий чат уходит после ответа на предыдущее.</p>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(iterate.appendOnRerun)}
            disabled={readOnly}
            onChange={(event) =>
              onChange({
                ...step,
                type: 'fanout',
                iterate: { ...iterate, appendOnRerun: event.target.checked || undefined },
                config: {}
              })
            }
          />
          Каждый повтор — новый ряд
        </label>
        <p className="field-note">Другой массив добавляется новым рядом. Если разбор снова вернул те же элементы, ряд не копируется.</p>
      </div>
    )
  }
  if (step.type === 'parse') {
    return (
      <div>
        <p className="field-note">Лучше просить AI шаг вернуть JSON по схеме. Разбор нужен, когда на руках уже есть текст или JSON-строка и из них надо получить массив для ветвления.</p>
        <TemplateField label="Источник" value={step.config.source} graph={graph} step={step} readOnly={readOnly} rows={2} fieldId={`step:${step.id}:source`} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
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
          <input
            ref={promptRef}
            className={promptMissing.length ? 'missing-input' : undefined}
            value={step.config.prompt}
            disabled={readOnly}
            onChange={(event) => onChange({ ...step, config: { ...step.config, prompt: event.target.value } })}
          />
          <MissingNote fieldId={`step:${step.id}:prompt`} />
        </label>
        <TemplateField label="Источник" value={step.config.source ?? ''} graph={graph} step={step} readOnly={readOnly} rows={2} fieldId={`step:${step.id}:source`} onChange={(source) => onChange({ ...step, config: { ...step.config, source } })} />
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
              fieldId={`step:${step.id}:merge:${index}`}
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

function moveMessage(
  step: Extract<StepDefinition, { type: 'ai' }>,
  index: number,
  direction: -1 | 1,
  onChange: (step: StepDefinition) => void
) {
  const next = index + direction
  const messages = [...step.config.messages]
  if (next < 0 || next >= messages.length) return
  const [item] = messages.splice(index, 1)
  messages.splice(next, 0, item)
  onChange({ ...step, config: { ...step.config, messages } })
}

function updateMessage(
  step: Extract<StepDefinition, { type: 'ai' }>,
  id: string,
  patch: Partial<AIMessageBody>,
  onChange: (step: StepDefinition) => void
) {
  onChange({
    ...step,
    config: {
      ...step.config,
      messages: step.config.messages.map((message) => (message.id === id && !isSharedRef(message) ? { ...message, ...patch } : message))
    }
  })
}

function MessageWhenField({
  message,
  graph,
  step,
  readOnly,
  fieldId,
  onChange
}: {
  message: AIMessageBody
  graph: WorkflowGraph
  step?: StepDefinition
  readOnly: boolean
  fieldId?: string
  onChange: (when: MessageWhen | undefined) => void
}) {
  const mode = message.when?.op ?? 'always'
  const paths = message.when?.paths ?? []
  const missing = useMissing(fieldId)
  const pathRef = useRef<HTMLInputElement>(null)
  useMissingSelection(fieldId, missing[0]?.path ?? '', pathRef)
  function setPaths(op: 'and' | 'or', next: string[]) {
    onChange({ op, paths: next })
  }
  return (
    <div>
      <label className="field">
        <span>Отправлять сообщение</span>
        <select
          value={mode}
          disabled={readOnly}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'always') onChange(undefined)
            else setPaths(value as 'and' | 'or', paths.length ? paths : [''])
          }}
        >
          <option value="always">всегда</option>
          <option value="and">если все переменные есть</option>
          <option value="or">если хотя бы одна переменная есть</option>
        </select>
      </label>
      {message.when && (
        <>
          <p className="field-note">Пустая переменная пропускает всё сообщение, а не кусок текста. Несколько путей складываются через «все» или «хотя бы одна».</p>
          {paths.map((path, index) => {
            const bad = missing.some((issue) => issue.path === path)
            return (
            <label className={bad ? 'field has-missing' : 'field'} key={`${message.id}-${index}`}>
              <span>Переменная {index + 1}</span>
              <input
                ref={path === missing[0]?.path ? pathRef : undefined}
                value={path}
                disabled={readOnly}
                placeholder="inputs.ref"
                onChange={(event) => setPaths(message.when!.op, paths.map((item, itemIndex) => (itemIndex === index ? event.target.value.trim() : item)))}
              />
            </label>
            )
          })}
          <MissingNote fieldId={fieldId} />
          {!readOnly && (
            <div className="row">
              <VariablePicker
                graph={graph}
                step={step}
                onPick={(path) => {
                  const empty = paths.findIndex((item) => !item.trim())
                  if (empty >= 0) setPaths(message.when!.op, paths.map((item, itemIndex) => (itemIndex === empty ? path : item)))
                  else setPaths(message.when!.op, [...paths, path])
                }}
              />
              <button className="ghost" type="button" onClick={() => setPaths(message.when!.op, [...paths, ''])}>
                Добавить переменную
              </button>
              {paths.length > 1 && (
                <button className="ghost" type="button" onClick={() => setPaths(message.when!.op, paths.slice(0, -1))}>
                  Убрать последнюю
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
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
