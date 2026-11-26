-- Rooms v3: void items with a reason, pause/resume a session, audit log.
-- Run after 004_rooms_v2.sql (do NOT re-run 004 afterwards: it would reopen the
-- items table policy). Safe to re-run 005 itself (idempotent).
-- Billing stays by the exact minute: no rounding, no minimum.

alter table public.session_items add column if not exists voided_at timestamptz;
alter table public.session_items add column if not exists void_reason text;
alter table public.session_items add column if not exists voided_by text;
alter table public.room_sessions add column if not exists paused_at timestamptz;

-- ---------- audit log ----------
create table if not exists public.session_audit (
  id         bigint generated always as identity primary key,
  session_id uuid,
  room_name  text,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb,
  actor      text,
  at         timestamptz not null default now()
);
create index if not exists session_audit_at_idx on public.session_audit (at desc);
alter table public.session_audit enable row level security;
drop policy if exists "audit read" on public.session_audit;
create policy "audit read" on public.session_audit for select to authenticated using (true);
-- no insert/update/delete policy: rows are written only by the functions/triggers below

create or replace function public.audit_log(p_session uuid, p_action text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into session_audit (session_id, room_name, action, detail, actor)
  values (p_session,
          (select r.name from room_sessions s join rooms r on r.id = s.room_id where s.id = p_session),
          p_action, coalesce(p_detail, '{}'::jsonb),
          coalesce(nullif(auth.jwt() ->> 'email', ''), 'system'));
end $$;
revoke all on function public.audit_log(uuid, text, jsonb) from public, anon, authenticated;

-- items: staff may read and add; removal is only through void_session_item (needs a reason)
drop policy if exists "session_items staff" on public.session_items;
drop policy if exists "session_items read" on public.session_items;
drop policy if exists "session_items add" on public.session_items;
create policy "session_items read" on public.session_items for select to authenticated using (true);
create policy "session_items add" on public.session_items for insert to authenticated with check (voided_at is null);

-- ---------- triggers: what happened, who did it ----------
create or replace function public.trg_audit_items() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform audit_log(new.session_id, 'item_add',
      jsonb_build_object('name', new.name, 'qty', new.qty, 'price', new.price, 'source', new.source));
  elsif new.voided_at is not null and old.voided_at is null then
    perform audit_log(new.session_id, 'item_void',
      jsonb_build_object('name', new.name, 'qty', new.qty, 'price', new.price, 'reason', new.void_reason));
  end if;
  return new;
end $$;
drop trigger if exists audit_items on public.session_items;
create trigger audit_items after insert or update on public.session_items
  for each row execute function public.trg_audit_items();

create or replace function public.trg_audit_sessions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform audit_log(new.id, 'start', jsonb_build_object('type', new.room_type));
    return new;
  end if;
  if old.ended_at is null and new.ended_at is not null then
    perform audit_log(new.id, 'close', jsonb_build_object('total', new.amount, 'discount', new.discount_amount, 'service', new.service_amount));
  end if;
  if new.deposit_amount is distinct from old.deposit_amount then
    perform audit_log(new.id, 'deposit', jsonb_build_object('amount', new.deposit_amount));
  end if;
  if new.carried_over and not old.carried_over then
    perform audit_log(new.id, 'carry_over', '{}'::jsonb);
  end if;
  if old.paused_at is null and new.paused_at is not null then
    perform audit_log(new.id, 'pause', '{}'::jsonb);
  elsif old.paused_at is not null and new.paused_at is null then
    perform audit_log(new.id, 'resume', '{}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists audit_sessions on public.room_sessions;
create trigger audit_sessions after insert or update on public.room_sessions
  for each row execute function public.trg_audit_sessions();

-- ---------- void an item (staff, reason required) ----------
create or replace function public.void_session_item(p_item_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if length(trim(coalesce(p_reason, ''))) < 2 then raise exception 'reason required'; end if;
  update session_items i
     set voided_at = now(), void_reason = left(trim(p_reason), 120),
         voided_by = coalesce(nullif(auth.jwt() ->> 'email', ''), 'staff')
   where i.id = p_item_id and i.voided_at is null
     and exists (select 1 from room_sessions s where s.id = i.session_id and s.ended_at is null);
  if not found then raise exception 'item not found or session closed'; end if;
end $$;
revoke all on function public.void_session_item(bigint, text) from public, anon;
grant execute on function public.void_session_item(bigint, text) to authenticated;

-- ---------- pause / resume: no time is billed while paused ----------
-- pause closes the running segment; resume opens a new one with the same controllers.
create or replace function public.pause_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update room_sessions set paused_at = now()
   where id = p_session_id and ended_at is null and paused_at is null;
  if not found then raise exception 'session not open or already paused'; end if;
  update room_session_segments set ended_at = now()
   where session_id = p_session_id and ended_at is null;
end $$;
revoke all on function public.pause_session(uuid) from public, anon;
grant execute on function public.pause_session(uuid) to authenticated;

create or replace function public.resume_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare ctl smallint;
begin
  update room_sessions set paused_at = null
   where id = p_session_id and ended_at is null and paused_at is not null;
  if not found then raise exception 'session not paused'; end if;
  select controllers into ctl from room_session_segments
   where session_id = p_session_id order by id desc limit 1;
  insert into room_session_segments (session_id, controllers) values (p_session_id, coalesce(ctl, 2));
end $$;
revoke all on function public.resume_session(uuid) from public, anon;
grant execute on function public.resume_session(uuid) to authenticated;

-- switching controllers: refused while paused, and logged
create or replace function public.switch_session_controllers(p_session_id uuid, p_controllers smallint)
returns void language plpgsql security definer set search_path = public as $$
declare prev smallint;
begin
  if p_controllers not in (2,4) then raise exception 'controllers must be 2 or 4'; end if;
  if not exists (select 1 from room_sessions where id = p_session_id and ended_at is null) then
    raise exception 'session not open'; end if;
  if exists (select 1 from room_sessions where id = p_session_id and paused_at is not null) then
    raise exception 'session is paused, resume first'; end if;
  select controllers into prev from room_session_segments where session_id = p_session_id and ended_at is null;
  update room_session_segments set ended_at = now()
    where session_id = p_session_id and ended_at is null;
  insert into room_session_segments (session_id, controllers) values (p_session_id, p_controllers);
  perform audit_log(p_session_id, 'controllers', jsonb_build_object('from', prev, 'to', p_controllers));
end $$;
revoke all on function public.switch_session_controllers(uuid, smallint) from public, anon;
grant execute on function public.switch_session_controllers(uuid, smallint) to authenticated;

-- bill functions again, now ignoring voided items
create or replace function public.session_accrual(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rtype text; rname text; t_cost int; i_cost int; mins int; started timestamptz; ctl int;
begin
  select s.room_type, r.name, s.started_at into rtype, rname, started
    from room_sessions s join rooms r on r.id = s.room_id
   where s.id = p_session_id and s.ended_at is null;
  if rtype is null then return null; end if;
  select g.controllers into ctl from room_session_segments g
    where g.session_id = p_session_id and g.ended_at is null limit 1;
  select coalesce(sum(extract(epoch from (coalesce(g.ended_at, now()) - g.started_at)) / 60), 0)::int into mins
    from room_session_segments g where g.session_id = p_session_id;
  select coalesce(round(sum(
           extract(epoch from (coalesce(g.ended_at, now()) - g.started_at)) / 60.0 / 60.0
           * coalesce((select hourly_price from room_rates
                        where room_type = rtype and controllers = g.controllers), 0)
         )), 0)::int into t_cost
    from room_session_segments g where g.session_id = p_session_id;
  select coalesce(sum(price * qty), 0)::int into i_cost
    from session_items where session_id = p_session_id and voided_at is null;
  return jsonb_build_object('room', rname, 'started_at', started, 'controllers', ctl,
    'minutes', mins, 'time_amount', t_cost, 'items_amount', i_cost, 'subtotal', t_cost + i_cost);
end $$;
revoke all on function public.session_accrual(uuid) from public, anon;
grant execute on function public.session_accrual(uuid) to authenticated;

create or replace function public.close_room_session(
  p_session_id uuid,
  p_discount_kind text default null, p_discount_value numeric default 0,
  p_service_kind text default null, p_service_value numeric default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t_cost int; i_cost int; mins int; rtype text; disc int; serv int; base int;
begin
  update room_session_segments set ended_at = now()
    where session_id = p_session_id and ended_at is null;
  select room_type into rtype from room_sessions where id = p_session_id and ended_at is null;
  if rtype is null then raise exception 'session not open'; end if;
  select coalesce(sum(extract(epoch from (ended_at - started_at)) / 60), 0)::int into mins
    from room_session_segments where session_id = p_session_id;
  select coalesce(round(sum(
           extract(epoch from (g.ended_at - g.started_at)) / 60.0 / 60.0
           * coalesce((select hourly_price from room_rates
                        where room_type = rtype and controllers = g.controllers), 0)
         )), 0)::int into t_cost
    from room_session_segments g where g.session_id = p_session_id;
  select coalesce(sum(price * qty), 0)::int into i_cost
    from session_items where session_id = p_session_id and voided_at is null;
  base := t_cost + i_cost;
  disc := case when p_discount_kind = 'percent' then round(base * least(greatest(coalesce(p_discount_value,0),0),100) / 100.0)
               when p_discount_kind = 'amount'  then least(greatest(coalesce(p_discount_value,0),0), base)
               else 0 end;
  serv := case when p_service_kind = 'percent' then round((base - disc) * least(greatest(coalesce(p_service_value,0),0),100) / 100.0)
               when p_service_kind = 'amount'  then greatest(coalesce(p_service_value,0),0)
               else 0 end;
  update room_sessions
     set ended_at = now(), time_amount = t_cost, items_amount = i_cost,
         discount_amount = disc, service_amount = serv, amount = base - disc + serv,
         shift_id = (select id from shifts where closed_at is null order by id desc limit 1)
   where id = p_session_id;
  return jsonb_build_object('minutes', mins, 'time_amount', t_cost, 'items_amount', i_cost,
    'discount_amount', disc, 'service_amount', serv, 'total', base - disc + serv,
    'deposit', (select deposit_amount from room_sessions where id = p_session_id),
    'remaining', base - disc + serv - (select deposit_amount from room_sessions where id = p_session_id));
end $$;
revoke all on function public.close_room_session(uuid, text, numeric, text, numeric) from public, anon;
grant execute on function public.close_room_session(uuid, text, numeric, text, numeric) to authenticated;
