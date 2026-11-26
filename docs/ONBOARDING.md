# Onboarding a new cafe (about 45 minutes)

One client = one Supabase project + one Vercel project. Free tiers are enough.

## 0. You need
Client name, logo link (https), owner email, currency, room types, rates, menu, timezone (default Africa/Cairo), business day start hour (default 6).

## 1. Supabase (10 min)
1. New project (region close to the client). Save the DB password in a password manager, not in chat.
2. Authentication > Users > Add user: the owner email + a password the owner chooses. Tick "auto confirm".
3. Project Settings > API: copy the Project URL and the publishable (anon) key. The publishable key is public by design.

## 2. Build the SQL (1 min)
```
node scripts/new-client.js --admin owner@cafe.com
```
This writes `db/all.sql` (migrations 001 to latest in order, with the owner email set as admin). Do not edit the migrations by hand.

## 3. Run it (2 min)
Supabase > SQL editor > paste `db/all.sql` > Run once. If it stops with an error, fix the cause and run it again on a fresh project (a half-applied project is harder to repair than a new one).
Check: `select count(*) from staff_emails;` returns 1.

## 4. Point the app at it (5 min)
Fork/copy the repo for this client. Edit `features/data/data.config.js` (url and anonKey). Create a Vercel project from that repo. Env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
Telegram: create a bot with BotFather, add it to the orders group, register the webhook to `https://<client-domain>/api/telegram`. Secrets only in Vercel env, never in the repo or chat.

## 5. Configure in the admin panel (15 min)
Open `/admin/`, sign in as the owner, then:
- Settings: name, logo, colors, currency, receipt width (80mm or 58mm), timezone and business day start, room types, rates, VIP rates, shift names, cashier permissions.
- Menu tab: categories and items (or import by SQL for a big menu).
- Stock tab: stock items with cost, then recipes; or set one cost per menu item.
- Staff tab: create cashier accounts. The owner types the passwords.

## 6. Test before handing over (10 min)
Open a shift, start/close a room, make a takeaway sale, print a receipt and a shift report, place a customer order, close the shift, check the Reports tab. Then clear test data (SQL editor: delete from sales, session tables, shifts, orders, stock tables) and confirm the menu look is unchanged.

## 7. Daily backup
`scripts/backup.js` exports every business table to JSON using the admin-only `export_all()` function. Make a dedicated admin account for it. Either run it from any machine's cron:
```
SUPABASE_URL=... SUPABASE_ANON_KEY=... BACKUP_EMAIL=... BACKUP_PASSWORD=... node scripts/backup.js /path/to/backups
```
or set the 4 secrets in a PRIVATE GitHub repo; copy `docs/backup-workflow.yml` to `.github/workflows/backup.yml` (the deploy token here has no workflow scope) and it runs daily, keeping artifacts 30 days. The admin Reports tab also has a manual "full backup" button. Supabase free tier has no point-in-time backup, so test a restore once.

## Printing
- Receipts, takeaway slips and shift reports print through the browser print dialog at 80mm; set `receipt width` to 58 in Settings for 58mm paper.
- Silent printing (no dialog): a browser cannot do this by itself. On the cashier PC start Chrome with `--kiosk-printing` (set the thermal printer as the default printer). This is a per-PC setting and is not part of the app. Direct ESC/POS printing needs a small local bridge and is not built.

## Known limits
- One value of cost per menu item for the fallback cost (recipes can be per size).
- Customer orders that are accepted count as cash sales at the counter.
- The offline queue lives in one browser; clearing site data loses queued items.
- Multi-branch in one project is not built (use one project per branch).
