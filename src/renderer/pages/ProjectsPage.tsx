import { useEffect, useState } from 'react'
import type { Project } from '@core/types'
import { errorText, whenText } from '../ui'

export function ProjectsPage({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setProjects(await window.pipeline.listProjects())
  }

  useEffect(() => {
    void reload().catch((reason) => setError(errorText(reason)))
  }, [])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Проекты</h1>
          <p className="lede">Каждый проект хранит workflow, версии промптов и отдельные запуски.</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <form
        className="panel"
        style={{ padding: 16, marginTop: 22 }}
        onSubmit={(event) => {
          event.preventDefault()
          void window.pipeline
            .createProject({ name, description })
            .then((project) => {
              setName('')
              setDescription('')
              onOpen(project.id)
            })
            .catch((reason) => setError(errorText(reason)))
        }}
      >
        <div className="row">
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span>Название</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Neurophoto — Product Shoot" />
          </label>
          <label className="field" style={{ flex: 2, marginBottom: 0 }}>
            <span>Описание</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Необязательно" />
          </label>
          <button className="btn" type="submit">
            Создать проект
          </button>
        </div>
      </form>
      <div className="grid">
        {projects.map((project) => (
          <button key={project.id} className="card" type="button" onClick={() => onOpen(project.id)}>
            <strong>{project.name}</strong>
            <span className="meta">{project.description || 'Без описания'}</span>
            <span className="meta">{whenText(project.updatedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
