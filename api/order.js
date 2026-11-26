// Vercel serverless function: receives an order and posts it to a Telegram group.
// Secrets live in Vercel env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Never in client code.
// Milestone 2: when the data backend is configured (SUPA_* below, anon key is
// public by design), the order is also stored so the customer can follow its
// status, and the Telegram message gets inline status buttons for staff.
var hits = {}; // best-effort per-instance rate limit: ip -> [timestamps]
var MAX_BODY = 8000, MAX_LINES = 40, WINDOW = 60000, MAX_HITS = 5;

// Public-by-design Supabase anon config (same values as features/data/data.config.js).
var SUPA_URL = '';
var SUPA_KEY = '';

function s(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function fail(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

module.exports = async function (req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method');
  var token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return fail(res, 503, 'not configured');

  var host = req.headers.host || '', origin = req.headers.origin || '';
  if (origin && origin.replace(/^https?:\/\//, '') !== host) return fail(res, 403, 'origin');

  var ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || 'x').trim(), now = Date.now();
  hits[ip] = (hits[ip] || []).filter(function (t) { return now - t < WINDOW; });
  if (hits[ip].length >= MAX_HITS) return fail(res, 429, 'rate');
  hits[ip].push(now);

  var b = req.body;
  if (typeof b === 'string') { if (b.length > MAX_BODY) return fail(res, 413, 'size'); try { b = JSON.parse(b); } catch (e) { return fail(res, 400, 'json'); } }
  if (!b || typeof b !== 'object' || JSON.stringify(b).length > MAX_BODY) return fail(res, 400, 'body');
  if (b.hp) return res.status(200).json({ ok: true }); // honeypot: silently drop bots

  var type = b.type === 'غرفة' ? 'غرفة' : 'طاولة', num = s(b.num, 10);
  if (!num) return fail(res, 400, 'place');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > MAX_LINES) return fail(res, 400, 'items');

  // Optional order tracking fields from the client (milestone 2).
  var oid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(b.id || '')) ? String(b.id) : null;
  var okey = /^[0-9a-f]{12,32}$/.test(String(b.key || '')) ? String(b.key) : null;
  if (!oid || !okey) { oid = null; okey = null; }

  var total = 0, lines = [];
  for (var i = 0; i < b.items.length; i++) {
    var it = b.items[i], q = Number(it.qty), p = Number(it.price), name = s(it.name, 60);
    if (!name || !(q >= 1 && q <= 50) || !(p > 0 && p <= 2000) || q % 1 || p % 1) return fail(res, 400, 'item');
    total += q * p;
    lines.push('• ' + q + ' × ' + name + ' (' + p + ') = ' + q * p + (it.note ? '\n   ملاحظة: ' + s(it.note, 80) : ''));
  }
  var text = ['🧾 طلب جديد من منيو EVO', type + ' رقم: ' + num];
  if (s(b.who, 40)) text.push('الاسم: ' + s(b.who, 40));
  text.push('', lines.join('\n'), '', 'الإجمالي: ' + total + ' جنيه');
  if (s(b.note, 120)) text.push('ملاحظات: ' + s(b.note, 120));

  // Store the order for status tracking (key-gated RPC; anon key is public by design).
  var tracked = false;
  if (oid && SUPA_URL && SUPA_KEY) {
    try {
      var summary = { type: type, num: num, who: s(b.who, 40), note: s(b.note, 120), total: total,
        items: b.items.map(function (x) { return { name: s(x.name, 60), price: Number(x.price), qty: Number(x.qty), note: s(x.note, 80) }; }) };
      var sr = await fetch(SUPA_URL + '/rest/v1/rpc/create_order', {
        method: 'POST',
        headers: { apikey: SUPA_KEY, authorization: 'Bearer ' + SUPA_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ p_id: oid, p_edit_key: okey, p_summary: summary })
      });
      tracked = sr.ok;
    } catch (e) { tracked = false; }
  }

  var msg = { chat_id: null, text: text.join('\n') };
  if (tracked) {
    msg.reply_markup = { inline_keyboard: [[
      { text: 'مقبول', callback_data: 's:' + oid + ':' + okey + ':accepted' },
      { text: 'بيتحضّر', callback_data: 's:' + oid + ':' + okey + ':preparing' },
      { text: 'جاهز ✅', callback_data: 's:' + oid + ':' + okey + ':ready' }
    ]] };
  }

  async function post(id) {
    var m = Object.assign({}, msg, { chat_id: id });
    return fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(m)
    });
  }
  try {
    var r = await post(chat), j = {};
    try { j = await r.json(); } catch (e) {}
    // A group upgraded to a supergroup gets a new id. Telegram tells us the new one: retry once with it.
    var moved = j && j.parameters && j.parameters.migrate_to_chat_id;
    if (!r.ok && moved) { r = await post(moved); j = {}; try { j = await r.json(); } catch (e) {} }
    if (!r.ok) return res.status(502).json({ ok: false, error: 'telegram', code: r.status, detail: s(j.description, 80), moved: !!moved });
    res.status(200).json({ ok: true, tracked: tracked, id: tracked ? oid : null });
  } catch (e) { res.status(502).json({ ok: false, error: 'network', detail: s(e && e.message, 80) }); }
};
