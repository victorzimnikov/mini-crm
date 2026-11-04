import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

function validPublicKey(value: string | undefined) {
  if (!value || value.startsWith('sb_secret_')) return false
  if (value.startsWith('sb_publishable_')) return true
  try {
    const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role === 'anon'
  } catch {
    return false
  }
}

export const isConfigured = Boolean(url && /^https?:\/\//.test(url) && validPublicKey(key))
export const supabase = isConfigured ? createClient<Database>(url!, key!) : null

export function db() {
  if (!supabase) throw new Error('Сначала настройте подключение к Supabase.')
  return supabase
}
