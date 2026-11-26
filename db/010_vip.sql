-- VIP pricing + tier names. Run after 009_offline_close.sql. Safe to re-run.
-- A segment (stretch of time with one controller count) now also carries a vip flag, and
-- rates are keyed (room type, controllers, vip). Ticking VIP during a session closes the running
-- segment and opens a new one, so earlier time keeps the old price. Every change is audited.
alter table public.room_rates add column if not exists vip boolean not null default false;
alter table public.room_session_segments add column if not exists vip boolean not null default false;
alter table public.rooms add column if not exists vip boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.room_rates'::regclass and contype = 'p'
                   and pg_get_constraintdef(oid) ilike '%vip%') then
    alter table public.room_rates drop constraint room_rates_pkey;
    alter table public.room_rates add primary key (room_type, controllers, vip);
  end if;
end $$;
-- seed VIP prices = standard prices (nothing changes until the admin edits them)
insert into public.room_rates (room_type, controllers, hourly_price, vip)
  select room_type, controllers, hourly_price, true from public.room_rates where not vip
on conflict do nothing;

create or replace function public.start_room_session(p_room_id smallint, p_controllers smallint)
returns uuid language plpgsql security definer set search_path = public as $$
declare sid uuid; rtype text; rvip boolean;
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_controllers not in (2,4) then raise exception 'controllers must be 2 or 4'; end if;
  if exists (select 1 from room_sessions where room_id = p_room_id and ended_at is null) then
    raise exception 'room already has an open session'; end if;
  select room_type, vip into rtype, rvip from rooms where id = p_room_id and active;
  if rtype is null then raise exception 'room not found'; end if;
  insert into room_sessions (room_id, room_type) values (p_room_id, rtype) returning id into sid;
  insert into room_session_segments (session_id, controllers, vip) values (sid, p_controllers, coalesce(rvip, false));
  return sid;
end $$;

create or replace function public.switch_session_controllers(p_session_id uuid, p_controllers smallint)
returns void language plpgsql security definer set search_path = public as $$
declare prev smallint; pvip boolean;
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_controllers not in (2,4) then raise exception 'controllers must be 2 or 4'; end if;
  if not exists (select 1 from room_sessions where id = p_session_id and ended_at is null) then
    raise exception 'session not open'; end if;
  if exists (select 1 from room_sessions where id = p_session_id and paused_at is not null) then
    raise exception 'session is paused, resume first'; end if;
  select controllers, vip into prev, pvip from room_session_segments where session_id = p_session_id and ended_at is null;
  update room_session_segments set ended_at = now() where session_id = p_session_id and ended_at is null;
  insert into room_session_segments (session_id, controllers, vip) values (p_session_id, p_controllers, coalesce(pvip, false));
  perform audit_log(p_session_id, 'controllers', jsonb_build_object('from', prev, 'to', p_controllers));
end $$;

create or replace function public.resume_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare ctl smallint; pvip boolean;
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  update room_sessions set paused_at = null
   where id = p_session_id and ended_at is null and paused_at is not null;
  if not found then raise exception 'session not paused'; end if;
  select controllers, vip into ctl, pvip from room_session_segments
   where session_id = p_session_id order by id desc limit 1;
  insert into room_session_segments (session_id, controllers, vip) values (p_session_id, coalesce(ctl, 2), coalesce(pvip, false));
end $$;

-- tick / untick VIP during a running session: the price changes from this moment
create or replace function public.set_session_vip(p_session_id uuid, p_vip boolean)
returns void language plpgsql security definer set search_path = public as $$
declare ctl smallint; pvip boolean;
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from room_sessions where id = p_session_id and ended_at is null) then
    raise exception 'session not open'; end if;
  if exists (select 1 from room_sessions where id = p_session_id and paused_at is not null) then
    raise exception 'session is paused, resume first'; end if;
  select controllers, vip into ctl, pvip from room_session_segments where session_id = p_session_id and ended_at is null;
  if pvip is not distinct from p_vip then return; end if;
  update room_session_segments set ended_at = now() where session_id = p_session_id and ended_at is null;
  insert into room_session_segments (session_id, controllers, vip) values (p_session_id, ctl, p_vip);
  perform audit_log(p_session_id, 'vip', jsonb_build_object('from', coalesce(pvip, false), 'to', p_vip));
