export type Route =
  | { name: 'projects' }
  | { name: 'project'; projectId: string }
  | { name: 'workflow'; projectId: string; workflowId: string; version?: number }
  | { name: 'run'; projectId: string; runId: string }

export function routeLabel(route: Route): string {
  switch (route.name) {
    case 'projects':
      return 'Проекты'
    case 'project':
      return 'Проект'
    case 'workflow':
      return 'Workflow'
    case 'run':
      return 'Запуск'
  }
}

export function routeKey(route: Route): string {
  switch (route.name) {
    case 'projects':
      return 'projects'
    case 'project':
      return `project:${route.projectId}`
    case 'workflow':
      return `workflow:${route.workflowId}`
    case 'run':
      return `run:${route.runId}`
  }
}
