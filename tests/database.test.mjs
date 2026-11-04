import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

// Real PostgreSQL in WASM. Only Supabase Auth's users table and auth.uid()
// are stubbed; the production migration, grants, RLS and RPC run unchanged.
const db = new PGlite()
const ids = {
  manager: '00000000-0000-4000-8000-000000000001',
  manager2: '00000000-0000-4000-8000-000000000002',
  alice: '00000000-0000-4000-8000-000000000003',
  bob: '00000000-0000-4000-8000-000000000004',
  noProfile: '00000000-0000-4000-8000-000000000005',
}
let objectId, privateObjectId, aliceTask, bobTask, tasksBeforeUpgrade, historyBeforeUpgrade

async function as(user, fn) {
  await db.exec(`set role authenticated`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ids[user] || ''])
  try { return await fn() } finally { await db.exec('reset role') }
}
async function move(user, id, status, comment = null) {
  return as(user, () => db.query('select public.change_task_status($1, $2, $3)', [id, status, comment]))
}
async function insertTask(user, assignee, object = objectId) {
  return as(user, async () => {
    const { rows } = await db.query(`insert into public.tasks(title, description, object_id, assignee_id)
      values ('Проверить монтаж', 'Проверить качество работ', $1, $2) returning id`, [object, ids[assignee]])
    return rows[0].id
  })
}

