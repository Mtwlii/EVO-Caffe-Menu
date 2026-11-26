-- Mid-session VIP / فردي-زوجي change: choose between repricing the WHOLE session or only from now on.
-- Run after 010_vip.sql. Safe to re-run.
-- Setting: app_settings config -> reprice_elapsed (true by default = whole session at the new price;
-- false = new segment, earlier time keeps the old price). The mode in force is stored on each new
-- segment (reprices_prior) so a later settings change never rewrites an old decision.
alter table public.room_session_segments add column if not exists reprices_prior boolean not null default false;

create or replace function public.reprice_mode() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (value->>'reprice_elapsed')::boolean from app_settings where key = 'config'), true)
$$;

-- time cost of a session: walk segments newest to oldest; a segment is billed at the price of the
-- NEXT segment's controllers/vip when that later change repriced the past, else at its own.
create or replace function public.session_time_cost(p_sid uuid, p_until timestamptz default now())
returns numeric language plpgsql stable security definer set search_path = public as $$
declare rtype text; r record; ec smallint; ev boolean; first boolean := true; prev_rp boolean := false; cost numeric := 0; mins numeric;
begin
  select room_type into rtype from room_sessions where id = p_sid;
  for r in select * from room_session_segments where session_id = p_sid order by id desc loop
    if first then ec := r.controllers; ev := r.vip; first := false;
    elsif not prev_rp then ec := r.controllers; ev := r.vip; end if;
    mins := greatest(0, extract(epoch from (coalesce(r.ended_at, p_until) - r.started_at)) / 60.0);
    cost := cost + mins / 60.0 * coalesce((select hourly_price from room_rates
                where room_type = rtype and controllers = ec and vip = ev), 0);
    prev_rp := r.reprices_prior;
  end loop;
  return cost;
end $$;
revoke all on function public.session_time_cost(uuid, timestamptz), public.reprice_mode() from public, anon, authenticated;

create or replace function public.session_total_now(p_sid uuid) returns int
language sql stable security definer set search_path = public as $$
  select (round(public.session_time_cost(p_sid, now())) + coalesce((select sum(price * qty) from session_items where session_id = p_sid and voided_at is null), 0))::int
$$;
revoke all on function public.session_total_now(uuid) from public, anon, authenticated;

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
  t_cost := round(public.session_time_cost(p_session_id, now()))::int;
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
  t_cost := round(public.session_time_cost(p_session_id, v_end))::int;
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

create or replace function public.switch_session_controllers(p_session_id uuid, p_controllers smallint)
returns void language plpgsql security definer set search_path = public as $$
declare prev smallint; pvip boolean; tb int; ta int; rp boolean := public.reprice_mode();
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_controllers not in (2,4) then raise exception 'controllers must be 2 or 4'; end if;
  if not exists (select 1 from room_sessions where id = p_session_id and ended_at is null) then
    raise exception 'session not open'; end if;
  if exists (select 1 from room_sessions where id = p_session_id and paused_at is not null) then
    raise exception 'session is paused, resume first'; end if;
  select controllers, vip into prev, pvip from room_session_segments where session_id = p_session_id and ended_at is null;
  if prev = p_controllers then return; end if;
  tb := public.session_total_now(p_session_id);
  update room_session_segments set ended_at = now() where session_id = p_session_id and ended_at is null;
  insert into room_session_segments (session_id, controllers, vip, reprices_prior) values (p_session_id, p_controllers, coalesce(pvip, false), rp);
  ta := public.session_total_now(p_session_id);
  perform audit_log(p_session_id, 'controllers', jsonb_build_object('from', prev, 'to', p_controllers,
    'mode', case when rp then 'whole_session' else 'from_now' end, 'total_before', tb, 'total_after', ta));
end $$;

create or replace function public.set_session_vip(p_session_id uuid, p_vip boolean)
returns void language plpgsql security definer set search_path = public as $$
declare ctl smallint; pvip boolean; tb int; ta int; rp boolean := public.reprice_mode();
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from room_sessions where id = p_session_id and ended_at is null) then
    raise exception 'session not open'; end if;
  if exists (select 1 from room_sessions where id = p_session_id and paused_at is not null) then
    raise exception 'session is paused, resume first'; end if;
  select controllers, vip into ctl, pvip from room_session_segments where session_id = p_session_id and ended_at is null;
  if coalesce(pvip, false) = p_vip then return; end if;
  tb := public.session_total_now(p_session_id);
  update room_session_segments set ended_at = now() where session_id = p_session_id and ended_at is null;
  insert into room_session_segments (session_id, controllers, vip, reprices_prior) values (p_session_id, ctl, p_vip, rp);
  ta := public.session_total_now(p_session_id);
  perform audit_log(p_session_id, 'vip', jsonb_build_object('from', coalesce(pvip, false), 'to', p_vip,
    'mode', case when rp then 'whole_session' else 'from_now' end, 'total_before', tb, 'total_after', ta));
end $$;
revoke all on function public.switch_session_controllers(uuid, smallint), public.set_session_vip(uuid, boolean) from public, anon;
grant execute on function public.switch_session_controllers(uuid, smallint), public.set_session_vip(uuid, boolean) to authenticated;
