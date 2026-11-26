-- Cashier permissions: the admin switches each cashier action on/off (admin dashboard, Settings).
-- Stored in app_settings config -> cashier_perms {"vip":true,...}; a missing key means ALLOWED
-- (so nothing changes until the admin turns something off). Admin is never restricted.
-- Enforced in the database: every staff function and the session_items insert policy call staff_can(). Safe to re-run.
-- Keys: start, pause (pause + resume), tier (فردي/زوجي switch), vip, void, add_items, deposit, carry_over, close, shift (open/close shift)

create or replace function public.staff_can(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_staff() and coalesce(
    (select (value->'cashier_perms'->>p)::boolean from app_settings where key = 'config'), true))
$$;
revoke all on function public.staff_can(text) from public, anon;
grant execute on function public.staff_can(text) to authenticated;

do $$
declare r record; def text;
  m jsonb := '{"start_room_session":"start","pause_session":"pause","resume_session":"pause","switch_session_controllers":"tier",
    "set_session_vip":"vip","set_room_vip":"vip","void_session_item":"void","set_session_deposit":"deposit","carry_over_session":"carry_over",
    "open_shift":"shift","close_shift":"shift","close_room_session":"close"}';
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and m ? p.proname loop
    def := pg_get_functiondef(r.oid);
    if position('public.is_staff()' in def) > 0 then
      execute replace(def, 'public.is_staff()', format('public.staff_can(%L)', m->>r.proname));
    end if;
  end loop;
end $$;

drop policy if exists "session_items add" on public.session_items;
create policy "session_items add" on public.session_items for insert to authenticated
  with check (public.staff_can('add_items') and voided_at is null);

-- audit of permission changes
create table if not exists public.settings_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(), actor text, detail jsonb not null
);
alter table public.settings_audit enable row level security;
drop policy if exists "settings_audit admin read" on public.settings_audit;
create policy "settings_audit admin read" on public.settings_audit for select to authenticated using (public.is_admin());
grant select on public.settings_audit to authenticated;

create or replace function public.trg_settings_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.value->'cashier_perms') is distinct from (new.value->'cashier_perms') then
    insert into settings_audit (actor, detail) values (coalesce(auth.jwt()->>'email', 'system'),
      jsonb_build_object('action', 'cashier_perms', 'from', coalesce(old.value->'cashier_perms', '{}'::jsonb), 'to', coalesce(new.value->'cashier_perms', '{}'::jsonb)));
  end if;
  return new;
end $$;
drop trigger if exists app_settings_audit on public.app_settings;
create trigger app_settings_audit after update on public.app_settings for each row execute function public.trg_settings_audit();

create or replace function public.set_cashier_perms(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  foreach k in array array['start','pause','tier','vip','void','add_items','deposit','carry_over','close','shift'] loop
    if p ? k then clean := clean || jsonb_build_object(k, (p->>k)::boolean); end if;
  end loop;
  update app_settings set value = jsonb_set(value, '{cashier_perms}', clean, true), updated_at = now() where key = 'config';
end $$;
revoke all on function public.set_cashier_perms(jsonb) from public, anon;
grant execute on function public.set_cashier_perms(jsonb) to authenticated;
