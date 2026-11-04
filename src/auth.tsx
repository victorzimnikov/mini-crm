import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { db } from './lib/supabase'
import { errorMessage } from './types'
import type { Profile } from './types'

type AuthState = { session: Session | null; profile: Profile | null; loading: boolean; error: string; retry: () => void }
const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    let authEventReceived = false
    const { data: { subscription } } = db().auth.onAuthStateChange((_event, next) => {
      if (active) {
        authEventReceived = true
        setSession(next)
        setReady(true)
      }
    })
    void db().auth.getSession().then(({ data, error: authError }) => {
      if (!active || authEventReceived) return
      setSession(data.session)
      if (authError) setError(errorMessage(authError))
      setReady(true)
    }).catch((e: unknown) => {
      if (active) { setError(errorMessage(e)); setReady(true) }
    })
    return () => { active = false; subscription.unsubscribe() }
  }, [])

  const userId = session?.user.id
  useEffect(() => {
    let active = true
    setProfile(null)
    setError('')
    if (!userId) { setProfileLoading(false); return }
    setProfileLoading(true)
    void (async () => {
      try {
        const { data, error: profileError } = await db().from('profiles').select('*').eq('id', userId).maybeSingle()
        if (!active) return
        if (profileError) setError(errorMessage(profileError))
        else if (!data) setError('Для аккаунта не настроена роль. Обратитесь к администратору.')
        else setProfile(data)
      } catch (e) {
        if (active) setError(errorMessage(e))
      } finally {
        if (active) setProfileLoading(false)
      }
    })()
    return () => { active = false }
  }, [userId, attempt])

  return <AuthContext.Provider value={{ session, profile, loading: !ready || profileLoading, error, retry: () => setAttempt(a => a + 1) }}>
    {children}
  </AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('AuthProvider is missing')
  return context
}
