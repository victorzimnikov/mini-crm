begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create type public.user_role as enum ('manager', 'executor');
create type public.task_status as enum ('new', 'in_progress', 'review', 'accepted', 'revision');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role public.user_role not null
);

create table public.objects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  address text not null check (length(btrim(address)) between 1 and 500)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 10000),
  object_id uuid not null references public.objects(id) on delete restrict,
  assignee_id uuid not null references public.profiles(id) on delete restrict,
  status public.task_status not null default 'new',
  author_id uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.task_status_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  from_status public.task_status,
  to_status public.task_status not null,
  comment text check (length(comment) <= 2000)
);

create index tasks_assignee_idx on public.tasks(assignee_id);
create index tasks_object_idx on public.tasks(object_id);
create index tasks_author_idx on public.tasks(author_id);
create index task_history_task_idx on public.task_status_history(task_id, created_at);
create index task_history_actor_idx on public.task_status_history(actor_id);

-- The role comes only from the protected table, never from user-editable metadata.
create function private.is_manager() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = (select auth.uid()) and role = 'manager'
  );
$$;
revoke all on function private.is_manager() from public, anon;
grant execute on function private.is_manager() to authenticated;

alter table public.profiles enable row level security;
alter table public.objects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_status_history enable row level security;

create policy tasks_read on public.tasks for select to authenticated
using (private.is_manager() or assignee_id = (select auth.uid()));
create policy tasks_insert on public.tasks for insert to authenticated
with check (private.is_manager() and status = 'new' and author_id = (select auth.uid()));
create policy tasks_update on public.tasks for update to authenticated
using (private.is_manager()) with check (private.is_manager());
create policy tasks_delete on public.tasks for delete to authenticated
using (private.is_manager());

create policy objects_read on public.objects for select to authenticated
using (private.is_manager() or exists (
  select 1 from public.tasks t where t.object_id = objects.id and t.assignee_id = (select auth.uid())
));
create policy objects_insert on public.objects for insert to authenticated
with check (private.is_manager());
create policy objects_update on public.objects for update to authenticated
using (private.is_manager()) with check (private.is_manager());
create policy objects_delete on public.objects for delete to authenticated
using (private.is_manager());

create policy history_read on public.task_status_history for select to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id));

-- Executors see only themselves and people mentioned on their accessible tasks.
create policy profiles_read on public.profiles for select to authenticated
using (
  id = (select auth.uid()) or private.is_manager()
  or exists (select 1 from public.tasks t where t.author_id = profiles.id)
  or exists (select 1 from public.task_status_history h where h.actor_id = profiles.id)
);

-- Supabase projects may have default table grants: replace them explicitly.
revoke all on public.profiles, public.objects, public.tasks, public.task_status_history
  from public, anon, authenticated;
grant select on public.profiles, public.objects, public.tasks, public.task_status_history to authenticated;
grant insert (name, address), update (name, address), delete on public.objects to authenticated;
grant insert (title, description, object_id, assignee_id),
  update (title, description, object_id, assignee_id), delete on public.tasks to authenticated;

create function private.validate_assignee() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles where id = new.assignee_id and role = 'executor') then
    raise exception 'Назначить задачу можно только исполнителю' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_assignee() from public, anon, authenticated;
create trigger validate_task_assignee before insert or update of assignee_id on public.tasks
for each row execute function private.validate_assignee();

create function private.log_task_creation() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.task_status_history (task_id, actor_id, from_status, to_status)
  values (new.id, new.author_id, null, new.status);
  return new;
end;
$$;
revoke all on function private.log_task_creation() from public, anon, authenticated;
create trigger log_task_creation after insert on public.tasks
for each row execute function private.log_task_creation();

-- The only client entry point for a status change. The row lock serializes
-- concurrent requests, including reassignment and deletion by a manager.
create function public.change_task_status(
  p_task_id uuid,
  p_next_status public.task_status,
  p_comment text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
  v_user uuid := auth.uid();
  v_manager boolean;
  v_comment text := nullif(btrim(p_comment, E' \t\n\r'), '');
  v_allowed boolean;
begin
  if v_user is null then
    raise exception 'Требуется вход в систему' using errcode = '42501';
  end if;
  v_manager := private.is_manager();
  select * into v_task from public.tasks
  where id = p_task_id and (v_manager or assignee_id = v_user)
  for update;
  if not found then
    raise exception 'Задача не найдена или недоступна' using errcode = '42501';
  end if;

  v_allowed :=
    (v_manager and v_task.status = 'review' and p_next_status in ('accepted', 'revision'))
    or (not v_manager and v_task.assignee_id = v_user and (
      (v_task.status in ('new', 'revision') and p_next_status = 'in_progress')
      or (v_task.status = 'in_progress' and p_next_status = 'review')
    ));
  if v_allowed is distinct from true then
    raise exception 'Этот переход статуса запрещён' using errcode = '23514';
  end if;
  if p_next_status = 'revision' and v_comment is null then
    raise exception 'Укажите причину возврата на доработку' using errcode = '23514';
  end if;
  if length(v_comment) > 2000 then
    raise exception 'Комментарий не должен превышать 2000 символов' using errcode = '23514';
  end if;

  update public.tasks set status = p_next_status where id = v_task.id;
  insert into public.task_status_history (task_id, actor_id, from_status, to_status, comment)
  values (v_task.id, v_user, v_task.status, p_next_status, v_comment);
end;
$$;
revoke all on function public.change_task_status(uuid, public.task_status, text) from public, anon;
grant execute on function public.change_task_status(uuid, public.task_status, text) to authenticated;

commit;
