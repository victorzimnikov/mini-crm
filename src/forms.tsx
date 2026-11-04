import { useState } from 'react'
import type { FormEvent } from 'react'
import { db } from './lib/supabase'
import { ErrorNote, Loading, LoadError, useResource } from './components'
import { errorMessage } from './types'
import type { ConstructionObject, Task } from './types'

export function ObjectForm({ object, onSaved, onCancel }: {
  object?: ConstructionObject; onSaved: (id: string) => void; onCancel: () => void
}) {
  const [name, setName] = useState(object?.name || '')
  const [address, setAddress] = useState(object?.address || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || !address.trim()) { setError('Заполните название и адрес.'); return }
    setBusy(true); setError('')
    try {
      const values = { name: name.trim(), address: address.trim() }
      const query = object ? db().from('objects').update(values).eq('id', object.id) : db().from('objects').insert(values)
      const { data, error: saveError } = await query.select('id').single()
      if (saveError) throw saveError
      onSaved(data.id)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <section className="panel editor" aria-label={object ? 'Редактирование объекта' : 'Новый объект'}>
    <h2>{object ? 'Редактирование объекта' : 'Новый объект'}</h2>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label>Название<input value={name} onChange={e => setName(e.target.value)} required maxLength={200} autoFocus placeholder="Например, ЖК «Северный»" /></label>
      <label>Адрес<input value={address} onChange={e => setAddress(e.target.value)} required maxLength={500} placeholder="Город, улица, дом" /></label>
      <ErrorNote message={error} />
      <div className="form-actions"><button type="submit">{busy ? 'Сохранение…' : 'Сохранить объект'}</button><button type="button" className="secondary" onClick={onCancel}>Отмена</button></div>
    </fieldset></form>
  </section>
}

export function TaskForm({ task, objectId, onSaved, onCancel }: {
  task?: Task; objectId: string; onSaved: (id: string) => void; onCancel: () => void
}) {
  const [title, setTitle] = useState(task?.title || '')
  const [description, setDescription] = useState(task?.description || '')
  const [selectedObject, setSelectedObject] = useState(task?.object_id || objectId)
  const [assignee, setAssignee] = useState(task?.assignee_id || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = useResource(async () => {
    const [objects, people] = await Promise.all([
      db().from('objects').select('*').order('name'),
      db().from('profiles').select('*').eq('role', 'executor').order('display_name'),
    ])
    if (objects.error) throw objects.error
    if (people.error) throw people.error
    return { objects: objects.data, people: people.data }
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim()) { setError('Укажите название задачи.'); return }
    setBusy(true); setError('')
    try {
      const values = { title: title.trim(), description: description.trim(), object_id: selectedObject, assignee_id: assignee }
      const query = task ? db().from('tasks').update(values).eq('id', task.id) : db().from('tasks').insert(values)
      const { data, error: saveError } = await query.select('id').single()
      if (saveError) throw saveError
      onSaved(data.id)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  if (options.loading) return <Loading />
  if (options.error || !options.data) return <LoadError message={options.error} retry={options.reload} />
  return <section className="panel editor" aria-label={task ? 'Редактирование задачи' : 'Новая задача'}>
    <h2>{task ? 'Редактирование задачи' : 'Новая задача'}</h2>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label>Название<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={200} autoFocus placeholder="Что нужно сделать?" /></label>
      <label>Описание<textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={10000} rows={4} placeholder="Детали и ожидаемый результат" /></label>
      <div className="form-grid">
        <label>Объект<select value={selectedObject} onChange={e => setSelectedObject(e.target.value)} required>
          <option value="" disabled>Выберите объект</option>{options.data.objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select></label>
        <label>Исполнитель<select value={assignee} onChange={e => setAssignee(e.target.value)} required>
          <option value="" disabled>Выберите исполнителя</option>{options.data.people.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </select></label>
      </div>
      {!options.data.people.length && <p className="muted">Пока нет исполнителей. Добавьте аккаунты и профили в Supabase.</p>}
      <ErrorNote message={error} />
      <div className="form-actions"><button type="submit" disabled={!options.data.people.length}>{busy ? 'Сохранение…' : 'Сохранить задачу'}</button><button type="button" className="secondary" onClick={onCancel}>Отмена</button></div>
    </fieldset></form>
  </section>
}
