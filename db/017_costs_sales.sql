-- Costs and profit, recipes by menu item id, takeaway/table/app-order sales, blind stock count,
-- timezone + business-day setting, offline-safe operations (idempotent adds/voids/expenses), dashboard, full export.
-- Run after 016. Safe to re-run.
-- Settings (app_settings config): tz (IANA name, default Africa/Cairo), day_start_hour (0-12, default 6: a sale at 02:00 belongs to the previous business day).
-- Permission key added: sale (takeaway/table sale, default ON).

create or replace function public.biz_tz() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select value->>'tz' from app_settings where key = 'config' and exists (select 1 from pg_timezone_names z where z.name = value->>'tz')), 'Africa/Cairo')
$$;
create or replace function public.biz_day_start() returns int language sql stable security definer set search_path = public as $$
  select least(greatest(coalesce((select (value->>'day_start_hour')::int from app_settings where key = 'config'), 6), 0), 12)
$$;
create or replace function public.biz_day(ts timestamptz) returns date language sql stable security definer set search_path = public as $$
  select ((ts at time zone public.biz_tz()) - make_interval(hours => public.biz_day_start()))::date
$$;
revoke all on function public.biz_tz(), public.biz_day_start(), public.biz_day(timestamptz) from public, anon;
grant execute on function public.biz_tz(), public.biz_day_start(), public.biz_day(timestamptz) to authenticated;

