-- Staff attendance, petty expenses (tied to the shift, deducted in the shift-close cash view), salary advances.
-- Run after 013. Safe to re-run.
-- Permissions (cashier_perms keys, set in admin Settings): attendance (default ON), expense (default ON), advance (default OFF).
-- Settings (app_settings config): expense_cap = max amount a cashier can log in one expense (default 500, 0 = no cap).

-- generic audit for these features, readable by admin only
create table if not exists public.ops_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(), actor text, kind text not null, detail jsonb not null default '{}'
);
alter table public.ops_audit enable row level security;
drop policy if exists "ops_audit admin read" on public.ops_audit;
create policy "ops_audit admin read" on public.ops_audit for select to authenticated using (public.is_admin());
grant select on public.ops_audit to authenticated;
create or replace function public.ops_log(p_kind text, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into ops_audit (actor, kind, detail) values (coalesce(auth.jwt()->>'email', 'system'), p_kind, coalesce(p_detail, '{}'))
$$;
revoke all on function public.ops_log(text, jsonb) from public, anon, authenticated;

-- permission defaults: a missing key means allowed, except these
create or replace function public.staff_can(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_staff() and coalesce(
    (select (value->'cashier_perms'->>p)::boolean from app_settings where key = 'config'), not (p = any (array['advance']))))
$$;
revoke all on function public.staff_can(text) from public, anon;
grant execute on function public.staff_can(text) to authenticated;

create or replace function public.set_cashier_perms(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  foreach k in array array['start','pause','tier','vip','void','add_items','deposit','carry_over','close','shift','attendance','expense','advance'] loop
    if p ? k then clean := clean || jsonb_build_object(k, (p->>k)::boolean); end if;
  end loop;
  update app_settings set value = jsonb_set(value, '{cashier_perms}', clean, true), updated_at = now() where key = 'config';
end $$;
revoke all on function public.set_cashier_perms(jsonb) from public, anon;
grant execute on function public.set_cashier_perms(jsonb) to authenticated;

-- ---------- attendance ----------
create table if not exists public.attendance (
  id bigint generated always as identity primary key,
  staff_email text not null,
  check_in timestamptz not null default now(),
  check_out timestamptz,
  note text not null default '',
  edited_by text,
  check (check_out is null or check_out >= check_in)
);
create index if not exists attendance_email_in on public.attendance (staff_email, check_in);
alter table public.attendance enable row level security;
drop policy if exists "attendance read" on public.attendance;
create policy "attendance read" on public.attendance for select to authenticated
  using (public.is_admin() or (public.is_staff() and staff_email = auth.jwt()->>'email'));
grant select on public.attendance to authenticated;

create or replace function public.check_in() returns bigint
language plpgsql security definer set search_path = public as $$
declare me text := auth.jwt()->>'email'; nid bigint;
begin
  if not public.staff_can('attendance') then raise exception 'not authorized' using errcode = '42501'; end if;
  if exists (select 1 from attendance where staff_email = me and check_out is null) then raise exception 'already checked in'; end if;
  insert into attendance (staff_email) values (me) returning id into nid;
  perform ops_log('check_in', jsonb_build_object('id', nid));
  return nid;
end $$;
create or replace function public.check_out() returns void
language plpgsql security definer set search_path = public as $$
declare me text := auth.jwt()->>'email'; rid bigint;
begin
  if not public.staff_can('attendance') then raise exception 'not authorized' using errcode = '42501'; end if;
  update attendance set check_out = now() where staff_email = me and check_out is null returning id into rid;
  if rid is null then raise exception 'not checked in'; end if;
  perform ops_log('check_out', jsonb_build_object('id', rid));
end $$;
-- admin: fix a record or add a forgotten one (p_id null = add)
create or replace function public.attendance_set(p_id bigint, p_email text, p_in timestamptz, p_out timestamptz, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare me text := auth.jwt()->>'email';
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_id is null then
    if not exists (select 1 from staff_emails where email = p_email) then raise exception 'unknown employee'; end if;
    insert into attendance (staff_email, check_in, check_out, note, edited_by) values (p_email, p_in, p_out, coalesce(p_note, ''), me) returning id into p_id;
    perform ops_log('attendance_add', jsonb_build_object('id', p_id, 'email', p_email, 'in', p_in, 'out', p_out));
  else
    update attendance set check_in = p_in, check_out = p_out, note = coalesce(p_note, note), edited_by = me where id = p_id;
    perform ops_log('attendance_edit', jsonb_build_object('id', p_id, 'in', p_in, 'out', p_out));
  end if;
end $$;
revoke all on function public.check_in(), public.check_out(), public.attendance_set(bigint, text, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.check_in(), public.check_out(), public.attendance_set(bigint, text, timestamptz, timestamptz, text) to authenticated;

-- ---------- petty expenses ----------
create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  shift_id smallint not null references public.shifts(id),
  amount int not null check (amount > 0 and amount <= 100000),
  reason text not null check (length(btrim(reason)) between 2 and 120),
  at timestamptz not null default now(), actor text,
  voided_at timestamptz, voided_by text, void_reason text
);
create index if not exists expenses_shift on public.expenses (shift_id);
alter table public.expenses enable row level security;
drop policy if exists "expenses read" on public.expenses;
create policy "expenses read" on public.expenses for select to authenticated using (public.is_staff());
grant select on public.expenses to authenticated;

create or replace function public.log_expense(p_amount int, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare sid smallint; cap int; nid bigint;
begin
  if not public.staff_can('expense') then raise exception 'not authorized' using errcode = '42501'; end if;
  select id into sid from shifts where closed_at is null order by id desc limit 1;
  if sid is null then raise exception 'no open shift'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'bad amount'; end if;
  select coalesce((value->>'expense_cap')::int, 500) into cap from app_settings where key = 'config';
  if not public.is_admin() and cap > 0 and p_amount > cap then raise exception 'above the cashier limit of %', cap; end if;
  insert into expenses (shift_id, amount, reason, actor) values (sid, p_amount, btrim(p_reason), auth.jwt()->>'email') returning id into nid;
  perform ops_log('expense', jsonb_build_object('id', nid, 'shift', sid, 'amount', p_amount, 'reason', btrim(p_reason)));
  return nid;
end $$;
create or replace function public.void_expense(p_id bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'reason required'; end if;
  update expenses set voided_at = now(), voided_by = auth.jwt()->>'email', void_reason = btrim(p_reason) where id = p_id and voided_at is null
    and shift_id in (select id from shifts where closed_at is null);
  if not found then raise exception 'expense not found or its shift is closed'; end if;
  perform ops_log('expense_void', jsonb_build_object('id', p_id, 'reason', btrim(p_reason)));
end $$;
revoke all on function public.log_expense(int, text), public.void_expense(bigint, text) from public, anon;
grant execute on function public.log_expense(int, text), public.void_expense(bigint, text) to authenticated;

-- shift totals now include expenses and the expected cash in the drawer
create or replace function public.shift_expenses_json(p_shift_id smallint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'expenses', coalesce((select sum(amount) from expenses where shift_id = p_shift_id and voided_at is null), 0),
    'expenses_list', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'reason', reason, 'by', actor, 'at', at) order by id)
                               from expenses where shift_id = p_shift_id and voided_at is null), '[]'::jsonb))
$$;
revoke all on function public.shift_expenses_json(smallint) from public, anon;
grant execute on function public.shift_expenses_json(smallint) to authenticated;

create or replace function public.shift_totals(p_shift_id smallint)
returns jsonb language sql security definer set search_path = public as $$
  with s as (
    select jsonb_build_object(
      'sessions', count(*),
      'minutes', coalesce(sum(extract(epoch from (ended_at - started_at))/60),0)::int,
      'time_amount', coalesce(sum(time_amount),0),
      'items_amount', coalesce(sum(items_amount),0),
      'discount_amount', coalesce(sum(discount_amount),0),
      'service_amount', coalesce(sum(service_amount),0),
      'total', coalesce(sum(amount),0),
      'collected_at_close', coalesce(sum(amount - deposit_amount),0),
      'deposits_received', (select coalesce(sum(deposit_amount),0) from room_sessions where deposit_shift_id = p_shift_id)) as j
    from room_sessions where ended_at is not null and shift_id = p_shift_id)
  select s.j || public.shift_expenses_json(p_shift_id) || jsonb_build_object('expected_cash',
    (s.j->>'collected_at_close')::int + (s.j->>'deposits_received')::int - (public.shift_expenses_json(p_shift_id)->>'expenses')::int)
  from s;
$$;
revoke all on function public.shift_totals(smallint) from public, anon;
grant execute on function public.shift_totals(smallint) to authenticated;

-- ---------- salary advances ----------
create table if not exists public.advances (
  id bigint generated always as identity primary key,
  staff_email text not null,
  kind text not null default 'advance' check (kind in ('advance','repay')),
  amount int not null check (amount > 0 and amount <= 1000000),
  note text not null default '',
  at timestamptz not null default now(), actor text,
  voided_at timestamptz, void_reason text
);
create index if not exists advances_email on public.advances (staff_email, at);
alter table public.advances enable row level security;
drop policy if exists "advances read" on public.advances;
create policy "advances read" on public.advances for select to authenticated
  using (public.is_admin() or (public.is_staff() and staff_email = auth.jwt()->>'email'));
grant select on public.advances to authenticated;

create or replace function public.staff_names() returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_can('advance') then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select email from staff_emails where active order by email;
end $$;
-- advance: admin, or a cashier when the "advance" permission is on. repay (payroll deduction) is admin only.
create or replace function public.give_advance(p_email text, p_amount int, p_note text, p_kind text default 'advance') returns bigint
language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if p_kind = 'repay' then
    if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  elsif p_kind = 'advance' then
    if not public.staff_can('advance') then raise exception 'not authorized' using errcode = '42501'; end if;
  else raise exception 'bad kind'; end if;
  if not exists (select 1 from staff_emails where email = p_email) then raise exception 'unknown employee'; end if;
  insert into advances (staff_email, kind, amount, note, actor) values (p_email, p_kind, p_amount, coalesce(btrim(p_note), ''), auth.jwt()->>'email') returning id into nid;
  perform ops_log('advance_' || p_kind, jsonb_build_object('id', nid, 'email', p_email, 'amount', p_amount, 'note', coalesce(btrim(p_note), '')));
  return nid;
end $$;
create or replace function public.void_advance(p_id bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'reason required'; end if;
  update advances set voided_at = now(), void_reason = btrim(p_reason) where id = p_id and voided_at is null;
  if not found then raise exception 'not found'; end if;
  perform ops_log('advance_void', jsonb_build_object('id', p_id, 'reason', btrim(p_reason)));
end $$;
revoke all on function public.staff_names(), public.give_advance(text, int, text, text), public.void_advance(bigint, text) from public, anon;
grant execute on function public.staff_names(), public.give_advance(text, int, text, text), public.void_advance(bigint, text) to authenticated;

-- close_shift: freeze expenses into the report (shift_totals already carries expenses and expected_cash)
-- nothing to change: close_shift stores shift_totals(...) which now includes them.
