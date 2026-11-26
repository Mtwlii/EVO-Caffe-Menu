// Vercel serverless function: receives an order and posts it to a Telegram group.
// Secrets live in Vercel env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Never in client code.
var hits = {}; // best-effort per-instance rate limit: ip -> [timestamps]
var MAX_BODY = 8000, MAX_LINES = 40, WINDOW = 60000, MAX_HITS = 5;

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

  try {
    var r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.join('\n') })
    });
    if (!r.ok) return fail(res, 502, 'telegram');
    res.status(200).json({ ok: true });
  } catch (e) { fail(res, 502, 'telegram'); }
};