-- ---------- costs ----------
alter table public.stock_items add column if not exists cost numeric(12,4) not null default 0 check (cost >= 0);
create table if not exists public.menu_costs (            -- fallback cost for menu items WITHOUT a recipe (admin only, never public)
  menu_item_id bigint primary key references public.menu_items(id) on delete cascade,
  cost numeric(10,2) not null default 0 check (cost >= 0)
);
alter table public.menu_costs enable row level security;
drop policy if exists "menu_costs admin" on public.menu_costs;
create policy "menu_costs admin" on public.menu_costs for select to authenticated using (public.is_admin());
grant select on public.menu_costs to authenticated;
revoke insert, update, delete, truncate on public.menu_costs from anon, authenticated;
create or replace function public.menu_cost_set(p_menu_item_id bigint, p_cost numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_cost is null or p_cost < 0 or p_cost > 100000 then raise exception 'bad cost'; end if;
  insert into menu_costs (menu_item_id, cost) values (p_menu_item_id, p_cost)
    on conflict (menu_item_id) do update set cost = excluded.cost;
  perform ops_log('menu_cost', jsonb_build_object('menu_item_id', p_menu_item_id, 'cost', p_cost));
end $$;

-- ---------- recipes by menu item id (+ optional size) ----------
alter table public.recipes add column if not exists menu_item_id bigint references public.menu_items(id) on delete cascade;
alter table public.recipes add column if not exists size_idx smallint check (size_idx is null or size_idx between 1 and 4);
alter table public.recipes alter column menu_name drop not null;
alter table public.recipes drop constraint if exists recipes_menu_name_item_id_key;
-- bill name -> menu item (+ size). "Name" matches the item; "Name (2)" matches size 2 of a multi-price item.
create or replace function public.resolve_menu(p_name text) returns table (menu_item_id bigint, size_idx smallint)
language sql stable security definer set search_path = public as $$
  select x.id, x.s from (
    select m.id, null::smallint as s, 0 as pr from menu_items m where m.name = p_name
    union all
    select m.id, g::smallint, 1 from menu_items m, generate_series(1, cardinality(m.prices)) g
      where cardinality(m.prices) > 1 and p_name = m.name || ' (' || g || ')'
  ) x order by x.pr, x.id limit 1
$$;
revoke all on function public.resolve_menu(text) from public, anon, authenticated;
update public.recipes r set menu_item_id = (select menu_item_id from public.resolve_menu(r.menu_name)) where r.menu_item_id is null and r.menu_name is not null;
delete from public.recipes where menu_item_id is null;
create unique index if not exists recipes_uni on public.recipes (menu_item_id, coalesce(size_idx, 0), item_id);

drop function if exists public.recipe_set(text, jsonb);
create or replace function public.recipe_set(p_menu_item_id bigint, p_size smallint, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare l jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from menu_items where id = p_menu_item_id) then raise exception 'unknown menu item'; end if;
  delete from recipes where menu_item_id = p_menu_item_id and coalesce(size_idx, 0) = coalesce(p_size, 0);
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into recipes (menu_item_id, size_idx, item_id, qty) values (p_menu_item_id, p_size, (l->>'item_id')::bigint, (l->>'qty')::numeric);
  end loop;
  perform ops_log('recipe_set', jsonb_build_object('menu_item_id', p_menu_item_id, 'size', p_size, 'lines', coalesce(p_lines, '[]'::jsonb)));
end $$;

-- cost of a sold line: recipe cost when a recipe exists, else the menu cost
create or replace function public.line_cost(p_menu_item_id bigint, p_size smallint, p_qty int) returns numeric
language sql stable security definer set search_path = public as $$
  select round(case when exists (select 1 from recipes r join stock_items si on si.id = r.item_id and si.active
                                  where r.menu_item_id = p_menu_item_id and (r.size_idx is null or r.size_idx = p_size))
    then (select sum(r.qty * si.cost) from recipes r join stock_items si on si.id = r.item_id and si.active
           where r.menu_item_id = p_menu_item_id and (r.size_idx is null or r.size_idx = p_size))
    else coalesce((select cost from menu_costs where menu_item_id = p_menu_item_id), 0) end * p_qty, 2)
$$;
revoke all on function public.line_cost(bigint, smallint, int) from public, anon, authenticated;

-- ---------- session items: menu link, cost snapshot, idempotency key ----------
alter table public.session_items add column if not exists menu_item_id bigint;
alter table public.session_items add column if not exists size_idx smallint;
alter table public.session_items add column if not exists cost numeric(12,2) not null default 0;
alter table public.session_items add column if not exists op_id uuid;
create unique index if not exists session_items_op on public.session_items (op_id) where op_id is not null;

create or replace function public.trg_item_meta() returns trigger
language plpgsql security definer set search_path = public as $$
declare rm record;
begin
  if NEW.menu_item_id is null then
    select * into rm from resolve_menu(NEW.name);
    if rm.menu_item_id is not null then NEW.menu_item_id := rm.menu_item_id; NEW.size_idx := rm.size_idx; end if;
  end if;
  NEW.cost := case when NEW.menu_item_id is null then 0 else line_cost(NEW.menu_item_id, NEW.size_idx, NEW.qty) end;
  return NEW;
end $$;
drop trigger if exists item_meta on public.session_items;
create trigger item_meta before insert on public.session_items for each row execute function public.trg_item_meta();

create or replace function public.trg_stock_sale() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    if NEW.voided_at is null and NEW.menu_item_id is not null then
      for r in select rc.item_id, rc.qty from recipes rc join stock_items si on si.id = rc.item_id and si.active
                where rc.menu_item_id = NEW.menu_item_id and (rc.size_idx is null or rc.size_idx = NEW.size_idx) loop
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

-- ---------- takeaway / table / app-order sales (no room) ----------
create table if not exists public.sales (
  id bigint generated always as identity primary key,
  shift_id smallint references public.shifts(id),
  at timestamptz not null default now(), actor text,
  kind text not null default 'takeaway' check (kind in ('takeaway','table','order')),
  label text not null default '',
  discount_amount int not null default 0, total int not null check (total >= 0),
  note text not null default '',
  order_id uuid unique, op_id uuid unique,
  voided_at timestamptz, voided_by text, void_reason text
);
create index if not exists sales_shift on public.sales (shift_id);
create index if not exists sales_at on public.sales (at);
create table if not exists public.sale_items (
  id bigint generated always as identity primary key,
  sale_id bigint not null references public.sales(id) on delete cascade,
  name text not null, menu_item_id bigint, size_idx smallint,
  price int not null check (price between 0 and 2000), qty int not null check (qty between 1 and 100),
  cost numeric(12,2) not null default 0
);
create index if not exists sale_items_sale on public.sale_items (sale_id);
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
drop policy if exists "sales read" on public.sales;
drop policy if exists "sale_items read" on public.sale_items;
create policy "sales read" on public.sales for select to authenticated using (public.is_staff());
create policy "sale_items read" on public.sale_items for select to authenticated using (public.is_staff());
grant select on public.sales, public.sale_items to authenticated;
revoke insert, update, delete, truncate on public.sales, public.sale_items from anon, authenticated;

create or replace function public.trg_sale_item_meta() returns trigger
language plpgsql security definer set search_path = public as $$
declare rm record;
begin
  if NEW.menu_item_id is null then
    select * into rm from resolve_menu(NEW.name);
    if rm.menu_item_id is not null then NEW.menu_item_id := rm.menu_item_id; NEW.size_idx := rm.size_idx; end if;
  end if;
  NEW.cost := case when NEW.menu_item_id is null then 0 else line_cost(NEW.menu_item_id, NEW.size_idx, NEW.qty) end;
  return NEW;
end $$;
drop trigger if exists sale_item_meta on public.sale_items;
create trigger sale_item_meta before insert on public.sale_items for each row execute function public.trg_sale_item_meta();
create or replace function public.trg_sale_item_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if NEW.menu_item_id is not null then
    for r in select rc.item_id, rc.qty from recipes rc join stock_items si on si.id = rc.item_id and si.active
              where rc.menu_item_id = NEW.menu_item_id and (rc.size_idx is null or rc.size_idx = NEW.size_idx) loop
      perform _stock_apply(r.item_id, -(r.qty * NEW.qty), 'sale', 'sale:' || NEW.id, NEW.name);
    end loop;
  end if;
  return NEW;
end $$;
drop trigger if exists sale_item_stock on public.sale_items;
create trigger sale_item_stock after insert on public.sale_items for each row execute function public.trg_sale_item_stock();

create or replace function public.create_sale(p_op uuid, p_kind text, p_label text, p_items jsonb, p_disc_kind text, p_disc_val numeric, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare sid smallint; nid bigint; it jsonb; n int; base int := 0; disc int := 0; m record; nm text; pr int; q int; sz smallint;
begin
  if not public.staff_can('sale') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_op is not null then select id into nid from sales where op_id = p_op; if nid is not null then return nid; end if; end if;
  if p_kind not in ('takeaway','table') then raise exception 'bad kind'; end if;
  select id into sid from shifts where closed_at is null order by id desc limit 1;
  if sid is null then raise exception 'no open shift'; end if;
  select count(*) into n from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));
  if n < 1 or n > 40 then raise exception 'items 1 to 40'; end if;
  insert into sales (shift_id, actor, kind, label, total, note, op_id)
    values (sid, auth.jwt()->>'email', p_kind, left(btrim(coalesce(p_label, '')), 40), 0, left(btrim(coalesce(p_note, '')), 120), p_op) returning id into nid;
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int; if q is null or q < 1 or q > 50 then raise exception 'bad quantity'; end if;
    if it ? 'menu_item_id' and (it->>'menu_item_id') is not null then
      select * into m from menu_items where id = (it->>'menu_item_id')::bigint;
      if m.id is null or m.hidden or cardinality(m.prices) = 0 then raise exception 'unknown menu item'; end if;
      sz := nullif(it->>'size_idx', '')::smallint;
      if sz is null and cardinality(m.prices) > 1 then raise exception 'size required'; end if;
      if sz is not null and (sz < 1 or sz > cardinality(m.prices)) then raise exception 'bad size'; end if;
      nm := m.name || case when cardinality(m.prices) > 1 then ' (' || sz || ')' else '' end;
      pr := m.prices[coalesce(sz, 1)];
      insert into sale_items (sale_id, name, menu_item_id, size_idx, price, qty) values (nid, left(nm, 60), m.id, sz, pr, q);
    else
      if not public.staff_can('add_items') then raise exception 'not authorized' using errcode = '42501'; end if;
      nm := left(btrim(coalesce(it->>'name', '')), 60); pr := (it->>'price')::int;
      if length(nm) < 1 or pr is null or pr < 0 or pr > 2000 then raise exception 'bad custom item'; end if;
      insert into sale_items (sale_id, name, price, qty) values (nid, nm, pr, q);
    end if;
    base := base + pr * q;
  end loop;
  disc := case when p_disc_kind = 'percent' then round(base * least(greatest(coalesce(p_disc_val, 0), 0), 100) / 100.0)
               when p_disc_kind = 'amount' then least(greatest(coalesce(p_disc_val, 0), 0), base) else 0 end;
  update sales set total = base - disc, discount_amount = disc where id = nid;
  perform ops_log('sale', jsonb_build_object('id', nid, 'shift', sid, 'total', base - disc, 'kind', p_kind));
  return nid;
