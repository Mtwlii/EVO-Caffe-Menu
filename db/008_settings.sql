-- White-label settings. Run after 007_staff_roles.sql. Safe to re-run.
-- One row (key 'config') holds everything a client can change from the admin panel:
-- brand, theme, currency, receipt texts, room types, shift names, label overrides.
-- Readable by everyone (it is branding only, NEVER put secrets in it); writable by admin only.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "settings read" on public.app_settings;
drop policy if exists "settings admin ins" on public.app_settings;
drop policy if exists "settings admin upd" on public.app_settings;
create policy "settings read" on public.app_settings for select to anon, authenticated using (true);
create policy "settings admin ins" on public.app_settings for insert to authenticated with check (public.is_admin());
create policy "settings admin upd" on public.app_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.app_settings to anon, authenticated;
grant insert, update on public.app_settings to authenticated;

-- room types are now data, not a fixed ps4/ps5 list
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.room_rates'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%room_type%' loop
    execute format('alter table public.room_rates drop constraint %I', c.conname);
  end loop;
end $$;

insert into public.app_settings (key, value) values ('config', $json$
{
  "brand": { "name": "EVO Café", "logo_url": "" },
  "theme": { "primary": "#22d3ee", "bg": "#080c15", "surface": "#121a2c", "text": "#eaf0ff" },
  "dir": "rtl",
  "currency": "جنيه",
  "receipt": { "subtitle": "إيصال", "footer": "شكراً لزيارتكم", "extra": "" },
  "room_types": [ { "id": "ps4", "label": "فور" }, { "id": "ps5", "label": "فايف" } ],
  "shifts": [ "صباحية", "مسائية" ],
  "labels": ""
}
$json$::jsonb) on conflict (key) do nothing;
