-- Rooms v2: PS4/PS5 types, per-type per-controller rates, mid-session controller
-- switching (billed per segment), items attached to a room session (from app
-- orders or added manually by staff), and a full bill on close.
-- Run after 003_rooms.sql. Safe to re-run (idempotent).

-- ---------- rooms: type + customer-facing code ----------
alter table public.rooms add column if not exists room_type text not null default 'ps4';
alter table public.rooms add column if not exists code text;
-- backfill code from the digits in the room name ('غرفة 1' -> '1'); edit in admin
update public.rooms set code = (regexp_match(name, '(\d+)'))[1] where code is null and name ~ '\d+';
create unique index if not exists rooms_code_key on public.rooms (code) where code is not null;

-- snapshot of the type at session start, and the bill breakdown on close
alter table public.room_sessions add column if not exists room_type text;
alter table public.room_sessions add column if not exists time_amount smallint;
alter table public.room_sessions add column if not exists items_amount smallint;

-- ---------- rates: type x controllers -> EGP/hour (editable in admin) ----------
create table if not exists public.room_rates (
  room_type    text not null check (room_type in ('ps4','ps5')),
  controllers  smallint not null check (controllers in (2,4)),
  hourly_price smallint not null check (hourly_price between 0 and 2000),
  primary key (room_type, controllers)
);
alter table public.room_rates enable row level security;
drop policy if exists "room_rates staff" on public.room_rates;
create policy "room_rates staff" on public.room_rates for all to authenticated using (true) with check (true);
-- seeds (edit in admin): فور 2/4 ايادي, فايف 2/4 ايادي
insert into public.room_rates (room_type, controllers, hourly_price)
  values ('ps4', 2, 40), ('ps4', 4, 60), ('ps5', 2, 50), ('ps5', 4, 70)
on conflict do nothing;

