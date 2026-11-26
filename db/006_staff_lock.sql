-- Security hardening. Run after 005_rooms_v3.sql. Safe to re-run (idempotent).
-- Why: Supabase Auth lets anyone with the public anon key sign up, and every staff
-- policy was "to authenticated using (true)". So a customer who signed up could read
-- and change prices, rooms, bills, shifts, orders. Now only emails listed in
-- staff_emails count as staff, in every policy and every staff function.
-- Also: attach_order_to_room (adds items to a room bill) is no longer callable with the
-- public key alone: /api/order passes a server-side secret.

create table if not exists public.staff_emails (email text primary key);
alter table public.staff_emails enable row level security;   -- no policies: unreadable via the API
-- the admin account(s). Add more rows here to add more staff.
insert into public.staff_emails (email) values ('metwlii.dev@gmail.com') on conflict do nothing;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_emails
                  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- every staff policy now requires is_staff()
do $$
declare r record;
begin
  for r in
    select tablename, policyname, cmd from pg_policies
     where schemaname = 'public'
       and tablename in ('menu_overrides','rooms','room_sessions','room_rates','room_session_segments',
                         'session_items','shifts','session_audit','orders')
       and 'authenticated' = any (roles::text[]) and not ('anon' = any (roles::text[]))
  loop
    if r.cmd = 'INSERT' then
      execute format('alter policy %I on public.%I with check (public.is_staff())', r.policyname, r.tablename);
    elsif r.cmd in ('SELECT','DELETE') then
      execute format('alter policy %I on public.%I using (public.is_staff())', r.policyname, r.tablename);
    else
      execute format('alter policy %I on public.%I using (public.is_staff()) with check (public.is_staff())', r.policyname, r.tablename);
    end if;
  end loop;
end $$;
drop policy if exists "session_items add" on public.session_items;
create policy "session_items add" on public.session_items for insert to authenticated
  with check (public.is_staff() and voided_at is null);

-- every staff function refuses non-staff (guard added as the first statement)
do $$
declare r record; def text;
begin
  for r in
    select p.oid from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
       and p.proname in ('start_room_session','switch_session_controllers','set_session_deposit','carry_over_session',
                         'open_shift','close_shift','close_room_session','void_session_item','pause_session',
                         'resume_session','session_accrual')
  loop
    def := pg_get_functiondef(r.oid);
    if position('is_staff' in def) = 0 then
      def := regexp_replace(def, E'\nbegin\n',
        E'\nbegin\n  if not public.is_staff() then raise exception ''not authorized'' using errcode = ''42501''; end if;\n');
      execute def;
    end if;
  end loop;
end $$;
-- only called inside close_shift (definer), never directly
revoke execute on function public.shift_totals(smallint) from authenticated;
-- trigger functions are not meant to be called
revoke execute on function public.trg_audit_items() from public, anon, authenticated;
revoke execute on function public.trg_audit_sessions() from public, anon, authenticated;

-- ---------- room attach: needs a server-side secret ----------
create table if not exists public.app_secrets (name text primary key, hash text not null);
alter table public.app_secrets enable row level security;     -- no policies: unreadable via the API

drop function if exists public.attach_order_to_room(text, jsonb, uuid);
create or replace function public.attach_order_to_room(p_code text, p_items jsonb, p_order_id uuid, p_secret text)
returns boolean language plpgsql security definer set search_path = public as $$
declare sid uuid; n int;
begin
  if p_secret is null or not exists (
       select 1 from app_secrets
        where name = 'room_attach' and hash = encode(sha256(convert_to(p_secret, 'utf8')), 'hex')) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select s.id into sid
    from room_sessions s join rooms r on r.id = s.room_id
   where s.ended_at is null and r.active and r.code = trim(p_code)
   limit 1;
  if sid is null then return false; end if;
  -- sanity caps even for the server: at most 40 lines per order
  select count(*) into n from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));
  if n > 40 then raise exception 'too many items'; end if;
  insert into session_items (session_id, name, price, qty, source, order_id)
    select sid,
           left(coalesce(it->>'name',''), 60),
           least(greatest((it->>'price')::int, 0), 2000),
           least(greatest((it->>'qty')::int, 1), 50),
           'order', p_order_id
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
     where (it->>'name') is not null;
  return true;
end $$;
revoke all on function public.attach_order_to_room(text, jsonb, uuid, text) from public;
grant execute on function public.attach_order_to_room(text, jsonb, uuid, text) to anon, authenticated;