before(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- Mirror Supabase default grants to test that the migration revokes them.
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
  `)
  await db.exec(await readFile(new URL('../supabase/migrations/202611040001_initial.sql', import.meta.url), 'utf8'))
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users values ($1)', [id])
    if (name !== 'noProfile') await db.query('insert into public.profiles values ($1, $2, $3)', [id, name, name.startsWith('manager') ? 'manager' : 'executor'])
  }
  objectId = (await as('manager', () => db.query(`insert into public.objects(name,address) values ('Общий объект', 'Адрес 1') returning id`))).rows[0].id
  privateObjectId = (await as('manager', () => db.query(`insert into public.objects(name,address) values ('Другой объект', 'Адрес 2') returning id`))).rows[0].id
  aliceTask = await insertTask('manager', 'alice')
  bobTask = await insertTask('manager2', 'bob', privateObjectId)
  tasksBeforeUpgrade = (await db.query('select * from public.tasks order by id')).rows
  historyBeforeUpgrade = (await db.query('select * from public.task_status_history order by id')).rows
  // Upgrade a populated database, as on the existing Supabase deployment.
  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql') && f !== '202611040001_initial.sql').sort()) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'))
  }
})
after(async () => { await db.close() })

test('history-preservation migration upgrades existing tasks without changing their history', async () => {
  const tasks = (await db.query('select * from public.tasks order by id')).rows
  assert.ok(tasks.every(task => task.archived_at === null))
  assert.deepEqual(tasks.map(({ archived_at, ...task }) => task), tasksBeforeUpgrade)
  assert.deepEqual((await db.query('select * from public.task_status_history order by id')).rows, historyBeforeUpgrade)
})

test('RLS: executor sees only own tasks, objects and necessary profiles', async () => {
  await as('alice', async () => {
    assert.deepEqual((await db.query('select id from public.tasks')).rows.map(r => r.id), [aliceTask])
    assert.deepEqual((await db.query('select id from public.objects')).rows.map(r => r.id), [objectId])
    assert.equal((await db.query('select * from public.tasks where id=$1', [bobTask])).rows.length, 0)
    assert.equal((await db.query('select * from public.task_status_history where task_id=$1', [bobTask])).rows.length, 0)
    assert.deepEqual((await db.query('select display_name from public.profiles order by display_name')).rows.map(r => r.display_name), ['alice', 'manager'])
  })
  await as('manager2', async () => {
    assert.equal((await db.query('select * from public.tasks')).rows.length, 2)
    assert.equal((await db.query('select * from public.objects')).rows.length, 2)
    assert.equal((await db.query('select * from public.profiles')).rows.length, 4)
  })
})

test('RLS: sharing an object never exposes another executor’s task', async () => {
  const task = await insertTask('manager', 'bob')
  await as('alice', async () => {
    assert.equal((await db.query('select * from public.tasks where object_id=$1', [objectId])).rows.length, 1)
    assert.equal((await db.query('select * from public.tasks where id=$1', [task])).rows.length, 0)
  })
  await as('manager', () => db.query('select public.archive_task($1)', [task]))
})

test('database rejects executor CRUD, self-promotion and forged system fields', async () => {
  await assert.rejects(insertTask('alice', 'alice'), /row-level security/)
  await as('alice', async () => {
    assert.equal((await db.query(`update public.tasks set title='Взлом' where id=$1 returning id`, [aliceTask])).rows.length, 0)
    assert.equal((await db.query(`update public.tasks set assignee_id=$1 where id=$2 returning id`, [ids.alice, bobTask])).rows.length, 0)
    await assert.rejects(db.query('delete from public.tasks where id=$1', [aliceTask]), /permission denied/)
    await assert.rejects(db.query('delete from public.objects where id=$1', [objectId]), /permission denied/)
    await assert.rejects(db.query(`insert into public.objects(name,address) values ('Нет', 'Нет')`), /row-level security/)
    await assert.rejects(db.query(`update public.profiles set role='manager' where id=$1`, [ids.alice]), /permission denied/)
    await assert.rejects(db.query(`insert into public.profiles values ($1, 'Взлом', 'manager')`, [ids.noProfile]), /permission denied/)
  })
  await as('manager', async () => {
    for (const update of [`status='accepted'`, `author_id='${ids.alice}'`, `created_at=now()`, `id=gen_random_uuid()`]) {
      await assert.rejects(db.query(`update public.tasks set ${update} where id=$1`, [aliceTask]), /permission denied/)
    }
    await assert.rejects(db.query(`insert into public.tasks(title,object_id,assignee_id,status) values ('Нет',$1,$2,'accepted')`, [objectId, ids.alice]), /permission denied/)
    await assert.rejects(db.query(`insert into public.tasks(title,object_id,assignee_id,author_id) values ('Нет',$1,$2,$3)`, [objectId, ids.alice, ids.manager2]), /permission denied/)
    await assert.rejects(db.query('update public.tasks set assignee_id=$1 where id=$2', [ids.manager, aliceTask]), /только исполнителю/)
    await assert.rejects(db.query(`insert into public.tasks(title,object_id,assignee_id) values ('   ',$1,$2)`, [objectId, ids.alice]), /check constraint/)
  })
})

test('full workflow, required comment, correct audit and rejected transitions', async () => {
  await assert.rejects(move('bob', aliceTask, 'in_progress'), /не найдена или недоступна/)
  await assert.rejects(move('noProfile', aliceTask, 'in_progress'), /не найдена или недоступна/)
  await assert.rejects(move('manager', aliceTask, 'in_progress'), /переход статуса запрещён/)
  await assert.rejects(move('alice', aliceTask, 'review'), /переход статуса запрещён/)
  await move('alice', aliceTask, 'in_progress')
  await assert.rejects(move('alice', aliceTask, 'in_progress'), /переход статуса запрещён/)
  await move('alice', aliceTask, 'review', 'Работа готова')
  await assert.rejects(move('alice', aliceTask, 'accepted'), /переход статуса запрещён/)
  await assert.rejects(move('manager', aliceTask, 'revision'), /Укажите причину/)
  await assert.rejects(move('manager', aliceTask, 'revision', ' \t\n\r '), /Укажите причину/)
  await assert.rejects(move('manager', aliceTask, 'revision', 'x'.repeat(2001)), /2000 символов/)
  await move('manager2', aliceTask, 'revision', '  Исправьте крепления  ')
  await move('alice', aliceTask, 'in_progress')
  await move('alice', aliceTask, 'review')
  await move('manager', aliceTask, 'accepted')
  await assert.rejects(move('alice', aliceTask, 'in_progress'), /переход статуса запрещён/)
  await assert.rejects(move('manager', aliceTask, 'review'), /переход статуса запрещён/)
  await as('alice', async () => {
    const { rows } = await db.query('select * from public.task_status_history where task_id=$1 order by created_at', [aliceTask])
    assert.equal(rows.length, 7)
    assert.equal(rows[0].from_status, null)
    assert.equal(rows[0].actor_id, ids.manager)
    assert.deepEqual(rows.map(r => r.to_status), ['new', 'in_progress', 'review', 'revision', 'in_progress', 'review', 'accepted'])
    assert.equal(rows[3].comment, 'Исправьте крепления')
    assert.equal(rows[3].actor_id, ids.manager2)
    assert.ok(rows.every(r => r.created_at))
    // A second manager who reviewed this task becomes visible for history attribution.
    assert.equal((await db.query('select * from public.profiles where id=$1', [ids.manager2])).rows.length, 1)
  })
})

test('all other status combinations are rejected for both roles', async () => {
  const task = await insertTask('manager', 'alice')
  const statuses = ['new', 'in_progress', 'review', 'accepted', 'revision']
  for (const from of statuses) {
    // Trusted test fixture setup, never exposed to API clients.
    await db.query('update public.tasks set status=$1 where id=$2', [from, task])
    for (const user of ['manager', 'alice']) {
      for (const to of statuses) {
        const allowed = user === 'manager'
          ? from === 'review' && ['accepted', 'revision'].includes(to)
          : ['new', 'revision'].includes(from) && to === 'in_progress' || from === 'in_progress' && to === 'review'
        if (!allowed) await assert.rejects(move(user, task, to, 'Комментарий'), /переход статуса запрещён/)
      }
    }
  }
  await as('manager', () => db.query('select public.archive_task($1)', [task]))
})

test('history is read-only through client grants, including for managers', async () => {
  for (const user of ['manager', 'alice']) await as(user, async () => {
    await assert.rejects(db.query(`insert into public.task_status_history(task_id,actor_id,to_status) values ($1,$2,'accepted')`, [aliceTask, ids.manager]), /permission denied/)
    await assert.rejects(db.query(`update public.task_status_history set comment='Подмена' where task_id=$1`, [aliceTask]), /permission denied/)
    await assert.rejects(db.query('delete from public.task_status_history where task_id=$1', [aliceTask]), /permission denied/)
  })
})

test('manager edits normal fields; reassignment revokes previous executor access', async () => {
  await as('manager2', async () => {
    const result = await db.query(`update public.tasks set assignee_id=$1, title='Обновлено' where id=$2 returning *`, [ids.bob, aliceTask])
    assert.equal(result.rows[0].title, 'Обновлено')
    assert.equal(result.rows[0].status, 'accepted')
    await db.query(`update public.objects set address='Новый адрес' where id=$1`, [objectId])
  })
  await as('alice', async () => {
    assert.equal((await db.query('select * from public.tasks where id=$1', [aliceTask])).rows.length, 0)
    assert.equal((await db.query('select * from public.objects where id=$1', [objectId])).rows.length, 0)
    assert.equal((await db.query('select * from public.task_status_history where task_id=$1', [aliceTask])).rows.length, 0)
  })
  await assert.rejects(move('alice', aliceTask, 'in_progress'), /не найдена или недоступна/)
})

test('archiving tasks and their object keeps their complete history readable to managers', async () => {
  const before = (await db.query('select * from public.task_status_history where task_id=$1 order by created_at', [aliceTask])).rows
  await as('manager', async () => {
    await assert.rejects(db.query('delete from public.tasks where id=$1', [aliceTask]), /permission denied/)
    await assert.rejects(db.query('delete from public.objects where id=$1', [objectId]), /permission denied/)
    await assert.rejects(db.query('select public.archive_object($1)', [objectId]), /Сначала архивируйте/)
    await db.query('select public.archive_task($1)', [aliceTask])
    await db.query('select public.archive_object($1)', [objectId])
    assert.equal((await db.query('select id from public.tasks where object_id=$1 and archived_at is null', [objectId])).rows.length, 0)
    assert.equal((await db.query('select id from public.objects where id=$1 and archived_at is null', [objectId])).rows.length, 0)
  })
  await as('manager2', async () => {
    assert.ok((await db.query('select archived_at from public.tasks where id=$1', [aliceTask])).rows[0].archived_at)
    assert.ok((await db.query('select archived_at from public.objects where id=$1', [objectId])).rows[0].archived_at)
    assert.deepEqual((await db.query('select * from public.task_status_history where task_id=$1 order by created_at', [aliceTask])).rows, before)
    for (const verb of ["update public.task_status_history set comment='Подмена'", 'delete from public.task_status_history']) {
      await assert.rejects(db.query(`${verb} where task_id=$1`, [aliceTask]), /permission denied/)
    }
    await assert.rejects(db.query('select public.archive_task($1)', [aliceTask]), /уже в архиве/)
    await assert.rejects(db.query('select public.archive_object($1)', [objectId]), /уже в архиве/)
  })
  await as('bob', async () => {
    for (const [table, column] of [['tasks', 'id'], ['task_status_history', 'task_id']]) {
      assert.equal((await db.query(`select * from public.${table} where ${column}=$1`, [aliceTask])).rows.length, 0)
    }
    assert.equal((await db.query('select * from public.objects where id=$1', [objectId])).rows.length, 0)
  })
  // Even a trusted physical task deletion cannot cascade away its audit trail.
  await assert.rejects(db.query('delete from public.tasks where id=$1', [aliceTask]), /foreign key constraint/)
})

test('archive RPCs enforce roles and archived data cannot be edited, reopened or moved', async () => {
  const object = (await as('manager', () => db.query("insert into public.objects(name,address) values ('Архив', 'Адрес') returning id"))).rows[0].id
  const task = await insertTask('manager', 'alice', object)
  await move('alice', task, 'in_progress')
  await move('alice', task, 'review')
  for (const user of ['alice', 'bob', 'noProfile', '']) {
    await as(user, async () => {
      await assert.rejects(db.query('select public.archive_task($1)', [task]), /только постановщик/)
      await assert.rejects(db.query('select public.archive_object($1)', [object]), /только постановщик/)
    })
  }
  await as('manager', () => db.query('select public.archive_task($1)', [task]))
  const before = (await db.query('select * from public.task_status_history where task_id=$1 order by created_at', [task])).rows
  // The parent disappears for the executor as soon as its last active task is archived.
  await as('alice', async () => {
    assert.equal((await db.query('select * from public.objects where id=$1', [object])).rows.length, 0)
    assert.equal((await db.query('select * from public.tasks where id=$1', [task])).rows.length, 0)
    assert.equal((await db.query('select * from public.task_status_history where task_id=$1', [task])).rows.length, 0)
  })
  await assert.rejects(move('manager', task, 'accepted'), /не найдена или недоступна/)
  await assert.rejects(move('alice', task, 'in_progress'), /не найдена или недоступна/)
  await as('manager', async () => {
    assert.equal((await db.query("update public.tasks set title='Подмена', assignee_id=$1, object_id=$2 where id=$3 returning id", [ids.bob, privateObjectId, task])).rows.length, 0)
    await assert.rejects(db.query('update public.tasks set archived_at=null where id=$1', [task]), /permission denied/)
    await db.query('select public.archive_object($1)', [object])
    assert.equal((await db.query("update public.objects set name='Подмена' where id=$1 returning id", [object])).rows.length, 0)
    await assert.rejects(db.query('update public.objects set archived_at=null where id=$1', [object]), /permission denied/)
    await assert.rejects(db.query("insert into public.tasks(title, object_id, assignee_id) values ('Нет', $1, $2)", [object, ids.alice]), /Объект не найден или находится в архиве/)
    await assert.rejects(db.query('update public.tasks set object_id=$1 where id=$2', [object, bobTask]), /Объект не найден или находится в архиве/)
    for (const table of ['tasks', 'objects']) {
      await assert.rejects(db.query(`truncate public.${table} cascade`), /permission denied/)
    }
  })
  assert.deepEqual((await db.query('select * from public.task_status_history where task_id=$1 order by created_at', [task])).rows, before)
})

test('anonymous callers have no data access and cannot call RPC or helpers', async () => {
  await db.exec('set role anon')
  try {
    for (const table of ['profiles', 'objects', 'tasks', 'task_status_history']) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/)
    }
    await assert.rejects(db.query(`select public.change_task_status($1,'in_progress',null)`, [bobTask]), /permission denied/)
    await assert.rejects(db.query('select private.is_manager()'), /permission denied/)
    await assert.rejects(db.query('select public.archive_task($1)', [bobTask]), /permission denied/)
    await assert.rejects(db.query('select public.archive_object($1)', [privateObjectId]), /permission denied/)
  } finally { await db.exec('reset role') }
  await assert.rejects(move('', bobTask, 'in_progress'), /Требуется вход/)
})
