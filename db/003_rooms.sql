-- Milestone 3: PS room booking with timer and price calculation.
-- Staff-only (admin login): no anonymous access. Run after 002_orders.sql.
-- Edit the seed rows to match the cafe's real rooms and hourly rates.

create table if not exists public.rooms (
  id            smallserial primary key,
  name          text not null,
  rate_per_hour smallint not null,          -- EGP per hour
  sort          smallint not null default 0,
  active        boolean not null default true
);

create table if not exists public.room_sessions (
  id          uuid primary key default gen_random_uuid(),
  room_id     smallint not null references public.rooms(id),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  amount      smallint,                     -- final price in EGP, set on stop
  created_at  timestamptz not null default now()
);

alter table public.rooms enable row level security;
alter table public.room_sessions enable row level security;

-- Staff (signed-in admin) only; customers never see room data.
drop policy if exists "rooms staff" on public.rooms;
create policy "rooms staff" on public.rooms for all to authenticated using (true) with check (true);
drop policy if exists "room_sessions staff" on public.room_sessions;
create policy "room_sessions staff" on public.room_sessions for all to authenticated using (true) with check (true);

-- Seed (edit names/rates to match the cafe):
insert into public.rooms (name, rate_per_hour, sort)
  values ('غرفة 1', 40, 1), ('غرفة 2', 40, 2), ('غرفة 3', 40, 3)
on conflict do nothing;
