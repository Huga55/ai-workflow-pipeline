import { useEffect, useState } from 'react'
import { hiddenDescendantIds, innerDependents, topoSort } from '@core/graph'
import { isStoredFile, toMediaUrl } from '@core/media'
import type { RunDetails, StepDefinition, StepExecution, StoredFile, UserActionPayload } from '@core/types'
import { copyText, errorText, JsonView, StatusPill, whenText } from '../ui'

export function RunPage({
  runId,
  onBack,
  onOpenWorkflow,
  onOpenRun,
  notify
}: {
  runId: string
  onBack: () => void
  onOpenWorkflow: (workflowId: string, version?: number) => void
  onOpenRun: (runId: string) => void
  notify: (message: string) => void
}) {
  const [details, setDetails] = useState<RunDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [untilStepId, setUntilStepId] = useState('')
  const [title, setTitle] = useState('')

  async function reload() {
    const next = await window.pipeline.getRun(runId)
    setDetails(next)
    setTitle((current) => (current ? current : next.run.title))
  }

  useEffect(() => {
    void reload().catch((reason) => setError(errorText(reason)))
    return window.pipeline.onRunUpdated((id) => {
      if (id === runId) void reload().catch((reason) => setError(errorText(reason)))
    })
  }, [runId])

  async function act(work: () => Promise<RunDetails>) {
    setBusy(true)
    setError(null)
    try {
      setDetails(await work())
    } catch (reason) {
      setError(errorText(reason))
      await reload().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  if (!details) return <div className="page">{error ? <div className="error">{error}</div> : 'Загрузка…'}</div>
  const { run, graph } = details
  const started = details.executions.length > 0

  return (
    <div className="page wide">
      <button className="ghost" type="button" onClick={onBack}>
        К проекту
      </button>
      <div className="page-head" style={{ marginTop: 12 }}>
        <div>
          <input
            className="title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (title.trim() === run.title) return
              void act(() => window.pipeline.updateRunTitle(run.id, title))
            }}
          />
          <p className="lede">
            <button className="ghost" type="button" onClick={() => onOpenWorkflow(run.workflowId, details.versionNumber)}>
              {details.workflowName} v{details.versionNumber}
            </button>
            {' · '}
            {whenText(run.createdAt)}
          </p>
        </div>
        <div className="row">
          <StatusPill status={run.status} />
          {run.status === 'running' ? (
            <button className="danger" type="button" onClick={() => void act(() => window.pipeline.cancelRun(run.id))}>
              Остановить
            </button>
          ) : (
            <>
              {!started && (
                <select value={untilStepId} onChange={(event) => setUntilStepId(event.target.value)}>
                  <option value="">До конца</option>
                  {graph.steps.map((step) => (
                    <option key={step.id} value={step.id}>
                      До шага: {step.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    started
                      ? window.pipeline.continueRun(run.id, { startManualBranches: true })
                      : window.pipeline.startRun(run.id, { untilStepId: untilStepId || undefined })
                  )
                }
              >
                {started ? 'Продолжить готовые ветки' : 'Запустить'}
              </button>
              <button
                className="ghost"
                type="button"
                onClick={() => {
                  void window.pipeline
                    .duplicateRun(run.id)
                    .then((next) => onOpenRun(next.run.id))
                    .catch((reason) => setError(errorText(reason)))
                }}
              >
                Запустить заново
              </button>
            </>
          )}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {run.error && <div className="error">{run.error}</div>}
      {!started && <InputForm details={details} busy={busy} onSaved={setDetails} onError={setError} />}
      <div style={{ marginTop: 22 }}>
        <ScopeView details={details} parentBranchId="" entryStepId={null} busy={busy} act={act} notify={notify} />
      </div>
    </div>
  )
}

function InputForm({
  details,
  busy,
  onSaved,
  onError
}: {
  details: RunDetails
  busy: boolean
  onSaved: (details: RunDetails) => void
  onError: (message: string) => void
}) {
  const [inputs, setInputs] = useState(details.run.inputs)
  useEffect(() => setInputs(details.run.inputs), [details.run.id])

  async function save(next: Record<string, unknown>) {
    setInputs(next)
    try {
      onSaved(await window.pipeline.updateRunInputs(details.run.id, next))
    } catch (reason) {
      onError(errorText(reason))
    }
  }

  return (
    <div className="panel" style={{ padding: 16, marginTop: 18 }}>
      <h2>Входы запуска</h2>
      {details.graph.inputs.map((input) => (
        <InputControl
          key={input.id}
          label={input.label}
          description={input.description}
          required={input.required}
          type={input.type}
          options={input.options}
          value={inputs[input.name]}
          disabled={busy}
          onChange={(value) => void save({ ...inputs, [input.name]: value })}
        />
      ))}
    </div>
  )
}

function InputControl({
  label,
  description,
  required,
  type,
  options,
  value,
  disabled,
  onChange
}: {
  label: string
  description: string
  required: boolean
  type: string
  options?: string[]
  value: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  const [jsonError, setJsonError] = useState<string | null>(null)
  const title = `${label}${required ? ' *' : ''}`
  if (type === 'text') {
    return (
      <label className="field">
        <span>{title}</span>
        <textarea value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
        {description && <span>{description}</span>}
      </label>
    )
  }
  if (type === 'boolean') {
    return (
      <label className="check">
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        {title}
      </label>
    )
  }
  if (type === 'number') {
    return (
      <label className="field">
        <span>{title}</span>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
        />
      </label>
    )
  }
  if (type === 'select') {
    return (
      <label className="field">
        <span>{title}</span>
        <select value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">Выберите</option>
          {(options ?? []).map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    )
  }
  if (type === 'multi-select') {
    const selected = Array.isArray(value) ? value.map(String) : []
    return (
      <div className="field">
        <span>{title}</span>
        {(options ?? []).map((option) => (
          <label key={option} className="check">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))}
            />
            {option}
          </label>
        ))}
      </div>
    )
  }
  if (type === 'json' || type === 'json[]') {
    return (
      <label className="field">
        <span>{title}</span>
        <textarea
          defaultValue={value == null ? '' : JSON.stringify(value, null, 2)}
          disabled={disabled}
          onBlur={(event) => {
            if (!event.target.value.trim()) {
              onChange(null)
              return
            }
            try {
              onChange(JSON.parse(event.target.value))
              setJsonError(null)
            } catch {
              setJsonError('JSON не разобран')
            }
          }}
        />
        {jsonError && <span>{jsonError}</span>}
      </label>
    )
  }
  if (type === 'image' || type === 'file' || type === 'image[]' || type === 'file[]') {
    const multiple = type.endsWith('[]')
    const kind = type.startsWith('image') ? 'image' : 'file'
    const files = multiple ? (Array.isArray(value) ? value : []) : value ? [value] : []
    return (
      <div className="field">
        <span>{title}</span>
        {description && <span>{description}</span>}
        <div className="row">
          {files.map((file) =>
            isStoredFile(file, 'image') ? (
              <img key={(file as StoredFile).path} className="preview" alt={(file as StoredFile).name} src={toMediaUrl((file as StoredFile).path)} />
            ) : (
              <span key={(file as StoredFile).path} className="meta">
                {(file as StoredFile).name}
              </span>
            )
          )}
        </div>
        <button
          className="ghost"
          type="button"
          disabled={disabled}
          onClick={() => {
            void window.pipeline.pickFiles(kind, multiple).then((picked) => {
              if (!picked.length) return
              onChange(multiple ? [...files, ...picked] : picked[0])
            })
          }}
        >
          Выбрать файл
        </button>
      </div>
    )
  }
  return (
    <label className="field">
      <span>{title}</span>
      <input value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      {description && <span>{description}</span>}
    </label>
  )
}

function ScopeView({
  details,
  steps,
  parentBranchId,
  entryStepId,
  depth = 0,
  busy,
  act,
  notify
}: {
  details: RunDetails
  steps?: StepDefinition[]
  parentBranchId: string
  entryStepId: string | null
  depth?: number
  busy: boolean
  act: (work: () => Promise<RunDetails>) => Promise<void>
  notify: (message: string) => void
}) {
  const source = steps ?? details.graph.steps
  const hidden = hiddenDescendantIds(source, entryStepId)
  const local = source.filter((step) => !hidden.has(step.id))
  const sorted = topoSort(local)
  if (!sorted.ok) return <div className="error">{sorted.message}</div>
  return (
    <div className="flow">
      {sorted.steps.map((step, index) => (
        <div key={step.id} className="flow-col">
          {index > 0 && <div className="flow-edge" />}
          {step.iterate && step.id !== entryStepId ? (
            <FanoutView details={details} step={step} source={source} parentBranchId={parentBranchId} depth={depth} busy={busy} act={act} notify={notify} />
          ) : (
            <ExecutionCard details={details} step={step} branchId={parentBranchId} busy={busy} act={act} notify={notify} />
          )}
        </div>
      ))}
    </div>
  )
}

function FanoutView({
  details,
  step,
  source,
  parentBranchId,
  depth,
  busy,
  act,
  notify
}: {
  details: RunDetails
  step: StepDefinition
  source: StepDefinition[]
  parentBranchId: string
  depth: number
  busy: boolean
  act: (work: () => Promise<RunDetails>) => Promise<void>
  notify: (message: string) => void
}) {
  const branches = details.branches
    .filter((branch) => branch.parentBranchId === parentBranchId && branch.sourceStepId === step.id)
    .sort((a, b) => a.itemIndex - b.itemIndex)
  const marker = latest(details.executions, step.id, parentBranchId)
  const inner = [step, ...innerDependents(step.id, source)]
  return (
    <div className="flow-fan">
      <article className="flow-node static">
        <strong>{step.name}</strong>
        <span className="meta">{branches.length ? `${branches.length} веток` : 'ветвление по массиву'}</span>
        <RunActions details={details} step={step} branchId={parentBranchId} busy={busy} act={act} />
      </article>
      {marker?.meta.fanoutError && <div className="error">{marker.error}</div>}
      <div className={`flow-branches${depth > 0 ? ' nested' : ''}`}>
        {branches.map((branch) => (
          <div key={branch.id} className="flow-branch">
            <div className="flow-edge" />
            <div className="branch-head">
              <div className="row">
                <strong>{branch.label}</strong>
                <StatusPill status={branch.status} />
              </div>
              {branch.status === 'pending' && (
                <button className="btn" type="button" disabled={busy} onClick={() => void act(() => window.pipeline.continueRun(details.run.id, { branchId: branch.id }))}>
                  Продолжить эту ветку
                </button>
              )}
            </div>
            <ScopeView details={details} steps={inner} parentBranchId={branch.id} entryStepId={step.id} depth={depth + 1} busy={busy} act={act} notify={notify} />
          </div>
        ))}
      </div>
    </div>
  )
}

function latest(executions: StepExecution[], stepId: string, branchId: string): StepExecution | undefined {
  return executions
    .filter((item) => item.stepId === stepId && item.branchId === branchId)
    .sort((a, b) => b.attempt - a.attempt)[0]
}

function ExecutionCard({
  details,
  step,
  branchId,
  busy,
  act,
  notify
}: {
  details: RunDetails
  step: StepDefinition
  branchId: string
  busy: boolean
  act: (work: () => Promise<RunDetails>) => Promise<void>
  notify: (message: string) => void
}) {
  const attempts = details.executions
    .filter((item) => item.stepId === step.id && item.branchId === branchId)
    .sort((a, b) => b.attempt - a.attempt)
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const execution = attempts.find((item) => item.id === attemptId) ?? attempts[0]
  const artifact = details.artifacts.find((item) => item.stepExecutionId === execution?.id && item.name === 'output')
  if (!execution && !step.iterate) {
    return (
      <article className="execution">
        <header>
          <strong>{step.name}</strong>
          <StatusPill status="pending" />
        </header>
        <RunActions details={details} step={step} branchId={branchId} busy={busy} act={act} />
      </article>
    )
  }
  if (!execution) return null
  return (
    <article className="execution">
      <header>
        <strong>{step.name}</strong>
        <StatusPill status={execution.status} />
      </header>
      <p className="meta">
        Попытка {execution.attempt}
        {execution.durationMs != null ? ` · ${execution.durationMs} мс` : ''}
        {execution.meta.provider ? ` · ${execution.meta.provider} / ${execution.meta.model ?? ''}` : ''}
      </p>
      {attempts.length > 1 && (
        <div className="attempts">
          {attempts.map((item) => (
            <button key={item.id} className={item.id === execution.id ? 'on' : ''} type="button" onClick={() => setAttemptId(item.id)}>
              #{item.attempt} {item.status}
            </button>
          ))}
        </div>
      )}
      {execution.error && <div className="error">{execution.error}</div>}
      {execution.status === 'waiting_for_user' && execution.meta.waiting && (
        <ManualForm
          details={details}
          execution={execution}
          busy={busy}
          onSubmit={(payload) => void act(() => window.pipeline.submitUserAction(details.run.id, execution.id, payload))}
        />
      )}
      {artifact && (
        <div>
          <div className="row">
            <span className="meta">Результат · {artifact.kind}</span>
            <button
              className="ghost"
              type="button"
              onClick={() => void copyText(typeof artifact.value === 'string' ? artifact.value : JSON.stringify(artifact.value, null, 2)).then(() => notify('Скопировано'))}
            >
              Копировать
            </button>
          </div>
          <JsonView value={artifact.value} />
        </div>
      )}
      {execution.rawResponse && (
        <details>
          <summary>Сырой ответ</summary>
          <div className="row">
            <button className="ghost" type="button" onClick={() => void copyText(execution.rawResponse ?? '').then(() => notify('Сырой ответ скопирован'))}>
              Копировать raw
            </button>
          </div>
          <pre className="raw">{execution.rawResponse}</pre>
        </details>
      )}
      {execution.request != null && (
        <details>
          <summary>Запрос</summary>
          <pre className="raw">{JSON.stringify(execution.request, null, 2)}</pre>
        </details>
      )}
      {execution.status !== 'running' && execution.status !== 'waiting_for_user' && (
        <RunActions details={details} step={step} branchId={branchId} busy={busy} act={act} />
      )}
    </article>
  )
}

function RunActions({
  details,
  step,
  branchId,
  busy,
  act
}: {
  details: RunDetails
  step: StepDefinition
  branchId: string
  busy: boolean
  act: (work: () => Promise<RunDetails>) => Promise<void>
}) {
  if (details.run.status === 'running') return null
  const latest = details.executions
    .filter((item) => item.stepId === step.id && item.branchId === branchId && !item.meta.fanoutError)
    .sort((a, b) => b.attempt - a.attempt)[0]
  const canSkip = !latest || (latest.status !== 'completed' && latest.status !== 'skipped' && latest.status !== 'running' && latest.status !== 'waiting_for_user')
  return (
    <div className="row">
      <button className="btn" type="button" disabled={busy} onClick={() => void act(() => window.pipeline.runStep(details.run.id, step.id, branchId, 'only'))}>
        Только этот шаг
      </button>
      <button className="ghost" type="button" disabled={busy} onClick={() => void act(() => window.pipeline.runStep(details.run.id, step.id, branchId, 'chain'))}>
        Отсюда дальше
      </button>
      {canSkip && (
        <button className="ghost" type="button" disabled={busy} onClick={() => void act(() => window.pipeline.skipStep(details.run.id, step.id, branchId))}>
          Пропустить
        </button>
      )}
    </div>
  )
}

function SkipFollowup({
  details,
  waiting,
  busy,
  onSubmit
}: {
  details: RunDetails
  waiting: NonNullable<StepExecution['meta']['waiting']>
  busy: boolean
  onSubmit: (payload: UserActionPayload) => void
}) {
  const names = (waiting.skipStepIds ?? [])
    .map((id) => details.graph.steps.find((step) => step.id === id)?.name)
    .filter((name): name is string => Boolean(name))
  return (
    <>
      <button className="ghost" type="button" disabled={busy} onClick={() => onSubmit({ type: 'skip' })}>
        Вопросов нет, пропустить
      </button>
      {names.length > 0 && <span className="meta">Не выполнятся: {names.join(', ')}</span>}
    </>
  )
}

function ManualForm({
  details,
  execution,
  busy,
  onSubmit
}: {
  details: RunDetails
  execution: StepExecution
  busy: boolean
  onSubmit: (payload: UserActionPayload) => void
}) {
  const waiting = execution.meta.waiting
  const [optionId, setOptionId] = useState('')
  const [optionIds, setOptionIds] = useState<string[]>([])
  const [text, setText] = useState('')
  const [jsonText, setJsonText] = useState(waiting?.value != null ? JSON.stringify(waiting.value, null, 2) : '')
  if (!waiting) return null
  if (waiting.mode === 'select_one' || waiting.mode === 'select_many') {
    return (
      <div>
        <p>{waiting.prompt}</p>
        {(waiting.options ?? []).map((option) => (
          <label key={option.id} className="choice">
            <input
              type={waiting.mode === 'select_one' ? 'radio' : 'checkbox'}
              name={execution.id}
              checked={waiting.mode === 'select_one' ? optionId === option.id : optionIds.includes(option.id)}
              onChange={() => {
                if (waiting.mode === 'select_one') setOptionId(option.id)
                else setOptionIds((current) => (current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id]))
              }}
            />
            <span>
              <strong>{option.label}</strong>
              {option.description && <span className="meta"> {option.description}</span>}
            </span>
          </label>
        ))}
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() =>
            onSubmit(waiting.mode === 'select_one' ? { type: 'select_one', optionId } : { type: 'select_many', optionIds })
          }
        >
          Подтвердить
        </button>
      </div>
    )
  }
  if (waiting.mode === 'text') {
    return (
      <div>
        {waiting.value != null && (
          <div>
            <p className="meta">Ответ, который нужно проверить</p>
            <JsonView value={waiting.value} />
          </div>
        )}
        <label className="field">
          <span>{waiting.prompt}</span>
          <textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <div className="row">
          <button className="btn" type="button" disabled={busy} onClick={() => onSubmit({ type: 'text', text })}>
            Отправить ответы
          </button>
          <SkipFollowup details={details} waiting={waiting} busy={busy} onSubmit={onSubmit} />
        </div>
      </div>
    )
  }
  if (waiting.mode === 'confirm') {
    return (
      <div className="row">
        <p>{waiting.prompt}</p>
        <button className="btn" type="button" disabled={busy} onClick={() => onSubmit({ type: 'confirm', accepted: true })}>
          Принять
        </button>
        <button className="danger" type="button" disabled={busy} onClick={() => onSubmit({ type: 'confirm', accepted: false })}>
          Отклонить
        </button>
        <SkipFollowup details={details} waiting={waiting} busy={busy} onSubmit={onSubmit} />
      </div>
    )
  }
  if (waiting.mode === 'edit_json') {
    return (
      <div>
        <label className="field">
          <span>{waiting.prompt}</span>
          <textarea value={jsonText} onChange={(event) => setJsonText(event.target.value)} />
        </label>
        <button className="btn" type="button" disabled={busy} onClick={() => onSubmit({ type: 'edit_json', value: JSON.parse(jsonText) })}>
          Сохранить
        </button>
      </div>
    )
  }
  return (
    <button
      className="ghost"
      type="button"
      disabled={busy}
      onClick={() => {
        void window.pipeline.pickFiles(waiting.mode === 'upload_image' ? 'image' : 'file', false).then((files) => {
          if (files[0]) onSubmit({ type: 'upload', file: files[0] })
        })
      }}
    >
      {waiting.prompt || 'Загрузить'}
    </button>
  )
}
