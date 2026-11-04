export type Role = 'manager' | 'executor'
export type Status = 'new' | 'in_progress' | 'review' | 'accepted' | 'revision'
export type Profile = { id: string; display_name: string; role: Role }
export type ConstructionObject = { id: string; name: string; address: string }
export type Task = {
  id: string
  title: string
  description: string
  object_id: string
  assignee_id: string
  status: Status
  author_id: string
  created_at: string
}
export type HistoryEntry = {
  id: string
  task_id: string
  actor_id: string
  created_at: string
  from_status: Status | null
  to_status: Status
  comment: string | null
}

type Table<Row, Insert, Update> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}
export type Database = {
  public: {
    Tables: {
      profiles: Table<Profile, never, never>
      objects: Table<ConstructionObject, Omit<ConstructionObject, 'id'>, Partial<Omit<ConstructionObject, 'id'>>>
      tasks: Table<Task, Pick<Task, 'title' | 'description' | 'object_id' | 'assignee_id'>,
        Partial<Pick<Task, 'title' | 'description' | 'object_id' | 'assignee_id'>>>
      task_status_history: Table<HistoryEntry, never, never>
    }
    Views: Record<string, never>
    Functions: {
      change_task_status: {
        Args: { p_task_id: string; p_next_status: Status; p_comment?: string | null }
        Returns: undefined
      }
    }
    Enums: { user_role: Role; task_status: Status }
    CompositeTypes: Record<string, never>
  }
}

export const statusLabels: Record<Status, string> = {
  new: 'Новая', in_progress: 'В работе', review: 'На проверке', accepted: 'Принята', revision: 'На доработке',
}
export const roleLabels: Record<Role, string> = { manager: 'Постановщик', executor: 'Исполнитель' }

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function errorMessage(error: unknown): string {
  const value = error as { code?: string; message?: string }
  if (value.code === '23503') return 'Сначала удалите связанные задачи. Объект пока используется.'
  if (value.code === '42501' || value.code === 'PGRST301') return 'Действие недоступно. Проверьте права или войдите заново.'
  if (value.message === 'Invalid login credentials') return 'Неверный email или пароль.'
  if (value.message?.includes('Failed to fetch') || value.message?.includes('fetch failed')) {
    return 'Не удалось связаться с сервером. Проверьте подключение и повторите попытку.'
  }
  return value.message || 'Не удалось выполнить действие. Попробуйте ещё раз.'
}
