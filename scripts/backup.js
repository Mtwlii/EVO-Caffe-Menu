#!/usr/bin/env node
// Full JSON export of one client (all business tables) via the admin-only export_all() function.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (publishable), BACKUP_EMAIL, BACKUP_PASSWORD (a dedicated admin account).
// Usage: node scripts/backup.js [outdir]   -> outdir/evo-backup-YYYY-MM-DD.json (default ./backups)
// Needs Node 18+. Keeps the last 30 files. Run daily with cron or .github/workflows/backup.yml.
var fs = require('fs'), path = require('path');
var U = process.env.SUPABASE_URL, K = process.env.SUPABASE_ANON_KEY, E = process.env.BACKUP_EMAIL, P = process.env.BACKUP_PASSWORD;
if (!U || !K || !E || !P) { console.error('set SUPABASE_URL, SUPABASE_ANON_KEY, BACKUP_EMAIL, BACKUP_PASSWORD'); process.exit(1); }
U = U.replace(/\/$/, '');
(async function () {
  var r = await fetch(U + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: K, 'content-type': 'application/json' }, body: JSON.stringify({ email: E, password: P }) });
  var s = await r.json(); if (!r.ok) throw new Error('login failed: ' + (s.error_description || s.msg || r.status));
  var x = await fetch(U + '/rest/v1/rpc/export_all', { method: 'POST', headers: { apikey: K, authorization: 'Bearer ' + s.access_token, 'content-type': 'application/json' }, body: '{}' });
  var d = await x.json(); if (!x.ok) throw new Error('export failed: ' + (d.message || x.status));
  var dir = process.argv[2] || 'backups'; fs.mkdirSync(dir, { recursive: true });
  var f = path.join(dir, 'evo-backup-' + new Date().toISOString().slice(0, 10) + '.json');
  fs.writeFileSync(f, JSON.stringify(d));
  var all = fs.readdirSync(dir).filter(function (n) { return /^evo-backup-.*\.json$/.test(n); }).sort();
  all.slice(0, Math.max(0, all.length - 30)).forEach(function (n) { fs.unlinkSync(path.join(dir, n)); });
  console.log('saved ' + f + ' (' + Object.keys(d).length + ' tables)');
})().catch(function (e) { console.error(e.message); process.exit(1); });
