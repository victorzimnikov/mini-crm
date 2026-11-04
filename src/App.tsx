import { useState } from 'react'
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import { ErrorNote, Loading } from './components'
import { db, isConfigured } from './lib/supabase'
import { BrandIcon, LoginPage, MyTasksPage, ObjectPage, ObjectsPage, SetupPage, TaskPage, Unavailable } from './pages'
import { errorMessage, roleLabels } from './types'

function HomeRedirect() {
  const { profile } = useAuth()
  return <Navigate to={profile?.role === 'executor' ? '/my-tasks' : '/objects'} replace />
}

function ProtectedLayout() {
  const { session, profile, loading, error, retry } = useAuth()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  async function signOut() {
    setSigningOut(true); setSignOutError('')
    try {
      const { error: logoutError } = await db().auth.signOut({ scope: 'local' })
      if (logoutError) throw logoutError
    } catch (e) { setSignOutError(errorMessage(e)) } finally { setSigningOut(false) }
  }
  if (loading || (profile && session && profile.id !== session.user.id)) return <Loading />
  if (!session) return <Navigate to="/login" replace />
  if (!profile) return <main className="setup-page"><section className="panel setup-panel"><h1>Не удалось загрузить профиль</h1><ErrorNote message={error} /><ErrorNote message={signOutError} /><div className="actions"><button onClick={retry}>Повторить</button><button className="secondary" onClick={signOut} disabled={signingOut}>Выйти</button></div></section></main>
  return <div className="app-shell" key={profile.id}>
    <aside className="sidebar"><Link className="brand" to="/"><BrandIcon /><span>ОБЪЕКТЫ<br /><span className="brand-sub">И ЗАДАЧИ</span></span></Link>
      <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav aria-label="Основная навигация"><NavLink to="/objects"><span aria-hidden="true">▤</span> Объекты</NavLink>{profile.role === 'executor' && <NavLink to="/my-tasks"><span aria-hidden="true">☑</span> Мои задачи</NavLink>}</nav>
      <div className="sidebar-bottom"><div className="user-card"><span className="avatar">{profile.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{profile.display_name}</strong><span>{roleLabels[profile.role]}</span></div></div><ErrorNote message={signOutError} /><button className="logout" onClick={signOut} disabled={signingOut}>{signingOut ? 'Выходим…' : 'Выйти из аккаунта ↗'}</button></div>
    </aside>
    <div className="workspace"><header className="topbar"><span>Мини-CRM / Строительство</span><span className="workspace-role">{roleLabels[profile.role]}</span></header><main className="main-content"><Outlet /></main><footer>Объекты и задачи · Рабочее пространство команды</footer></div>
  </div>
}

export default function App() {
  if (!isConfigured) return <SetupPage />
  return <BrowserRouter><AuthProvider><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<ProtectedLayout />}>
      <Route index element={<HomeRedirect />} />
      <Route path="/objects" element={<ObjectsPage />} />
      <Route path="/objects/:id" element={<ObjectPage />} />
      <Route path="/tasks/:id" element={<TaskPage />} />
      <Route path="/my-tasks" element={<MyTasksPage />} />
      <Route path="*" element={<Unavailable />} />
    </Route>
  </Routes></AuthProvider></BrowserRouter>
}