-- ---------- time segments: one row per controller-count stretch ----------
create table if not exists public.room_session_segments (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.room_sessions(id) on delete cascade,
  controllers smallint not null check (controllers in (2,4)),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
alter table public.room_session_segments enable row level security;
drop policy if exists "segments staff" on public.room_session_segments;
create policy "segments staff" on public.room_session_segments for all to authenticated using (true) with check (true);

-- ---------- items consumed in the room (app orders + manual staff adds) ----------
create table if not exists public.session_items (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.room_sessions(id) on delete cascade,
  name        text not null,
  price       smallint not null check (price between 0 and 2000),
  qty         smallint not null default 1 check (qty between 1 and 100),
  source      text not null default 'manual' check (source in ('manual','order')),
  order_id    uuid,
  created_at  timestamptz not null default now()
);
alter table public.session_items enable row level security;
drop policy if exists "session_items staff" on public.session_items;
create policy "session_items staff" on public.session_items for all to authenticated using (true) with check (true);

-- ---------- start a session (staff) ----------
create or replace function public.start_room_session(p_room_id smallint, p_controllers smallint)
returns uuid language plpgsql security definer set search_path = public as $$
declare sid uuid; rtype text;
begin
  if p_controllers not in (2,4) then raise exception 'controllers must be 2 or 4'; end if;
  if exists (select 1 from room_sessions where room_id = p_room_id and ended_at is null) then
    raise exception 'room already has an open session'; end if;
  select room_type into rtype from rooms where id = p_room_id and active;
  if rtype is null then raise exception 'room not found'; end if;
  insert into room_sessions (room_id, room_type) values (p_room_id, rtype) returning id into sid;
  insert into room_session_segments (session_id, controllers) values (sid, p_controllers);
  return sid;
end $$;
revoke all on function public.start_room_session(smallint, smallint) from public, anon;
grant execute on function public.start_room_session(smallint, smallint) to authenticated;

-- ---------- switch controllers mid-session (staff): closes current segment ----------
create or replace function public.switch_session_controllers(p_session_id uuid, p_controllers smallint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_controllers not in (2,4) then raise exception 'controllers must be 2 or 4'; end if;
  if not exists (select 1 from room_sessions where id = p_session_id and ended_at is null) then
    raise exception 'session not open'; end if;
  update room_session_segments set ended_at = now()
    where session_id = p_session_id and ended_at is null;
  insert into room_session_segments (session_id, controllers) values (p_session_id, p_controllers);
end $$;
revoke all on function public.switch_session_controllers(uuid, smallint) from public, anon;
grant execute on function public.switch_session_controllers(uuid, smallint) to authenticated;

-- ---------- attach an app order to a room's open session (called by /api/order) ----------
-- p_code is what the customer typed as "رقم الغرفة". No session open -> returns false,
-- the order itself is unaffected.
create or replace function public.attach_order_to_room(p_code text, p_items jsonb, p_order_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  select s.id into sid
    from room_sessions s join rooms r on r.id = s.room_id
   where s.ended_at is null and r.active and r.code = trim(p_code)
   limit 1;
  if sid is null then return false; end if;
  insert into session_items (session_id, name, price, qty, source, order_id)
    select sid,
           left(coalesce(it->>'name',''), 60),
           least(greatest((it->>'price')::int, 0), 2000),
           least(greatest((it->>'qty')::int, 1), 100),
           'order', p_order_id
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
     where (it->>'name') is not null;
  return true;
end $$;
revoke all on function public.attach_order_to_room(text, jsonb, uuid) from public;
grant execute on function public.attach_order_to_room(text, jsonb, uuid) to anon, authenticated;

-- ---------- discount / service on the bill, set at close ----------
alter table public.room_sessions add column if not exists discount_amount smallint not null default 0;
alter table public.room_sessions add column if not exists service_amount smallint not null default 0;

-- advance payment: received (and counted) in one shift, the rest at close
alter table public.room_sessions add column if not exists deposit_amount smallint not null default 0;
alter table public.room_sessions add column if not exists deposit_shift_id smallint;
-- explicit carry-over: a shift cannot close while an open session is neither
-- closed nor explicitly carried over
alter table public.room_sessions add column if not exists carried_over boolean not null default false;

-- ---------- shifts: a session's bill belongs to the shift that CLOSES it ----------
-- (cash is collected on close). Sessions stay open across handover; the outgoing
-- shift's report lists them as carried over with what they accrued at handover.
create table if not exists public.shifts (
  id         smallserial primary key,
  label      text not null default '',
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  report     jsonb  -- frozen totals + carryover list, written at close
);
alter table public.shifts enable row level security;
drop policy if exists "shifts staff" on public.shifts;
create policy "shifts staff" on public.shifts for all to authenticated using (true) with check (true);

alter table public.room_sessions add column if not exists shift_id smallint references public.shifts(id);

create or replace function public.open_shift(p_label text)
returns smallint language plpgsql security definer set search_path = public as $$
declare nid smallint;
begin
  if exists (select 1 from shifts where closed_at is null) then raise exception 'a shift is already open'; end if;
  insert into shifts (label) values (left(coalesce(p_label,''), 40)) returning id into nid;
  return nid;
end $$;
revoke all on function public.open_shift(text) from public, anon;
grant execute on function public.open_shift(text) to authenticated;

-- what an open session has accrued right now (used for handover carryover)
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
    from session_items where session_id = p_session_id;
  return jsonb_build_object('room', rname, 'started_at', started, 'controllers', ctl,
    'minutes', mins, 'time_amount', t_cost, 'items_amount', i_cost, 'subtotal', t_cost + i_cost);
end $$;
revoke all on function public.session_accrual(uuid) from public, anon;
grant execute on function public.session_accrual(uuid) to authenticated;

-- record/replace the advance payment on an open session (staff)
create or replace function public.set_session_deposit(p_session_id uuid, p_amount smallint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_amount, 0) < 0 then raise exception 'bad amount'; end if;
  update room_sessions
     set deposit_amount = p_amount,
         deposit_shift_id = (select id from shifts where closed_at is null order by id desc limit 1)
   where id = p_session_id and ended_at is null;
  if not found then raise exception 'session not open'; end if;
end $$;
revoke all on function public.set_session_deposit(uuid, smallint) from public, anon;
grant execute on function public.set_session_deposit(uuid, smallint) to authenticated;

-- explicit carry-over of an open session to the next shift (staff)
create or replace function public.carry_over_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update room_sessions set carried_over = true where id = p_session_id and ended_at is null;
  if not found then raise exception 'session not open'; end if;
end $$;
revoke all on function public.carry_over_session(uuid) from public, anon;
grant execute on function public.carry_over_session(uuid) to authenticated;

-- per-shift accounting: sessions CLOSED in this shift (their shift_id = this shift),
-- deposits RECEIVED in this shift, and the cash view (deposit in receiving shift,
-- remainder in closing shift)
create or replace function public.shift_totals(p_shift_id smallint)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'sessions', count(*) filter (where shift_id = p_shift_id),
    'minutes', coalesce(sum(extract(epoch from (ended_at - started_at))/60) filter (where shift_id = p_shift_id),0)::int,
    'time_amount', coalesce(sum(time_amount) filter (where shift_id = p_shift_id),0),
    'items_amount', coalesce(sum(items_amount) filter (where shift_id = p_shift_id),0),
    'discount_amount', coalesce(sum(discount_amount) filter (where shift_id = p_shift_id),0),
    'service_amount', coalesce(sum(service_amount) filter (where shift_id = p_shift_id),0),
    'total', coalesce(sum(amount) filter (where shift_id = p_shift_id),0),
    'deposits_received', coalesce(sum(deposit_amount) filter (where deposit_shift_id = p_shift_id),0),
    'collected_at_close', coalesce(sum(amount - deposit_amount) filter (where shift_id = p_shift_id),0))
  from room_sessions where ended_at is not null and (shift_id = p_shift_id or deposit_shift_id = p_shift_id);
$$;
revoke all on function public.shift_totals(smallint) from public, anon;
grant execute on function public.shift_totals(smallint) to authenticated;

-- close the open shift: BLOCKED while any open session is neither closed nor
-- explicitly carried over. On success, freeze totals + carryover list into
-- shifts.report and reset carry-over flags for the next handover.
create or replace function public.close_shift()
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid smallint; rep jsonb; carry jsonb; pending int;
begin
  select id into sid from shifts where closed_at is null order by id desc limit 1;
  if sid is null then raise exception 'no open shift'; end if;
  select count(*) into pending from room_sessions where ended_at is null and not carried_over;
  if pending > 0 then raise exception 'there are % open session(s) not closed and not carried over', pending; end if;
  select coalesce(jsonb_agg(session_accrual(s.id)), '[]'::jsonb) into carry
    from room_sessions s where s.ended_at is null;
  rep := shift_totals(sid) || jsonb_build_object('handed_over', carry);
  update shifts set closed_at = now(), report = rep where id = sid;
  update room_sessions set carried_over = false where ended_at is null;
  return rep;
end $$;
revoke all on function public.close_shift() from public, anon;
grant execute on function public.close_shift() to authenticated;

-- ---------- close a session and compute the bill (staff) ----------
-- time cost: each segment billed at the rate for the session's type and that
-- segment's controller count, minutes-weighted, rounded once.
-- discount/service: p_kind 'percent' (value 0-100) or 'amount' (EGP).
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
    from session_items where session_id = p_session_id;
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
