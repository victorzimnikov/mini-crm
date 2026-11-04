begin;

-- Keep the task and its parent object so their audit trail can always be read.
alter table public.tasks add column archived_at timestamptz;
alter table public.objects add column archived_at timestamptz;
alter table public.task_status_history drop constraint task_status_history_task_id_fkey;
alter table public.task_status_history add constraint task_status_history_task_id_fkey
  foreign key (task_id) references public.tasks(id) on delete restrict;

revoke delete on public.tasks, public.objects from public, anon, authenticated;
drop policy tasks_delete on public.tasks;
drop policy objects_delete on public.objects;

alter policy tasks_read on public.tasks
  using (private.is_manager() or (archived_at is null and assignee_id = (select auth.uid())));
alter policy tasks_update on public.tasks
  using (private.is_manager() and archived_at is null)
  with check (private.is_manager() and archived_at is null);
alter policy objects_read on public.objects
  using (private.is_manager() or (archived_at is null and exists (
    select 1 from public.tasks t
    where t.object_id = objects.id and t.assignee_id = (select auth.uid()) and t.archived_at is null
  )));
alter policy objects_update on public.objects
  using (private.is_manager() and archived_at is null)
  with check (private.is_manager() and archived_at is null);

-- Lock the parent against archiving while a task is created or moved to it.
create function private.validate_task_object() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.objects where id = new.object_id and archived_at is null for share;
  if not found then
    raise exception 'Объект не найден или находится в архиве' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_task_object() from public, anon, authenticated;
create trigger validate_task_object before insert or update of object_id on public.tasks
for each row execute function private.validate_task_object();

create function public.archive_task(p_task_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_manager() then
    raise exception 'Архивировать задачи может только постановщик' using errcode = '42501';
  end if;
  -- UPDATE takes the same row lock as change_task_status and ordinary edits.
  update public.tasks set archived_at = clock_timestamp()
  where id = p_task_id and archived_at is null;
  if not found then
    raise exception 'Задача не найдена или уже в архиве' using errcode = '23514';
  end if;
end;
$$;
revoke all on function public.archive_task(uuid) from public, anon;
grant execute on function public.archive_task(uuid) to authenticated;

create function public.archive_object(p_object_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_manager() then
    raise exception 'Архивировать объекты может только постановщик' using errcode = '42501';
  end if;
  perform 1 from public.objects where id = p_object_id and archived_at is null for update;
  if not found then
    raise exception 'Объект не найден или уже в архиве' using errcode = '23514';
  end if;
  if exists (select 1 from public.tasks where object_id = p_object_id and archived_at is null) then
    raise exception 'Сначала архивируйте активные задачи объекта' using errcode = '23514';
  end if;
  update public.objects set archived_at = clock_timestamp() where id = p_object_id;
end;
$$;
revoke all on function public.archive_object(uuid) from public, anon;
grant execute on function public.archive_object(uuid) to authenticated;

create or replace function public.change_task_status(
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
  where id = p_task_id and archived_at is null and (v_manager or assignee_id = v_user)
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

commit;
