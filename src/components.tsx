import { useEffect, useState } from 'react'
import type { DependencyList, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { errorMessage, statusLabels } from './types'
import type { Status, Task } from './types'

export function useResource<T>(load: () => Promise<T>, dependencies: DependencyList = []) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string }>({ data: null, loading: true, error: '' })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let active = true
    setState({ data: null, loading: true, error: '' })
    void load().then(data => {
      if (active) setState({ data, loading: false, error: '' })
    }).catch((e: unknown) => {
      if (active) setState({ data: null, loading: false, error: errorMessage(e) })
    })
    return () => { active = false }
    // The caller supplies the identity of the resource, just like an effect.
  }, [...dependencies, version])
  return { ...state, reload: () => setVersion(v => v + 1) }
}

export function ErrorNote({ message }: { message: string }) {
  return message ? <div role="alert" className="error-note">{message}</div> : null
}
export function Loading() { return <div className="loading" role="status">Загрузка…</div> }
export function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="panel"><ErrorNote message={message} /><button className="secondary" onClick={retry}>Повторить</button></div>
}
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`status status-${status}`}><span aria-hidden="true" />{statusLabels[status]}</span>
}
export function PageHeading({ eyebrow, title, description, action }: {
  eyebrow: string; title: string; description?: string; action?: ReactNode
}) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden="true">✓</div><h3>{title}</h3>{children && <p>{children}</p>}</div>
}
export function TaskList({ tasks, names, objectNames }: {
  tasks: Task[]; names: Map<string, string>; objectNames?: Map<string, string>
}) {
  if (!tasks.length) return <EmptyState title="Задач пока нет">Здесь появятся назначенные задачи.</EmptyState>
  return <div className="task-list">{tasks.map(task => <Link key={task.id} className="task-row" to={`/tasks/${task.id}`}>
    <div className="task-row-main"><strong>{task.title}</strong><span>{objectNames?.get(task.object_id) || names.get(task.assignee_id) || 'Исполнитель'}</span></div>
    <StatusBadge status={task.status} /><span className="row-arrow" aria-hidden="true">→</span>
  </Link>)}</div>
}
