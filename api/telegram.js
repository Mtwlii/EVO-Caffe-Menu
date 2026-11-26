// Telegram webhook (milestone 2): staff tap the inline status buttons under an
// order message; this updates the order status through a key-gated RPC and
// confirms in the group. Register once with:
//   curl "https://api.telegram.org/bot$TOKEN/setWebhook?url=https://<deployment>/api/telegram"
// The bot token stays in the TELEGRAM_BOT_TOKEN env var; the Supabase anon key
// below is public by design (the RPC enforces the per-order secret key).
var SUPA_URL = 'https://lfkhfwvxwyhhpvygtffr.supabase.co';
var SUPA_KEY = 'sb_publishable_NHBbzyQKqZ18PNamz5q5bw_fZTHP94d';
var CODE2STATUS = { a: 'accepted', p: 'preparing', r: 'ready' };
var LABELS = { accepted: 'مقبول', preparing: 'بيتحضّر 👨‍🍳', ready: 'جاهز ✅' };

module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !SUPA_URL || !SUPA_KEY) return res.status(200).json({ ok: true }); // not configured: ack silently

  // Telegram sends our secret in this header (registered with setWebhook secret_token). Derived from the bot token, so no new env var.
  var secret = require('crypto').createHash('sha256').update('tg-webhook|' + token).digest('hex');
  if (req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).json({ ok: false });

  var u = req.body || {};
  var cq = u.callback_query;
  if (!cq || !cq.data || cq.data.indexOf('s:') !== 0) return res.status(200).json({ ok: true });

  var parts = String(cq.data).split(':');
  var oid = parts[1], key = parts[2], st = CODE2STATUS[parts[3]];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(oid || '') || !/^[0-9a-f]{12,32}$/.test(key || '') || !st) return res.status(200).json({ ok: true });

  function tg(method, payload) {
    return fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    }).catch(function () { return null; });
  }

  try {
    var r = await fetch(SUPA_URL + '/rest/v1/rpc/set_order_status', {
      method: 'POST',
      headers: { apikey: SUPA_KEY, authorization: 'Bearer ' + SUPA_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ p_id: oid, p_edit_key: key, p_status: st })
    });
    var okd = r.ok && (await r.json()) === true;
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: okd ? ('الحالة: ' + LABELS[st]) : 'الطلب ده مش متعرف عليه', show_alert: !okd });
    if (okd && cq.message) {
      var txt = String(cq.message.text || '');
      var line = 'الحالة: ' + LABELS[st];
      txt = /الحالة: .*/.test(txt) ? txt.replace(/الحالة: .*/, line) : txt + '\n\n' + line;
      await tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: txt, reply_markup: cq.message.reply_markup });
    }
  } catch (e) { /* ack anyway so Telegram stops retrying */ }
  res.status(200).json({ ok: true });
};
