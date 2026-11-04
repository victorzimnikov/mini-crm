-- Run in Supabase SQL Editor AFTER creating these three Auth users manually.
-- Passwords belong only in Supabase Auth; never put them in this file.
begin;
do $$
declare
  v_manager uuid;
  v_alice uuid;
  v_bob uuid;
  v_first uuid := '10000000-0000-4000-8000-000000000001';
  v_second uuid := '10000000-0000-4000-8000-000000000002';
  v_third uuid := '10000000-0000-4000-8000-000000000003';
  v_task uuid;
begin
  select id into v_manager from auth.users where lower(email) = 'manager@example.com';
  select id into v_alice from auth.users where lower(email) = 'executor1@example.com';
  select id into v_bob from auth.users where lower(email) = 'executor2@example.com';
  if v_manager is null or v_alice is null or v_bob is null then
    raise exception 'Сначала создайте Auth-пользователей: manager@example.com, executor1@example.com, executor2@example.com';
  end if;
  if exists (select 1 from public.objects where id in (v_first, v_second, v_third)) then
    raise notice 'Демонстрационные объекты уже существуют; данные не изменены.';
    return;
  end if;
  insert into public.profiles(id, display_name, role) values
    (v_manager, 'Алексей · Руководитель', 'manager'),
    (v_alice, 'Анна · Исполнитель', 'executor'),
    (v_bob, 'Иван · Исполнитель', 'executor');
  insert into public.objects(id, name, address) values
    (v_first, 'ЖК «Северный»', 'Калининград, ул. Согласия, 12'),
    (v_second, 'Офис на Мира', 'Калининград, проспект Мира, 28'),
    (v_third, 'Склад «Восток»', 'Калининград, ул. Дзержинского, 140');

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  insert into public.tasks(title, description, object_id, assignee_id) values
    ('Проверить монтаж перегородок', 'Проверить размеры проёмов и качество крепления перегородок на втором этаже.', v_first, v_alice);

  insert into public.tasks(title, description, object_id, assignee_id) values
    ('Подготовить стены под отделку', 'Завершить подготовку стен в подъезде № 1 и проверить ровность поверхностей.', v_first, v_bob) returning id into v_task;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform public.change_task_status(v_task, 'in_progress');

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  insert into public.tasks(title, description, object_id, assignee_id) values
    ('Проверить электрику', 'Проверить розетки и освещение в переговорных. Зафиксировать замечания в комментарии.', v_second, v_alice) returning id into v_task;
  perform set_config('request.jwt.claim.sub', v_alice::text, true);
  perform public.change_task_status(v_task, 'in_progress');
  perform public.change_task_status(v_task, 'review', 'Проверка выполнена. Оборудование работает.');

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  insert into public.tasks(title, description, object_id, assignee_id) values
    ('Установить дверные блоки', 'Установить двери в кабинетах 101–104.', v_second, v_bob) returning id into v_task;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform public.change_task_status(v_task, 'in_progress');
  perform public.change_task_status(v_task, 'review');
  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform public.change_task_status(v_task, 'revision', 'Отрегулировать доводчик двери в кабинете 103.');

  insert into public.tasks(title, description, object_id, assignee_id) values
    ('Принять поставку материалов', 'Сверить количество и состояние материалов с накладной.', v_third, v_bob) returning id into v_task;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform public.change_task_status(v_task, 'in_progress');
  perform public.change_task_status(v_task, 'review', 'Материалы приняты, расхождений нет.');
  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform public.change_task_status(v_task, 'accepted', 'Проверено.');

  insert into public.tasks(title, description, object_id, assignee_id) values
    ('Подготовить зону разгрузки', 'Освободить площадку к следующей поставке.', v_third, v_bob);
end;
$$;
commit;