end $$;

create or replace function public.void_sale(p_op uuid, p_id bigint, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare s record; r record;
begin
  if not public.staff_can('void') then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'reason required'; end if;
  select * into s from sales where id = p_id for update;
  if s.id is null then raise exception 'sale not found'; end if;
  if s.voided_at is not null then return 'already'; end if;
  if not public.is_admin() and s.shift_id is distinct from (select id from shifts where closed_at is null order by id desc limit 1) then
    raise exception 'sale belongs to a closed shift'; end if;
  update sales set voided_at = now(), voided_by = auth.jwt()->>'email', void_reason = left(btrim(p_reason), 120) where id = p_id;
  for r in select item_id, delta from stock_moves m where kind = 'sale' and ref in (select 'sale:' || id from sale_items where sale_id = p_id) loop
    perform _stock_apply(r.item_id, -r.delta, 'void_restore', 'sale:' || p_id, 'void sale ' || p_id);
  end loop;
  perform ops_log('sale_void', jsonb_build_object('id', p_id, 'reason', btrim(p_reason)));
  return 'ok';
end $$;

-- app orders that were not attached to a room count as a sale when staff accept them (assumed paid at the counter)
create or replace function public._order_to_sale(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o record; sid smallint; nid bigint; it jsonb; tot int := 0; pr int; q int; nm text;
begin
  if exists (select 1 from sales where order_id = p_id) or exists (select 1 from session_items where order_id = p_id) then return; end if;
  select * into o from orders where id = p_id;
  if o.id is null or jsonb_typeof(o.summary->'items') <> 'array' then return; end if;
  select id into sid from shifts where closed_at is null order by id desc limit 1;
  insert into sales (shift_id, actor, kind, label, total, order_id, note)
    values (sid, 'app', 'order', left(coalesce(o.summary->>'type', '') || ' ' || coalesce(o.summary->>'num', ''), 40), 0, p_id, left(coalesce(o.summary->>'who', ''), 120)) returning id into nid;
  for it in select * from jsonb_array_elements(o.summary->'items') loop
    nm := left(coalesce(it->>'name', ''), 60); pr := least(greatest(coalesce((it->>'price')::int, 0), 0), 2000); q := least(greatest(coalesce((it->>'qty')::int, 1), 1), 50);
    if length(nm) > 0 then insert into sale_items (sale_id, name, price, qty) values (nid, nm, pr, q); tot := tot + pr * q; end if;
  end loop;
  update sales set total = tot where id = nid;
end $$;
revoke all on function public._order_to_sale(uuid) from public, anon, authenticated;
create or replace function public.set_order_status(p_id uuid, p_edit_key text, p_status text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('accepted','preparing','ready') then return false; end if;
  update public.orders set status = p_status where id = p_id and edit_key = p_edit_key;
  if not found then return false; end if;
  perform public._order_to_sale(p_id);
  return true;
end $$;
revoke all on function public.set_order_status(uuid, text, text) from public;
grant execute on function public.set_order_status(uuid, text, text) to anon, authenticated;

-- ---------- permission keys ----------
create or replace function public.set_cashier_perms(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  foreach k in array array['start','pause','tier','vip','void','add_items','deposit','carry_over','close','shift','attendance','expense','advance','stock_move','stock_count','sale'] loop
    if p ? k then clean := clean || jsonb_build_object(k, (p->>k)::boolean); end if;
  end loop;
  update app_settings set value = jsonb_set(value, '{cashier_perms}', clean, true), updated_at = now() where key = 'config';
end $$;

-- ---------- blind stock count: cashiers never see quantities ----------
drop policy if exists "stock_items read" on public.stock_items;
create policy "stock_items read" on public.stock_items for select to authenticated using (public.is_admin());
create or replace function public.stock_list() returns table (id bigint, name text, unit text, qty numeric, min_level numeric, cost numeric, active boolean, low boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select s.id, s.name, s.unit,
    case when public.is_admin() then s.qty end, case when public.is_admin() then s.min_level end, case when public.is_admin() then s.cost end,
    s.active, (s.min_level > 0 and s.qty <= s.min_level) from stock_items s order by s.name;
end $$;
revoke all on function public.stock_list() from public, anon;
grant execute on function public.stock_list() to authenticated;

create or replace function public.stock_item_save(p_id bigint, p_name text, p_unit text, p_min numeric, p_active boolean default true, p_cost numeric default 0) returns bigint
language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_cost is null or p_cost < 0 or p_cost > 1000000 then raise exception 'bad cost'; end if;
  if p_id is null then
    insert into stock_items (name, unit, min_level, cost) values (btrim(p_name), coalesce(nullif(btrim(p_unit), ''), 'قطعة'), greatest(coalesce(p_min, 0), 0), p_cost) returning id into nid;
  else
    update stock_items set name = btrim(p_name), unit = coalesce(nullif(btrim(p_unit), ''), unit), min_level = greatest(coalesce(p_min, 0), 0), active = coalesce(p_active, true), cost = p_cost where id = p_id returning id into nid;
    if nid is null then raise exception 'not found'; end if;
  end if;
  perform ops_log('stock_item', jsonb_build_object('id', nid, 'name', btrim(p_name), 'min', p_min, 'active', p_active, 'cost', p_cost));
  return nid;
end $$;
drop function if exists public.stock_item_save(bigint, text, text, numeric, boolean);

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
  if not public.is_admin() then return null; end if;
  select qty into q from stock_items where id = p_item;
  return q;
end $$;

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
    if public.is_admin() then out := out || jsonb_build_object('item_id', (c->>'item_id')::bigint, 'expected', e, 'actual', a, 'diff', a - e);
    else out := out || jsonb_build_object('item_id', (c->>'item_id')::bigint, 'saved', true); end if;
  end loop;
  perform ops_log('stock_count', jsonb_build_object('shift', sid, 'lines', jsonb_array_length(out)));
  return out;
end $$;

create or replace function public.shift_stock_json(p_shift_id smallint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('stock_counts', case when public.is_admin() then coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'unit', i.unit, 'expected', c.expected, 'actual', c.actual, 'diff', c.diff) order by c.id)
    from stock_counts c join stock_items i on i.id = c.item_id where c.shift_id = p_shift_id), '[]'::jsonb) else '[]'::jsonb end)
$$;

-- ---------- shift totals with sales ----------
create or replace function public.shift_sales_json(p_shift_id smallint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('sales_total', coalesce(sum(total), 0), 'sales_count', count(*),
    'sales_order_total', coalesce(sum(total) filter (where kind = 'order'), 0))
  from sales where shift_id = p_shift_id and voided_at is null
$$;
revoke all on function public.shift_sales_json(smallint) from public, anon;
grant execute on function public.shift_sales_json(smallint) to authenticated;
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
  select s.j || public.shift_expenses_json(p_shift_id) || public.shift_sales_json(p_shift_id) || public.shift_stock_json(p_shift_id) || jsonb_build_object('expected_cash',
    (s.j->>'collected_at_close')::int + (s.j->>'deposits_received')::int + (public.shift_sales_json(p_shift_id)->>'sales_total')::int - (public.shift_expenses_json(p_shift_id)->>'expenses')::int)
  from s;
$$;
revoke all on function public.shift_totals(smallint) from public, anon;
grant execute on function public.shift_totals(smallint) to authenticated;

create or replace function public.close_shift()
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid smallint; rep jsonb; carry jsonb; pending int;
begin
  if not public.staff_can('shift') then raise exception 'not authorized' using errcode = '42501'; end if;
  select id into sid from shifts where closed_at is null order by id desc limit 1;
  if sid is null then raise exception 'no open shift'; end if;
  select count(*) into pending from room_sessions where ended_at is null and not carried_over;
  if pending > 0 then raise exception 'there are % open session(s) not closed and not carried over', pending; end if;
  select coalesce(jsonb_agg(session_accrual(s.id)), '[]'::jsonb) into carry from room_sessions s where s.ended_at is null;
  rep := (shift_totals(sid) - 'stock_counts') || jsonb_build_object('handed_over', carry);   -- stock counts stay admin-only
  update shifts set closed_at = now(), report = rep where id = sid;
  update room_sessions set carried_over = false where ended_at is null;
  return rep;
end $$;
revoke all on function public.close_shift() from public, anon;
grant execute on function public.close_shift() to authenticated;

-- ---------- who closed the bill ----------
alter table public.room_sessions add column if not exists closed_by text;
create or replace function public.close_room_session(
  p_session_id uuid,
  p_discount_kind text default null, p_discount_value numeric default 0,
  p_service_kind text default null, p_service_value numeric default 0,
  p_ended_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_end timestamptz; t_cost int; i_cost int; mins int; rtype text; disc int; serv int; base int;
begin
  if not public.staff_can('close') then raise exception 'not authorized' using errcode = '42501'; end if;
  v_end := least(now(), greatest(coalesce(p_ended_at, now()),
             coalesce((select max(started_at) from room_session_segments where session_id = p_session_id), now())));
  update room_session_segments set ended_at = v_end where session_id = p_session_id and ended_at is null;
  select room_type into rtype from room_sessions where id = p_session_id and ended_at is null;
  if rtype is null then raise exception 'session not open'; end if;
  select coalesce(sum(extract(epoch from (ended_at - started_at)) / 60), 0)::int into mins from room_session_segments where session_id = p_session_id;
  t_cost := round(public.session_time_cost(p_session_id, v_end))::int;
  select coalesce(sum(price * qty), 0)::int into i_cost from session_items where session_id = p_session_id and voided_at is null;
  base := t_cost + i_cost;
  disc := case when p_discount_kind = 'percent' then round(base * least(greatest(coalesce(p_discount_value,0),0),100) / 100.0)
               when p_discount_kind = 'amount'  then least(greatest(coalesce(p_discount_value,0),0), base) else 0 end;
  serv := case when p_service_kind = 'percent' then round((base - disc) * least(greatest(coalesce(p_service_value,0),0),100) / 100.0)
               when p_service_kind = 'amount'  then greatest(coalesce(p_service_value,0),0) else 0 end;
  update room_sessions
     set ended_at = v_end, time_amount = t_cost, items_amount = i_cost,
         discount_amount = disc, service_amount = serv, amount = base - disc + serv,
         closed_by = auth.jwt()->>'email',
         shift_id = (select id from shifts where closed_at is null order by id desc limit 1)
   where id = p_session_id;
  return jsonb_build_object('minutes', mins, 'time_amount', t_cost, 'items_amount', i_cost,
    'discount_amount', disc, 'service_amount', serv, 'total', base - disc + serv,
    'deposit', (select deposit_amount from room_sessions where id = p_session_id),
    'remaining', base - disc + serv - (select deposit_amount from room_sessions where id = p_session_id));
end $$;
revoke all on function public.close_room_session(uuid, text, numeric, text, numeric, timestamptz) from public, anon;
grant execute on function public.close_room_session(uuid, text, numeric, text, numeric, timestamptz) to authenticated;

-- ---------- offline-safe operations: every one carries a client op id, a replay never doubles ----------
alter table public.expenses add column if not exists op_id uuid;
create unique index if not exists expenses_op on public.expenses (op_id) where op_id is not null;
drop function if exists public.log_expense(int, text);
create or replace function public.log_expense(p_amount int, p_reason text, p_op uuid default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare sid smallint; cap int; nid bigint;
begin
  if not public.staff_can('expense') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_op is not null then select id into nid from expenses where op_id = p_op; if nid is not null then return nid; end if; end if;
  select id into sid from shifts where closed_at is null order by id desc limit 1;
  if sid is null then raise exception 'no open shift'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'bad amount'; end if;
  select coalesce((value->>'expense_cap')::int, 500) into cap from app_settings where key = 'config';
  if not public.is_admin() and cap > 0 and p_amount > cap then raise exception 'above the cashier limit of %', cap; end if;
  insert into expenses (shift_id, amount, reason, actor, op_id) values (sid, p_amount, btrim(p_reason), auth.jwt()->>'email', p_op) returning id into nid;
  perform ops_log('expense', jsonb_build_object('id', nid, 'shift', sid, 'amount', p_amount, 'reason', btrim(p_reason)));
  return nid;
end $$;
revoke all on function public.log_expense(int, text, uuid) from public, anon;
grant execute on function public.log_expense(int, text, uuid) to authenticated;

create or replace function public.add_session_item(p_op uuid, p_session uuid, p_name text, p_price int, p_qty int) returns bigint
language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.staff_can('add_items') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_op is not null then select id into nid from session_items where op_id = p_op; if nid is not null then return nid; end if; end if;
  if not exists (select 1 from room_sessions where id = p_session and ended_at is null) then raise exception 'session closed'; end if;
  if length(btrim(coalesce(p_name, ''))) < 1 or p_price is null or p_price < 0 or p_price > 2000 or p_qty is null or p_qty < 1 or p_qty > 100 then raise exception 'bad item'; end if;
  insert into session_items (session_id, name, price, qty, source, op_id) values (p_session, left(btrim(p_name), 60), p_price, p_qty, 'manual', p_op) returning id into nid;
  return nid;
end $$;
create or replace function public.void_item(p_op uuid, p_item_id bigint, p_target_op uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare i record;
begin
  if not public.staff_can('void') then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'reason required'; end if;
  select * into i from session_items where (p_item_id is not null and id = p_item_id) or (p_item_id is null and p_target_op is not null and op_id = p_target_op) for update;
  if i.id is null then raise exception 'item not found'; end if;
  if i.voided_at is not null then return 'already'; end if;
  if not exists (select 1 from room_sessions where id = i.session_id and ended_at is null) then raise exception 'session closed'; end if;
  update session_items set voided_at = now(), void_reason = left(btrim(p_reason), 120), voided_by = coalesce(nullif(auth.jwt()->>'email', ''), 'staff') where id = i.id;
  return 'ok';
end $$;
revoke all on function public.add_session_item(uuid, uuid, text, int, int), public.void_item(uuid, bigint, uuid, text) from public, anon;
grant execute on function public.add_session_item(uuid, uuid, text, int, int), public.void_item(uuid, bigint, uuid, text) to authenticated;
revoke all on function public.menu_cost_set(bigint, numeric), public.create_sale(uuid, text, text, jsonb, text, numeric, text), public.void_sale(uuid, bigint, text),
  public.recipe_set(bigint, smallint, jsonb), public.stock_item_save(bigint, text, text, numeric, boolean, numeric), public.stock_move(bigint, numeric, text, text), public.stock_count(jsonb, text) from public, anon;
grant execute on function public.menu_cost_set(bigint, numeric), public.create_sale(uuid, text, text, jsonb, text, numeric, text), public.void_sale(uuid, bigint, text),
  public.recipe_set(bigint, smallint, jsonb), public.stock_item_save(bigint, text, text, numeric, boolean, numeric), public.stock_move(bigint, numeric, text, text), public.stock_count(jsonb, text) to authenticated;

-- ---------- dashboard (admin) ----------
create or replace function public.dashboard(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tz text := public.biz_tz(); h int := public.biz_day_start(); res jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'bad range'; end if;
  with
  ses as (select s.*, ((s.ended_at at time zone tz) - make_interval(hours => h))::date as d from room_sessions s where s.ended_at is not null),
  sa as (select s.*, ((s.at at time zone tz) - make_interval(hours => h))::date as d from sales s where s.voided_at is null),
  ex as (select e.*, ((e.at at time zone tz) - make_interval(hours => h))::date as d from expenses e where e.voided_at is null),
  days as (
    select g::date as day,
      coalesce((select sum(amount) from ses where ses.d = g::date), 0) as rooms,
      coalesce((select count(*) from ses where ses.d = g::date), 0) as sessions,
      coalesce((select sum(total) from sa where sa.d = g::date), 0) as sales,
      coalesce((select sum(e.amount) from ex e where e.d = g::date), 0) as expenses,
      coalesce((select sum(i.cost) from session_items i join ses on ses.id = i.session_id where i.voided_at is null and ses.d = g::date), 0)
        + coalesce((select sum(si.cost) from sale_items si join sa on sa.id = si.sale_id where sa.d = g::date), 0) as cost
    from generate_series(p_from, p_to, interval '1 day') g),
  top as (
    select name, sum(qty) qty, sum(price * qty) revenue, sum(cost) cost from (
      select i.name, i.qty, i.price, i.cost from session_items i join ses on ses.id = i.session_id where i.voided_at is null and ses.d between p_from and p_to
      union all select si.name, si.qty, si.price, si.cost from sale_items si join sa on sa.id = si.sale_id where sa.d between p_from and p_to) u
    group by name order by sum(price * qty) desc limit 10),
  hrs as (
    select hr, sum(v) revenue, count(*) n from (
      select extract(hour from (ended_at at time zone tz))::int hr, amount v from ses where ses.d between p_from and p_to
      union all select extract(hour from (sa.at at time zone tz))::int, total from sa where sa.d between p_from and p_to) u group by hr order by hr),
  rms as (
    select r.name, count(*) sessions, coalesce(sum((select sum(extract(epoch from (g.ended_at - g.started_at)) / 60) from room_session_segments g where g.session_id = ses.id)), 0)::int minutes, sum(ses.amount) amount
    from ses join rooms r on r.id = ses.room_id where ses.d between p_from and p_to group by r.name order by sum(ses.amount) desc),
  csh as (
    select who, sum(n) n, sum(amount) amount from (
      select coalesce(closed_by, '?') who, 1 n, amount from ses where ses.d between p_from and p_to
      union all select coalesce(actor, '?'), 1, total from sa where sa.d between p_from and p_to) u group by who order by sum(amount) desc)
  select jsonb_build_object(
    'tz', tz, 'day_start_hour', h,
    'days', (select jsonb_agg(jsonb_build_object('day', day, 'rooms', rooms, 'sessions', sessions, 'sales', sales, 'revenue', rooms + sales, 'expenses', expenses, 'cost', cost, 'profit', rooms + sales - expenses - cost) order by day) from days),
    'top_items', coalesce((select jsonb_agg(to_jsonb(top)) from top), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(to_jsonb(hrs)) from hrs), '[]'::jsonb),
    'rooms', coalesce((select jsonb_agg(to_jsonb(rms)) from rms), '[]'::jsonb),
    'cashiers', coalesce((select jsonb_agg(to_jsonb(csh)) from csh), '[]'::jsonb)) into res;
  return res;
end $$;
revoke all on function public.dashboard(date, date) from public, anon;
grant execute on function public.dashboard(date, date) to authenticated;

-- ---------- full export (admin): one JSON with every business table, for backups ----------
create or replace function public.export_all() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t text; res jsonb := jsonb_build_object('exported_at', now(), 'tz', public.biz_tz()); q jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  foreach t in array array['rooms','room_rates','shifts','room_sessions','room_session_segments','session_items','session_audit','expenses','advances','attendance',
    'stock_items','stock_moves','stock_counts','recipes','menu_costs','sales','sale_items','menu_categories','menu_items','app_settings','staff_emails','ops_audit','settings_audit'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', t) into q;
    res := res || jsonb_build_object(t, q);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'summary', summary, 'created_at', created_at)), '[]'::jsonb) into q from orders;
  return res || jsonb_build_object('orders', q);
end $$;
revoke all on function public.export_all() from public, anon;
grant execute on function public.export_all() to authenticated;
