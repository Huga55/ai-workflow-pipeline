import { useEffect, useState } from 'react'
import type { Project, RunSummary, Workflow } from '@core/types'
import { RUN_STATUS_LABEL } from '@core/labels'
import { errorText, Modal, StatusPill, whenText } from '../ui'
import { VariableEditor } from '../variables'

export function ProjectPage({
  projectId,
  onBack,
  onOpenWorkflow,
  onOpenRun
}: {
  projectId: string
  onBack: () => void
  onOpenWorkflow: (workflowId: string) => void
  onOpenRun: (runId: string) => void
}) {
  const [project, setProject] = useState<Project | null>(null)
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [menuRunId, setMenuRunId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RunSummary | null>(null)

  async function reload() {
    const [projects, nextWorkflows, nextRuns] = await Promise.all([
      window.pipeline.listProjects(),
      window.pipeline.listWorkflows(projectId),
      window.pipeline.listRuns(projectId)
    ])
    const current = projects.find((item) => item.id === projectId) ?? null
    setProject(current)
    setWorkflows(nextWorkflows)
    setRuns(nextRuns)
  }

  useEffect(() => {
    void reload().catch((reason) => setError(errorText(reason)))
  }, [projectId])

  useEffect(() => {
    if (!menuRunId) return
    const close = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.kebab') || target.closest('.menu')) return
      setMenuRunId(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuRunId])

  if (!project && !error) return <div className="page">Загрузка…</div>
  if (!project) return <div className="page"><div className="error">{error}</div></div>

  return (
    <div className="page">
      <button className="ghost" type="button" onClick={onBack}>
        Все проекты
      </button>
      <div className="page-head" style={{ marginTop: 16 }}>
        <div>
          <h1>{project.name}</h1>
          <p className="lede">{project.description || 'Описание пока пустое.'}</p>
        </div>
        <button
          className="danger"
          type="button"
          onClick={() => {
            if (!confirm(`Удалить проект «${project.name}»?`)) return
            void window.pipeline.deleteProject(project.id).then(onBack).catch((reason) => setError(errorText(reason)))
          }}
        >
          Удалить
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <h2 style={{ marginTop: 28 }}>Переменные проекта</h2>
      <p className="meta">Общие для всех workflow этого проекта. В промпте: {'{{project.имя}}'}.</p>
      <VariableEditor scope="project" projectId={projectId} />
      <div className="page-head" style={{ marginTop: 28 }}>
        <h2>Workflow</h2>
        <div className="row">
          <input className="inline-input" style={{ width: 220 }} value={name} placeholder="Название" onChange={(event) => setName(event.target.value)} />
          <button
            className="btn"
            type="button"
            onClick={() => {
              void window.pipeline
                .createWorkflow(projectId, { name: name || 'Новый workflow' })
                .then((details) => onOpenWorkflow(details.workflow.id))
                .catch((reason) => setError(errorText(reason)))
            }}
          >
            Пустой
          </button>
          <button
            className="ghost"
            type="button"
            onClick={() => {
              void window.pipeline
                .createWorkflowFromTemplate(projectId, 'neurophoto')
                .then((details) => onOpenWorkflow(details.workflow.id))
                .catch((reason) => setError(errorText(reason)))
            }}
          >
            Пример Neurophoto
          </button>
        </div>
      </div>
      <div className="grid">
        {workflows.map((workflow) => (
          <button key={workflow.id} className="card" type="button" onClick={() => onOpenWorkflow(workflow.id)}>
            <strong>{workflow.name}</strong>
            <span className="meta">{workflow.description || 'Без описания'}</span>
            <span className="meta">Версия {workflow.latestVersion}</span>
          </button>
        ))}
      </div>
      <h2 style={{ marginTop: 32 }}>Запуски</h2>
      <div className="grid">
        {runs.map((run) => (
          <article key={run.id} className="card run-card">
            <button className="run-main" type="button" onClick={() => onOpenRun(run.id)}>
              <strong>{run.title}</strong>
              <span className="meta">
                {run.workflowName} · v{run.versionNumber}
              </span>
              <span className="row">
                <StatusPill status={run.status} />
                <span className="meta">{RUN_STATUS_LABEL[run.status]}</span>
              </span>
              <span className="meta">{whenText(run.createdAt)}</span>
            </button>
            <button
              className="kebab"
              type="button"
              aria-label="Действия запуска"
              aria-expanded={menuRunId === run.id}
              onClick={() => setMenuRunId((current) => (current === run.id ? null : run.id))}
            >
              ···
            </button>
            {menuRunId === run.id && (
              <div className="menu" role="menu">
                <button
                  className="menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuRunId(null)
                    setPendingDelete(run)
                  }}
                >
                  Удалить
                </button>
              </div>
            )}
          </article>
        ))}
        {!runs.length && <p className="meta">Запусков пока нет.</p>}
      </div>
      {pendingDelete && (
        <Modal title="Удалить запуск" onClose={() => setPendingDelete(null)}>
          <p className="lede">Удалить запуск «{pendingDelete.title}»? Вместе с ним пропадут шаги, ветки и ответы.</p>
          <div className="row">
            <button
              className="danger"
              type="button"
              onClick={() => {
                const runId = pendingDelete.id
                setPendingDelete(null)
                void window.pipeline
                  .deleteRun(runId)
                  .then(() => reload())
                  .catch((reason) => setError(errorText(reason)))
              }}
            >
              Удалить
            </button>
            <button className="btn" type="button" onClick={() => setPendingDelete(null)}>
              Оставить
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
