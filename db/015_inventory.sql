-- Inventory: stock items, stock moves, recipes (auto-deduct on sale, restore on void), physical count (جرد) per shift.
-- Run after 014. Safe to re-run.
-- Permissions (cashier_perms keys): stock_move (stock in/out/waste, default ON), stock_count (physical count, default ON).
-- Sales deduct when an item lands on a room session bill (manual add or app order attached to a room); void restores.
create table if not exists public.stock_items (
  id bigint generated always as identity primary key,
  name text not null unique check (length(btrim(name)) between 1 and 80),
  unit text not null default 'قطعة' check (length(unit) between 1 and 20),
  qty numeric(12,3) not null default 0,
  min_level numeric(12,3) not null default 0 check (min_level >= 0),
  active boolean not null default true
);
create table if not exists public.stock_moves (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  item_id bigint not null references public.stock_items(id) on delete cascade,
  delta numeric(12,3) not null,
  kind text not null check (kind in ('in','out','waste','sale','void_restore','count','adjust')),
  ref text, note text not null default '', actor text
);
create index if not exists stock_moves_item on public.stock_moves (item_id, at);
create table if not exists public.recipes (
  id bigint generated always as identity primary key,
  menu_name text not null check (length(btrim(menu_name)) between 1 and 60),
  item_id bigint not null references public.stock_items(id) on delete cascade,
  qty numeric(12,3) not null check (qty > 0 and qty <= 100000),
  unique (menu_name, item_id)
);
create table if not exists public.stock_counts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(), shift_id smallint,
  item_id bigint not null references public.stock_items(id) on delete cascade,
  expected numeric(12,3) not null, actual numeric(12,3) not null, diff numeric(12,3) not null,
  actor text, note text not null default ''
);
alter table public.stock_items enable row level security;
alter table public.stock_moves enable row level security;
alter table public.recipes enable row level security;
alter table public.stock_counts enable row level security;
drop policy if exists "stock_items read" on public.stock_items;
drop policy if exists "stock_moves read" on public.stock_moves;
drop policy if exists "recipes read" on public.recipes;
drop policy if exists "stock_counts read" on public.stock_counts;
create policy "stock_items read" on public.stock_items for select to authenticated using (public.is_staff());
create policy "stock_moves read" on public.stock_moves for select to authenticated using (public.is_admin());
create policy "recipes read" on public.recipes for select to authenticated using (public.is_admin());
create policy "stock_counts read" on public.stock_counts for select to authenticated using (public.is_admin());
grant select on public.stock_items, public.stock_moves, public.recipes, public.stock_counts to authenticated;

-- permission keys
create or replace function public.staff_can(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_staff() and coalesce(
    (select (value->'cashier_perms'->>p)::boolean from app_settings where key = 'config'), not (p = any (array['advance']))))
$$;
create or replace function public.set_cashier_perms(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  foreach k in array array['start','pause','tier','vip','void','add_items','deposit','carry_over','close','shift','attendance','expense','advance','stock_move','stock_count'] loop
    if p ? k then clean := clean || jsonb_build_object(k, (p->>k)::boolean); end if;
  end loop;
  update app_settings set value = jsonb_set(value, '{cashier_perms}', clean, true), updated_at = now() where key = 'config';
end $$;

-- internal mover: changes qty and writes the move
create or replace function public._stock_apply(p_item bigint, p_delta numeric, p_kind text, p_ref text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update stock_items set qty = qty + p_delta where id = p_item;
  insert into stock_moves (item_id, delta, kind, ref, note, actor)
    values (p_item, p_delta, p_kind, p_ref, coalesce(p_note, ''), coalesce(auth.jwt()->>'email', 'system'));
end $$;
revoke all on function public._stock_apply(bigint, numeric, text, text, text) from public, anon, authenticated;

-- auto deduct on sale, restore on void
create or replace function public.trg_stock_sale() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    if NEW.voided_at is null then
      for r in select item_id, qty from recipes where menu_name = NEW.name loop
        perform _stock_apply(r.item_id, -(r.qty * NEW.qty), 'sale', 'item:' || NEW.id, NEW.name);
      end loop;
    end if;
  elsif OLD.voided_at is null and NEW.voided_at is not null then
    for r in select item_id, delta from stock_moves where ref = 'item:' || NEW.id and kind = 'sale' loop
      perform _stock_apply(r.item_id, -r.delta, 'void_restore', 'item:' || NEW.id, NEW.name);
    end loop;
  end if;
  return NEW;
end $$;
drop trigger if exists stock_sale on public.session_items;
create trigger stock_sale after insert or update of voided_at on public.session_items
  for each row execute function public.trg_stock_sale();

-- admin: items
create or replace function public.stock_item_save(p_id bigint, p_name text, p_unit text, p_min numeric, p_active boolean default true) returns bigint
language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_id is null then
    insert into stock_items (name, unit, min_level) values (btrim(p_name), coalesce(nullif(btrim(p_unit), ''), 'قطعة'), greatest(coalesce(p_min, 0), 0)) returning id into nid;
  else
    update stock_items set name = btrim(p_name), unit = coalesce(nullif(btrim(p_unit), ''), unit), min_level = greatest(coalesce(p_min, 0), 0), active = coalesce(p_active, true) where id = p_id returning id into nid;
    if nid is null then raise exception 'not found'; end if;
  end if;
  perform ops_log('stock_item', jsonb_build_object('id', nid, 'name', btrim(p_name), 'min', p_min, 'active', p_active));
  return nid;
end $$;
create or replace function public.recipe_set(p_menu_name text, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare l jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_menu_name, ''))) < 1 then raise exception 'name required'; end if;
  delete from recipes where menu_name = btrim(p_menu_name);
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into recipes (menu_name, item_id, qty) values (btrim(p_menu_name), (l->>'item_id')::bigint, (l->>'qty')::numeric);
  end loop;
  perform ops_log('recipe_set', jsonb_build_object('menu', btrim(p_menu_name), 'lines', coalesce(p_lines, '[]'::jsonb)));
