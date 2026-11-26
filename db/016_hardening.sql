-- Audit fixes. Run after 015. Safe to re-run.
-- 1) Two cashiers pressing "open shift" together could open several shifts: allow one open shift only.
-- 2) Two cashiers starting the same room together could double-open it: one open session per room.
-- 3) Recipes of a stopped (inactive) stock item no longer deduct.
-- NOTE: if an existing database already has duplicate open shifts/sessions, close the extras before running.
create unique index if not exists shifts_one_open on public.shifts ((true)) where closed_at is null;
create unique index if not exists room_one_open_session on public.room_sessions (room_id) where ended_at is null;

create or replace function public.trg_stock_sale() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    if NEW.voided_at is null then
      for r in select rc.item_id, rc.qty from recipes rc join stock_items si on si.id = rc.item_id and si.active where rc.menu_name = NEW.name loop
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
