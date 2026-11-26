-- Roles: admin (the owner, real email) and staff (cashiers, plain usernames).
-- Run after 006_staff_lock.sql. Safe to re-run.
-- Staff log in with a username; internally it maps to <username>@staff.evo.invalid (non-routable).
-- Admin can create / disable / reset / delete staff from the panel; no service key needed
-- (the functions below are security definer and refuse anyone who is not an active admin).
create extension if not exists pgcrypto with schema extensions;

alter table public.staff_emails add column if not exists role text not null default 'staff';
alter table public.staff_emails add column if not exists username text;
alter table public.staff_emails add column if not exists active boolean not null default true;
alter table public.staff_emails add column if not exists created_at timestamptz not null default now();
alter table public.staff_emails drop constraint if exists staff_emails_role_chk;
alter table public.staff_emails add constraint staff_emails_role_chk check (role in ('admin','staff'));
update public.staff_emails set role = 'admin' where lower(email) = 'metwlii.dev@gmail.com';

create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public as $$
  select role from staff_emails
   where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$ select public.staff_role() is not null $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.staff_role() = 'admin' $$;
revoke all on function public.staff_role(), public.is_staff(), public.is_admin() from public, anon;
grant execute on function public.staff_role(), public.is_staff(), public.is_admin() to authenticated;

-- ---------- table permissions ----------
-- cashier: read everything, write nothing directly. Money-moving writes go through the guarded functions.
-- admin-only direct writes: menu prices, hourly rates, rooms (add / rename / delete).
-- session_items insert stays staff (manual items), see 006.
do $$
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
     where schemaname = 'public'
       and tablename in ('menu_overrides','rooms','room_rates','room_sessions','room_session_segments','shifts')
       and 'authenticated' = any (roles::text[]) and not ('anon' = any (roles::text[]))
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;
do $$
declare t text;
begin
  foreach t in array array['menu_overrides','rooms','room_rates','room_sessions','room_session_segments','shifts'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || ' staff read', t);
  end loop;
  foreach t in array array['menu_overrides','rooms','room_rates'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_admin())', t || ' admin ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t || ' admin upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())', t || ' admin del', t);
  end loop;
end $$;

-- void needs an admin (money control); every void is audited with the admin's name
create or replace function public.void_session_item(p_item_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 2 then raise exception 'reason required'; end if;
  update session_items i
     set voided_at = now(), void_reason = left(trim(p_reason), 120),
         voided_by = coalesce(nullif(auth.jwt() ->> 'email', ''), 'admin')
   where i.id = p_item_id and i.voided_at is null
     and exists (select 1 from room_sessions s where s.id = i.session_id and s.ended_at is null);
  if not found then raise exception 'item not found or session closed'; end if;
end $$;
revoke all on function public.void_session_item(bigint, text) from public, anon;
grant execute on function public.void_session_item(bigint, text) to authenticated;

-- ---------- staff management (admin only) ----------
create or replace function public._staff_email(p_username text) returns text
language sql immutable as $$ select lower(trim(p_username)) || '@staff.evo.invalid' $$;
revoke all on function public._staff_email(text) from public, anon, authenticated;

create or replace function public.staff_list()
returns table (username text, active boolean, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select s.username, s.active, s.created_at from staff_emails s
                where s.role = 'staff' order by s.created_at;
end $$;

create or replace function public.staff_create(p_username text, p_password text)
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
declare u text := lower(trim(coalesce(p_username, ''))); em text; uid uuid := gen_random_uuid();
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if u !~ '^[a-z0-9._-]{3,20}$' then raise exception 'username: 3-20 letters/digits/._-'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'password: at least 8 characters'; end if;
  em := public._staff_email(u);
  if exists (select 1 from staff_emails where username = u) or exists (select 1 from auth.users where email = em) then
    raise exception 'username already exists';
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
          crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('username', u), now(), now(),
          '', '', '', '');
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid::text, uid,
          jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
  insert into staff_emails (email, role, username, active) values (em, 'staff', u, true);
end $$;

create or replace function public.staff_set_active(p_username text, p_active boolean)
returns void language plpgsql security definer set search_path = public, auth as $$
declare em text := public._staff_email(p_username); uid uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  update staff_emails set active = p_active where email = em and role = 'staff';
  if not found then raise exception 'no such staff user'; end if;
  select id into uid from auth.users where email = em;
  update auth.users set banned_until = case when p_active then null else '2999-01-01'::timestamptz end where id = uid;
  if not p_active then
    delete from auth.refresh_tokens where user_id = uid::text;
    delete from auth.sessions where user_id = uid;
  end if;
end $$;

create or replace function public.staff_reset_password(p_username text, p_password text)
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
declare em text := public._staff_email(p_username); uid uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'password: at least 8 characters'; end if;
  if not exists (select 1 from staff_emails where email = em and role = 'staff') then raise exception 'no such staff user'; end if;
  select id into uid from auth.users where email = em;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = uid;
  delete from auth.refresh_tokens where user_id = uid::text;
  delete from auth.sessions where user_id = uid;
end $$;

create or replace function public.staff_delete(p_username text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare em text := public._staff_email(p_username);
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from staff_emails where email = em and role = 'staff') then raise exception 'no such staff user'; end if;
  delete from staff_emails where email = em and role = 'staff';
  delete from auth.users where email = em;   -- cascades identities / sessions / refresh tokens
end $$;

revoke all on function public.staff_list(), public.staff_create(text, text), public.staff_set_active(text, boolean),
  public.staff_reset_password(text, text), public.staff_delete(text) from public, anon;
grant execute on function public.staff_list(), public.staff_create(text, text), public.staff_set_active(text, boolean),
  public.staff_reset_password(text, text), public.staff_delete(text) to authenticated;
