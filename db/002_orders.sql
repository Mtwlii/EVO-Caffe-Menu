-- Milestone 2: customer-visible order status.
-- Orders are created by the menu (anon), status is updated by staff from
-- Telegram buttons, and read by the customer with a per-order secret key.
-- Run in the Supabase SQL editor after 001_menu_overrides.sql. Safe to re-run.

create table if not exists public.orders (
  id         uuid primary key,
  edit_key   text not null,                 -- per-order secret: only holder can read/update status
  status     text not null default 'new' check (status in ('new','accepted','preparing','ready')),
  summary    jsonb not null default '{}',   -- items, table/room, name, total (for staff reference)
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;
-- No table-level policies at all: nobody reads/writes rows directly.
-- Everything goes through the key-checked functions below.

create or replace function public.create_order(p_id uuid, p_edit_key text, p_summary jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_edit_key is null or char_length(p_edit_key) < 12 then
    raise exception 'weak key';
  end if;
  insert into public.orders (id, edit_key, summary) values (p_id, p_edit_key, coalesce(p_summary, '{}'));
end $$;

create or replace function public.get_order_status(p_id uuid, p_edit_key text)
returns text language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select status into s from public.orders where id = p_id and edit_key = p_edit_key;
  return s; -- null when unknown order or wrong key
end $$;

create or replace function public.set_order_status(p_id uuid, p_edit_key text, p_status text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('accepted','preparing','ready') then return false; end if;
  update public.orders set status = p_status where id = p_id and edit_key = p_edit_key;
  return found;
end $$;

revoke all on function public.create_order(uuid, text, jsonb) from public;
revoke all on function public.get_order_status(uuid, text) from public;
revoke all on function public.set_order_status(uuid, text, text) from public;
grant execute on function public.create_order(uuid, text, jsonb) to anon;
grant execute on function public.get_order_status(uuid, text) to anon;
grant execute on function public.set_order_status(uuid, text, text) to anon;