end $$;

-- the VIP default of an idle room (used when the next session starts)
create or replace function public.set_room_vip(p_room_id smallint, p_vip boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  if exists (select 1 from room_sessions where room_id = p_room_id and ended_at is null) then
    raise exception 'room has a running session'; end if;
  update rooms set vip = p_vip where id = p_room_id;
end $$;

create or replace function public.session_accrual(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rtype text; rname text; t_cost int; i_cost int; mins int; started timestamptz; ctl int;
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
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
                        where room_type = rtype and controllers = g.controllers and vip = g.vip), 0)
         )), 0)::int into t_cost
    from room_session_segments g where g.session_id = p_session_id;
  select coalesce(sum(price * qty), 0)::int into i_cost
    from session_items where session_id = p_session_id and voided_at is null;
  return jsonb_build_object('room', rname, 'started_at', started, 'controllers', ctl,
    'minutes', mins, 'time_amount', t_cost, 'items_amount', i_cost, 'subtotal', t_cost + i_cost);
end $$;
revoke all on function public.session_accrual(uuid) from public, anon;
grant execute on function public.session_accrual(uuid) to authenticated;

drop function if exists public.close_room_session(uuid, text, numeric, text, numeric, timestamptz);
create or replace function public.close_room_session(
  p_session_id uuid,
  p_discount_kind text default null, p_discount_value numeric default 0,
  p_service_kind text default null, p_service_value numeric default 0,
  p_ended_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_end timestamptz; t_cost int; i_cost int; mins int; rtype text; disc int; serv int; base int;
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- offline close: the cashier's laptop supplies the real close time; clamp it to [session start, now]
  v_end := least(now(), greatest(coalesce(p_ended_at, now()),
             coalesce((select max(started_at) from room_session_segments where session_id = p_session_id), now())));
  update room_session_segments set ended_at = v_end
    where session_id = p_session_id and ended_at is null;
  select room_type into rtype from room_sessions where id = p_session_id and ended_at is null;
  if rtype is null then raise exception 'session not open'; end if;
  select coalesce(sum(extract(epoch from (ended_at - started_at)) / 60), 0)::int into mins
    from room_session_segments where session_id = p_session_id;
  select coalesce(round(sum(
           extract(epoch from (g.ended_at - g.started_at)) / 60.0 / 60.0
           * coalesce((select hourly_price from room_rates
                        where room_type = rtype and controllers = g.controllers and vip = g.vip), 0)
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
     set ended_at = v_end, time_amount = t_cost, items_amount = i_cost,
         discount_amount = disc, service_amount = serv, amount = base - disc + serv,
         shift_id = (select id from shifts where closed_at is null order by id desc limit 1)
   where id = p_session_id;
  return jsonb_build_object('minutes', mins, 'time_amount', t_cost, 'items_amount', i_cost,
    'discount_amount', disc, 'service_amount', serv, 'total', base - disc + serv,
    'deposit', (select deposit_amount from room_sessions where id = p_session_id),
    'remaining', base - disc + serv - (select deposit_amount from room_sessions where id = p_session_id));
end $$;

revoke all on function public.close_room_session(uuid, text, numeric, text, numeric, timestamptz) from public, anon;
grant execute on function public.close_room_session(uuid, text, numeric, text, numeric, timestamptz) to authenticated;
revoke all on function public.start_room_session(smallint, smallint), public.switch_session_controllers(uuid, smallint),
  public.resume_session(uuid), public.set_session_vip(uuid, boolean), public.set_room_vip(smallint, boolean) from public, anon;
grant execute on function public.start_room_session(smallint, smallint), public.switch_session_controllers(uuid, smallint),
  public.resume_session(uuid), public.set_session_vip(uuid, boolean), public.set_room_vip(smallint, boolean) to authenticated;
