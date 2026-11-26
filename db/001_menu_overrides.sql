-- Milestone 1: admin dashboard data (menu price edits / out-of-stock / hidden).
-- Run in the Supabase SQL editor of the EVO project. Safe to re-run.

create table if not exists public.menu_overrides (
  item_key     text primary key,            -- "<name>|<price>" or "<name>|<p1>/<p2>" from index.html
  prices       smallint[] ,                 -- replacement price(s); null = keep original
  out_of_stock boolean not null default false,
  hidden       boolean not null default false,
  updated_at   timestamptz not null default now()
);

alter table public.menu_overrides enable row level security;

-- Anyone (the menu page, anon key) can read overrides.
drop policy if exists "menu_overrides public read" on public.menu_overrides;
create policy "menu_overrides public read"
  on public.menu_overrides for select
  to anon, authenticated
  using (true);

-- Only the signed-in admin can change overrides.
drop policy if exists "menu_overrides admin write" on public.menu_overrides;
create policy "menu_overrides admin write"
  on public.menu_overrides for all
  to authenticated
  using (true)
  with check (true);