end $$;

-- stock in / out / waste (cashier needs stock_move permission)
create or replace function public.stock_move(p_item bigint, p_qty numeric, p_kind text, p_note text) returns numeric
language plpgsql security definer set search_path = public as $$
declare d numeric; q numeric;
begin
  if not public.staff_can('stock_move') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_kind not in ('in','out','waste') then raise exception 'bad kind'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000 then raise exception 'bad quantity'; end if;
  if p_kind <> 'in' and length(btrim(coalesce(p_note, ''))) < 2 then raise exception 'reason required'; end if;
  if not exists (select 1 from stock_items where id = p_item and active) then raise exception 'unknown item'; end if;
  d := case when p_kind = 'in' then p_qty else -p_qty end;
  perform _stock_apply(p_item, d, p_kind, null, btrim(coalesce(p_note, '')));
  select qty into q from stock_items where id = p_item;
  return q;
end $$;

-- physical count: p_counts = [{item_id, actual}], tied to the open shift; stock is set to the counted quantity
create or replace function public.stock_count(p_counts jsonb, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; sid smallint; e numeric; a numeric; out jsonb := '[]'::jsonb;
begin
  if not public.staff_can('stock_count') then raise exception 'not authorized' using errcode = '42501'; end if;
  select id into sid from shifts where closed_at is null order by id desc limit 1;
  if sid is null then raise exception 'no open shift'; end if;
  for c in select * from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) loop
    a := (c->>'actual')::numeric;
    if a is null or a < 0 or a > 1000000 then raise exception 'bad quantity'; end if;
    select qty into e from stock_items where id = (c->>'item_id')::bigint and active for update;
    if e is null then raise exception 'unknown item'; end if;
    insert into stock_counts (shift_id, item_id, expected, actual, diff, actor, note)
      values (sid, (c->>'item_id')::bigint, e, a, a - e, auth.jwt()->>'email', coalesce(btrim(p_note), ''));
    if a <> e then perform _stock_apply((c->>'item_id')::bigint, a - e, 'count', 'shift:' || sid, coalesce(btrim(p_note), '')); end if;
    out := out || jsonb_build_object('item_id', (c->>'item_id')::bigint, 'expected', e, 'actual', a, 'diff', a - e);
  end loop;
  perform ops_log('stock_count', jsonb_build_object('shift', sid, 'lines', out));
  return out;
end $$;
revoke all on function public.stock_item_save(bigint, text, text, numeric, boolean), public.recipe_set(text, jsonb), public.stock_move(bigint, numeric, text, text), public.stock_count(jsonb, text) from public, anon;
grant execute on function public.stock_item_save(bigint, text, text, numeric, boolean), public.recipe_set(text, jsonb), public.stock_move(bigint, numeric, text, text), public.stock_count(jsonb, text) to authenticated;

-- shift report: counts done in the shift
create or replace function public.shift_stock_json(p_shift_id smallint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('stock_counts', coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'unit', i.unit, 'expected', c.expected, 'actual', c.actual, 'diff', c.diff) order by c.id)
    from stock_counts c join stock_items i on i.id = c.item_id where c.shift_id = p_shift_id), '[]'::jsonb))
$$;
revoke all on function public.shift_stock_json(smallint) from public, anon;
grant execute on function public.shift_stock_json(smallint) to authenticated;
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
  select s.j || public.shift_expenses_json(p_shift_id) || public.shift_stock_json(p_shift_id) || jsonb_build_object('expected_cash',
    (s.j->>'collected_at_close')::int + (s.j->>'deposits_received')::int - (public.shift_expenses_json(p_shift_id)->>'expenses')::int)
  from s;
$$;
revoke all on function public.shift_totals(smallint) from public, anon;
grant execute on function public.shift_totals(smallint) to authenticated;

-- tables are read-only for clients; all writes go through the functions above
revoke insert, update, delete, truncate on public.stock_items, public.stock_moves, public.recipes, public.stock_counts from anon, authenticated;
