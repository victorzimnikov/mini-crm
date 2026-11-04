import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from './auth'
import { EmptyState, ErrorNote, Loading, LoadError, PageHeading, StatusBadge, TaskList, useResource } from './components'
import { ObjectForm, TaskForm } from './forms'
import { db } from './lib/supabase'
import { errorMessage, formatDate, statusLabels } from './types'
import type { Status } from './types'

export function LoginPage() {
  const { session } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (session) return <Navigate to="/" replace />

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const { error: authError } = await db().auth.signInWithPassword({ email: email.trim(), password })
      if (authError) throw authError
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="login-page">
    <div className="login-intro"><div className="brand"><BrandIcon /> ОБЪЕКТЫ И ЗАДАЧИ</div><div><div className="eyebrow">РАБОТА КОМАНДЫ</div><h1>Каждая задача —<br />на своём месте.</h1><p>Объекты, исполнители и результат.<br />Всё, что нужно для работы на стройке.</p></div><span className="login-footnote">Мини-CRM для строительной команды</span></div>
    <div className="login-form-wrap"><form className="login-form" onSubmit={submit}><div className="eyebrow">ДОБРО ПОЖАЛОВАТЬ</div><h2>Вход в систему</h2><p className="muted">Используйте аккаунт, выданный администратором.</p><fieldset disabled={busy}>
      <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="username" placeholder="name@company.ru" /></label>
      <label>Пароль<input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" /></label>
      <ErrorNote message={error} /><button className="full-width" type="submit">{busy ? 'Входим…' : 'Войти →'}</button>
    </fieldset><p className="login-help">Нет доступа? Обратитесь к администратору компании.</p></form></div>
  </div>
}

export function BrandIcon() {
  return <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" opacity=".12" /><path d="M8 24V12l8-5 8 5v12M13 24V15h6v9" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
}

export function SetupPage() {
  return <main className="setup-page"><section className="panel setup-panel"><div className="brand"><BrandIcon /> ОБЪЕКТЫ И ЗАДАЧИ</div><h1>Подключите Supabase</h1><p>Для работы приложения нужен проект Supabase с настроенной базой и тестовыми пользователями.</p><ol>
    <li>Создайте проект и выполните SQL-миграцию из папки <code>supabase/migrations</code>.</li>
    <li>Создайте пользователей, назначьте роли и отключите открытую регистрацию.</li>
    <li>Скопируйте <code>.env.example</code> в <code>.env.local</code> и укажите URL проекта и публичный ключ.</li>
    <li>Перезапустите приложение.</li>
  </ol><p className="muted">Подробная инструкция — в README проекта. Для подключения используйте publishable или anon-ключ.</p></section></main>
}

export function ObjectsPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const resource = useResource(async () => {
    const [objects, tasks] = await Promise.all([
      db().from('objects').select('*').order('name'),
      db().from('tasks').select('*'),
    ])
    if (objects.error) throw objects.error
    if (tasks.error) throw tasks.error
    return { objects: objects.data, tasks: tasks.data }
  })
  return <>
    <PageHeading eyebrow="ОБЪЕКТЫ КОМПАНИИ" title="Объекты" description={profile?.role === 'manager' ? 'Стройки и задачи вашей команды.' : 'Объекты, на которых вам назначены задачи.'}
      action={profile?.role === 'manager' && !creating && <button onClick={() => setCreating(true)}>+ Добавить объект</button>} />
    {creating && <ObjectForm onCancel={() => setCreating(false)} onSaved={id => navigate(`/objects/${id}`)} />}
    {resource.loading ? <Loading /> : resource.error || !resource.data ? <LoadError message={resource.error} retry={resource.reload} /> : <>
      <div className="section-label">ДОСТУПНЫЕ ОБЪЕКТЫ <span>{resource.data.objects.length}</span></div>
      {!resource.data.objects.length ? <section className="panel"><EmptyState title="Объектов пока нет">{profile?.role === 'manager' ? 'Добавьте первый объект, чтобы поставить задачи команде.' : 'Объекты появятся, когда вам назначат задачи.'}</EmptyState></section> :
        <div className="object-grid">{resource.data.objects.map(object => {
          const tasks = resource.data!.tasks.filter(t => t.object_id === object.id)
          const accepted = tasks.filter(t => t.status === 'accepted').length
          return <Link to={`/objects/${object.id}`} className="object-card" key={object.id}>
            <div className="object-card-top"><span className="building-mark" aria-hidden="true">▤</span><span className="row-arrow" aria-hidden="true">↗</span></div>
            <h2>{object.name}</h2><p className="object-address">{object.address}</p>
            <div className="object-progress"><div style={{ width: `${tasks.length ? accepted / tasks.length * 100 : 0}%` }} /></div>
            <div className="object-card-bottom"><span>Задач: <strong>{tasks.length}</strong></span><span>Принято: <strong>{accepted}</strong></span></div>
          </Link>
        })}</div>}
    </>}
  </>
}

