#!/usr/bin/env node
// Turns a backup file (from scripts/backup.js) into SQL you paste in the Supabase SQL editor.
// Usage: node scripts/restore-sql.js evo-backup-2026-11-26.json [schema] > restore.sql
// Default schema is "public": only run it on an EMPTY database (after migrations 001-017), or you get duplicate-key errors.
// To rehearse first, create a scratch schema with copies of the tables (create table s.t (like public.t including defaults)) and pass its name.
var fs = require('fs');
function evoRestoreSql(d, schema) {
  var ORDER = ['menu_categories','menu_items','menu_costs','recipes','stock_items','rooms','room_rates','app_settings','staff_emails','shifts','room_sessions','room_session_segments','session_items','session_audit','sales','sale_items','orders','advances','expenses','attendance','stock_moves','stock_counts','ops_audit','settings_audit'];
  var keys = Object.keys(d).filter(function (k) { return Array.isArray(d[k]); });
  var rest = keys.filter(function (k) { return ORDER.indexOf(k) < 0; });
  var out = ['-- EVO restore. Target schema: ' + schema, 'begin;'];
  ORDER.concat(rest).forEach(function (t) {
    if (!Array.isArray(d[t]) || !d[t].length) return;
    var arr = '$evo$' + JSON.stringify(d[t]) + '$evo$::jsonb';
    // export_all() leaves out orders.edit_key (a secret); give each restored order a fresh one.
    if (t === 'orders') arr = "(select jsonb_agg(e || jsonb_build_object('edit_key', md5(random()::text || clock_timestamp()::text))) from jsonb_array_elements(" + arr + ") e)";
    out.push('insert into ' + schema + '.' + t + ' select * from jsonb_populate_recordset(null::' + schema + '.' + t + ', ' + arr + ');');
  });
  out.push('commit;');
  return out.join('\n');
}
if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node scripts/restore-sql.js backup.json [schema]'); process.exit(1); }
  process.stdout.write(evoRestoreSql(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3] || 'public') + '\n');
}
module.exports = evoRestoreSql;
