-- Offline-safe close. Run after 008. Safe to re-run.
-- close_room_session gets an optional p_ended_at: a bill closed while the internet was down is
-- recorded at the time the cashier really closed it (never in the future, never before the last
-- segment started). Closing an already closed session still raises 'session not open' (conflict safety).
drop function if exists public.close_room_session(uuid, text, numeric, text, numeric);
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