export function ObjectPage() {
  const { id = '' } = useParams()
  const { profile } = useAuth()
  const manager = profile?.role === 'manager'
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [creatingTask, setCreatingTask] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const resource = useResource(async () => {
    const [object, tasks, people] = await Promise.all([
      db().from('objects').select('*').eq('id', id).maybeSingle(),
      db().from('tasks').select('*').eq('object_id', id).order('created_at', { ascending: false }),
      db().from('profiles').select('*'),
    ])
    if (object.error) throw object.error
    if (tasks.error) throw tasks.error
    if (people.error) throw people.error
    return { object: object.data, tasks: tasks.data, people: people.data }
  }, [id])

  async function remove() {
    if (!window.confirm('Удалить объект? Это действие нельзя отменить. Объект с задачами удалить не получится.')) return
    setDeleting(true); setError('')
    try {
      const { data, error: deleteError } = await db().from('objects').delete().eq('id', id).select('id').single()
      if (deleteError) throw deleteError
      if (data) navigate('/objects', { replace: true })
    } catch (e) { setError(errorMessage(e)) } finally { setDeleting(false) }
  }
  if (resource.loading) return <Loading />
  if (resource.error || !resource.data) return <LoadError message={resource.error} retry={resource.reload} />
  const { object, tasks, people } = resource.data
  if (!object) return <Unavailable />
  return <>
    <Link className="back-link" to="/objects">← Все объекты</Link>
    <PageHeading eyebrow="КАРТОЧКА ОБЪЕКТА" title={object.name} description={object.address} action={manager && <div className="actions"><button className="secondary" onClick={() => setEditing(true)}>Редактировать</button><button className="danger-quiet" disabled={deleting} onClick={remove}>{deleting ? 'Удаление…' : 'Удалить'}</button></div>} />
    <ErrorNote message={error} />
    {editing && <ObjectForm object={object} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); resource.reload() }} />}
    <div className="section-heading"><h2>Задачи объекта <span className="count">{tasks.length}</span></h2>{manager && !creatingTask && <button onClick={() => setCreatingTask(true)}>+ Новая задача</button>}</div>
    {creatingTask && <TaskForm objectId={id} onCancel={() => setCreatingTask(false)} onSaved={taskId => navigate(`/tasks/${taskId}`)} />}
    <section className="panel list-panel"><TaskList tasks={tasks} names={new Map(people.map(p => [p.id, p.display_name]))} /></section>
  </>
}

export function MyTasksPage() {
  const { profile } = useAuth()
  const resource = useResource(async () => {
    const [tasks, objects] = await Promise.all([
      db().from('tasks').select('*').eq('assignee_id', profile!.id).order('created_at', { ascending: false }),
      db().from('objects').select('*'),
    ])
    if (tasks.error) throw tasks.error
    if (objects.error) throw objects.error
    return { tasks: tasks.data, objects: objects.data }
  }, [profile?.id])
  if (profile?.role !== 'executor') return <Navigate to="/objects" replace />
  return <>
    <PageHeading eyebrow="ЛИЧНОЕ ПРОСТРАНСТВО" title="Мои задачи" description="Назначенные вам задачи на всех объектах." />
    {resource.loading ? <Loading /> : resource.error || !resource.data ? <LoadError message={resource.error} retry={resource.reload} /> : <>
      <div className="section-label">ВСЕ ВАШИ ЗАДАЧИ <span>{resource.data.tasks.length}</span></div>
      <section className="panel list-panel"><TaskList tasks={resource.data.tasks} names={new Map()} objectNames={new Map(resource.data.objects.map(o => [o.id, o.name]))} /></section>
    </>}
  </>
}

