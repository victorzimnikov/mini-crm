import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('demo seed creates all statuses with consistent history and does not duplicate data', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key default gen_random_uuid(), email text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    `)
    const migrations = new URL('../supabase/migrations/', import.meta.url)
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(file, migrations), 'utf8'))
    }
    const seed = await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8')
    await assert.rejects(db.exec(seed), /Сначала создайте/)
    await db.exec('rollback')
    await db.exec(`insert into auth.users(email) values ('manager@example.com'), ('executor1@example.com'), ('executor2@example.com')`)
    await db.exec(seed)
    assert.equal((await db.query('select * from public.objects')).rows.length, 3)
    assert.equal((await db.query('select * from public.profiles')).rows.length, 3)
    const { rows: tasks } = await db.query('select * from public.tasks')
    assert.equal(tasks.length, 6)
    assert.deepEqual([...new Set(tasks.map(t => t.status))].sort(), ['accepted', 'in_progress', 'new', 'review', 'revision'])
    for (const task of tasks) {
      const { rows: history } = await db.query('select * from public.task_status_history where task_id=$1 order by created_at', [task.id])
      assert.equal(history[0].from_status, null)
      assert.equal(history[0].to_status, 'new')
      assert.equal(history[0].actor_id, task.author_id)
      assert.equal(history.at(-1).to_status, task.status)
      for (let i = 1; i < history.length; i++) assert.equal(history[i].from_status, history[i - 1].to_status)
    }
    const before = (await db.query('select count(*)::int as count from public.task_status_history')).rows[0].count
    await db.exec(seed)
    assert.equal((await db.query('select * from public.tasks')).rows.length, 6)
    assert.equal((await db.query('select count(*)::int as count from public.task_status_history')).rows[0].count, before)
  } finally { await db.close() }
})
