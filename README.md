# EVO Cafe Menu

Arabic (RTL) digital menu with WhatsApp ordering for **EVO Cafe**, Mit Ghamr, Egypt. Built for a real client: customers scan a QR code, browse the menu on their phone, add items to an order and send it to the cafe on WhatsApp with their table or room number.

**Live (previous version):** https://evo-caffe-menu.vercel.app/

| Mobile home | Menu and cart | Order sheet |
|---|---|---|
| ![Mobile hero](docs/mobile-hero.png) | ![Menu and cart](docs/mobile-menu-cart.png) | ![Order sheet](docs/mobile-order-sheet.png) |

Item detail, order details and success screen: `docs/mobile-item-detail.png`, `docs/mobile-order-details.png`, `docs/mobile-order-done.png`.

| Featured items | Desktop |
|---|---|
| ![Featured](docs/mobile-featured.png) | ![Desktop](docs/desktop.png) |

Note: the screenshots with the contact bar use sample contact values for the demo, not real ones.

## Features
- 15 categories plus an "All" view (170 items), prices and descriptions in Arabic
- Sticky category pills with hand-drawn SVG icons, search across all items (ignores Arabic diacritics and أ/ا, ة/ه, ى/ي)
- "اختيارات ايفو" featured strip and a "مميز" badge, both driven by items marked as highlighted in `index.html`
- WhatsApp ordering in two steps: review the cart (quantity and a note per item), then table or room number (required), optional name and note. A success screen follows. Orders also go straight to a Telegram group through a small serverless function (`api/order.js`, bot token and group id kept in Vercel environment variables); if that fails the customer gets a WhatsApp button. The Arabic message carries items, notes, name and total. Tapping an item opens a detail sheet (size, quantity, note). Nothing is stored on a server; the cart stays on the phone.
- Contact bar and footer buttons (call, WhatsApp, map, Instagram, Facebook, TikTok) that show only when a value is set in the config
- Print mode (light, two columns) with a QR code, share preview (Open Graph)
- Hero with slow background drift and steam animation (off for reduced-motion), no JS libraries, small page

## Architecture
Feature-based, plain HTML, CSS and JavaScript. No build step.
```
index.html                 menu content (single source of items and prices)
shared/                    tokens.css (all colors), base.css, print.css
features/hero/             hero.css
features/nav/              nav.css, nav.js (category tabs)
features/menu/             menu.css, menu.js (All view, featured, badges, search), photos.config.js
features/cart/             cart.css, cart.js (WhatsApp order)
features/contact/          contact.config.js (edit here), contact.js, contact.css
features/footer/           footer.css
assets/                    qr-menu.svg, photos/ (optional)
docs/                      README screenshots
```

## How to edit
- **Prices or items:** edit the category sections in `index.html`. The "All" tab is generated from them, so edit once.
- **Phone, hours, social links, WhatsApp number:** `features/contact/contact.config.js`. The WhatsApp number also receives the orders.
- **Colors:** `shared/tokens.css`.
- **Category photos:** put files in `assets/photos/` and list them in `features/menu/photos.config.js`.

## Run locally
Open `index.html` in a browser. No install, no build.

## What is done
- [x] Redesign: espresso and cream palette with the EVO logo yellow, larger readable type
- [x] Single source of prices (two differing prices resolved with the owner: higher price kept)
- [x] Icons, search, featured items, print mode and QR
- [x] WhatsApp cart with required table or room number
- [x] Two-step order flow with success screen, item detail sheet
- [x] Contact configuration

## Roadmap (edit freely)
Near term
- [ ] Real photos: hero and one per category
- [x] Opening hours (AR and EN), Instagram and Facebook in the contact config
- [ ] Phone number and TikTok in the contact config
- [ ] Labels for two-price items (for example small and large)
- [ ] Test the order flow on real iOS and Android phones
- [ ] Move menu data into a JSON file and render all views from it

Medium term
- [ ] English version with a language toggle
- [ ] Out-of-stock switch per item without editing code
- [x] Notes per item and optional customer name in the order message
- [ ] Service charge line in the order message
- [ ] Order counter or kitchen view on a screen in the cafe
- [ ] Analytics for most viewed and most ordered items

Longer term
- [ ] Small admin page so the owner edits prices and availability from his phone
- [ ] Online ordering with payment (Instapay or card) and order status for the customer
- [ ] Reusable template to sell the same menu and ordering system to other cafes

## Scale-up (branch `scale-up`)

Building on a separate branch; `main` and the live site stay untouched. Preview deploy comes from Vercel automatically.

- [x] Milestone 1 code: admin dashboard (`/admin`) to edit prices and mark items out of stock or hidden; overrides stored in Supabase (`db/001_menu_overrides.sql`), applied on the menu at load (`features/data/`). Static menu keeps working if the backend is unreachable.
- [x] Milestone 2 code: customer-visible order status (accepted / preparing / ready). Staff tap inline buttons under the Telegram order message (`api/telegram.js` webhook); the customer follows along on `order.html`. Key-gated RPCs in `db/002_orders.sql`.
- [x] Milestone 3 code: PS room booking. Staff tab in `/admin` with start/stop sessions, live timer and per-minute price calc (`db/003_rooms.sql`; edit seeded room names/rates there).
- [x] Rooms v2 (`db/004_rooms_v2.sql`): PS4 (فور) / PS5 (فايف) room types with an editable rate matrix (type × 2 or 4 controllers), switching controllers mid-session billed per time segment, menu orders placed from a room added to its open session bill (customer picks غرفة + room code), staff can add menu items to a session manually (and remove wrong ones), discount and service charge (amount or percent) on the bill, advance payment (deposit) recorded in the shift that receives it, and a close bill showing time + items + discount/service = total, less deposit = remaining. Shifts: open/close in `/admin`; a session's bill is booked to the shift that closes it; shift close is blocked while open sessions are neither closed nor explicitly carried over; the closed shift report freezes totals (time, items, discounts, service, deposits, remainders) plus the carried-over sessions with what they accrued at handover.
- [x] Rooms v3 (`db/005_rooms_v3.sql`): voiding an item on a session needs a reason (the item stays on the bill as struck-through, not billed), pause/resume a session (no time is billed while paused), an audit log of session actions (start, close, items added or voided with reason, deposit, carry-over, pause/resume, controller changes, who did it) shown from the shift bar. Billing stays by the exact minute, no rounding and no minimum. Receipts: after closing a room bill (and per order in the new "الطلبات" admin tab) "اطبع الإيصال" opens an 80mm receipt (EVO header, time, items, discount, service, deposit, total) and prints it through the browser print dialog; pick the cashier printer there.

Setup notes for the owner:
1. Run `db/001_menu_overrides.sql`, then `db/002_orders.sql`, then `db/003_rooms.sql`, then `db/004_rooms_v2.sql`, then `db/005_rooms_v3.sql` in the Supabase SQL editor (do not re-run 004 after 005).
2. Put the project URL + anon key in `features/data/data.config.js` and in `api/order.js` / `api/telegram.js` (`SUPA_URL` / `SUPA_KEY`). The anon key is public by design; RLS and the per-order key protect the data.
3. Create the admin user in Supabase Authentication (email + password). Its password lives in the password vault.
4. Register the Telegram webhook once: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<this-deployment>/api/telegram` (re-point to the production URL after merging).