export function TaskPage() {
  const { id = '' } = useParams()
  const { profile } = useAuth()
  const manager = profile?.role === 'manager'
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const resource = useResource(async () => {
    const { data: task, error: taskError } = await db().from('tasks').select('*').eq('id', id).maybeSingle()
    if (taskError) throw taskError
    if (!task) return null
    const [object, history, people] = await Promise.all([
      db().from('objects').select('*').eq('id', task.object_id).single(),
      db().from('task_status_history').select('*').eq('task_id', id).order('created_at', { ascending: false }),
      db().from('profiles').select('*'),
    ])
    if (object.error) throw object.error
    if (history.error) throw history.error
    if (people.error) throw people.error
    return { task, object: object.data, history: history.data, people: people.data }
  }, [id])

  async function changeStatus(status: Status) {
    if (status === 'revision' && !comment.trim()) { setError('Укажите причину возврата на доработку.'); return }
    setBusy(true); setError('')
    try {
      const { error: changeError } = await db().rpc('change_task_status', { p_task_id: id, p_next_status: status, p_comment: comment.trim() || null })
      if (changeError) throw changeError
      setComment(''); resource.reload()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  async function remove() {
    if (!resource.data || !window.confirm('Удалить задачу вместе с историей? Это действие нельзя отменить.')) return
    setBusy(true); setError('')
    try {
      const { error: deleteError } = await db().from('tasks').delete().eq('id', id).select('id').single()
      if (deleteError) throw deleteError
      navigate(`/objects/${resource.data.task.object_id}`, { replace: true })
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  if (resource.loading) return <Loading />
  if (resource.error) return <LoadError message={resource.error} retry={resource.reload} />
  if (!resource.data) return <Unavailable />
  const { task, object, people, history } = resource.data
  const names = new Map(people.map(p => [p.id, p.display_name]))
  const canWork = !manager && task.assignee_id === profile?.id && (task.status === 'new' || task.status === 'revision')
  const canSubmit = !manager && task.assignee_id === profile?.id && task.status === 'in_progress'
  const canReview = manager && task.status === 'review'
  return <>
    <Link className="back-link" to={`/objects/${object.id}`}>← {object.name}</Link>
    <PageHeading eyebrow="КАРТОЧКА ЗАДАЧИ" title={task.title} action={manager && <div className="actions"><button className="secondary" disabled={busy} onClick={() => setEditing(true)}>Редактировать</button><button className="danger-quiet" disabled={busy} onClick={remove}>Удалить</button></div>} />
    {editing && <TaskForm task={task} objectId={task.object_id} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); resource.reload() }} />}
    <div className="detail-grid"><div>
      <section className="panel task-detail"><div className="detail-top"><h2>О задаче</h2><StatusBadge status={task.status} /></div>
        <p className="task-description">{task.description || 'Описание не добавлено.'}</p>
        <dl className="metadata"><div><dt>Объект</dt><dd><Link to={`/objects/${object.id}`}>{object.name}</Link></dd></div><div><dt>Исполнитель</dt><dd>{names.get(task.assignee_id) || '—'}</dd></div><div><dt>Постановщик</dt><dd>{names.get(task.author_id) || '—'}</dd></div><div><dt>Создана</dt><dd>{formatDate(task.created_at)}</dd></div></dl>
      </section>
      <ErrorNote message={error} />
      {(canWork || canSubmit || canReview) && <section className="panel task-actions"><h2>{canReview ? 'Проверка результата' : 'Следующий шаг'}</h2>
        <fieldset disabled={busy}>
          <label>Комментарий {canReview ? '(обязателен при доработке)' : '(необязательно)'}<textarea rows={3} maxLength={2000} value={comment} onChange={e => setComment(e.target.value)} placeholder={canReview ? 'Что нужно исправить или уточнить?' : 'Добавьте детали, если нужно'} /></label>
          <div className="actions">
            {canWork && <button onClick={() => changeStatus('in_progress')}>{busy ? 'Сохранение…' : 'Взять в работу'}</button>}
            {canSubmit && <button onClick={() => changeStatus('review')}>{busy ? 'Сохранение…' : 'Отправить на проверку'}</button>}
            {canReview && <><button onClick={() => changeStatus('accepted')}>Принять задачу</button><button className="secondary" onClick={() => changeStatus('revision')}>На доработку</button></>}
          </div>
        </fieldset>
      </section>}
      {task.status === 'accepted' && <div className="success-note">✓ Задача принята</div>}
      {!manager && task.status === 'review' && <p className="muted">Задача отправлена постановщику. Ожидайте результат проверки.</p>}
    </div><section className="panel history-panel"><h2>История задачи <span className="count">{history.length}</span></h2><ol className="timeline">{history.map(entry => <li key={entry.id}>
      <div className="history-title">{entry.from_status ? `${statusLabels[entry.from_status]} → ${statusLabels[entry.to_status]}` : 'Задача создана'}</div>
      <div className="history-meta">{names.get(entry.actor_id) || 'Пользователь'} · <time dateTime={entry.created_at}>{formatDate(entry.created_at)}</time></div>
      {entry.comment && <p className="history-comment">{entry.comment}</p>}
    </li>)}</ol></section></div>
  </>
}

export function Unavailable() {
  return <section className="panel"><EmptyState title="Страница не найдена">Она удалена или у вас нет доступа.</EmptyState><Link className="back-link" to="/objects">← К объектам</Link></section>
}
