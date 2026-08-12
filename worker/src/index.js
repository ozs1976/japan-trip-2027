// Cloudflare Worker: relay between the Japan-trip site, Telegram, and Firestore.
// Pure code — no AI involved. Verified notes (password matches) are flagged
// 'pending' in Firestore for the local poller (scripts/note-poller.ps1) to pick
// up and hand to `claude -p`. Unverified notes stay informational: a human can
// reply directly in Telegram and this Worker relays that reply back to the site.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method === 'POST' && url.pathname === '/note') {
      return handleNote(request, env, ctx, cors);
    }
    if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
      return handleWebhook(request, env);
    }
    return new Response('Not found', { status: 404, headers: cors });
  },
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function shortId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// ---- rate limiting: one request per IP per 20s, using the Worker's own edge cache (no extra resource) ----
async function isRateLimited(ip, ctx) {
  const cache = caches.default;
  const key = new Request(`https://ratelimit.internal/note/${ip}`);
  const hit = await cache.match(key);
  if (hit) return true;
  ctx.waitUntil(cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=20' } })));
  return false;
}

// ---- /note: site submits a note/instruction ----
async function handleNote(request, env, ctx, cors) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(ip, ctx)) {
    return json({ error: 'rate-limited' }, 429, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad-json' }, 400, cors);
  }

  const rawText = (body.text || '').toString();
  const senderName = (body.senderName || 'לא ידוע').toString().slice(0, 80);
  const senderEmail = (body.senderEmail || '').toString().slice(0, 200);

  const lines = rawText.split('\n');
  const firstLine = (lines[0] || '').trim();
  const verified = firstLine.length > 0 && firstLine === env.NOTE_PASSWORD;
  const noteText = (verified ? lines.slice(1).join('\n') : rawText).trim().slice(0, 2000);

  if (!noteText) return json({ error: 'empty' }, 400, cors);

  const id = shortId();
  const nowIso = new Date().toISOString();

  const fields = {
    text: { stringValue: noteText },
    reply: { nullValue: null },
    senderName: { stringValue: senderName },
    senderEmail: { stringValue: senderEmail },
    verified: { booleanValue: verified },
    status: { stringValue: verified ? 'pending' : 'info' },
    createdAt: { timestampValue: nowIso },
  };

  const created = await firestoreCreate(env, 'notes', id, fields);
  if (!created) return json({ error: 'firestore-write-failed' }, 502, cors);

  // Best-effort push — the note is already saved either way, so a Telegram
  // hiccup here must never fail the request back to the browser.
  try {
    const prefix = verified ? '🔴 הוראה מאומתת' : '📝 הערה';
    const suffix = verified ? '\n\n(תטופל אוטומטית)' : '\n\n(השיבו להודעה זו כדי לענות)';
    const text = `${prefix} מ-${senderName}:\n\n${noteText}${suffix}`;
    const tgResult = await telegramSendMessage(env, text);
    if (tgResult && tgResult.message_id) {
      await firestorePatch(env, `notes/${id}`, ['tgMessageId'], {
        tgMessageId: { integerValue: String(tgResult.message_id) },
      });
    }
  } catch (e) {
    console.error('telegram send failed', e);
  }

  return json({ ok: true, id, verified }, 200, cors);
}

// ---- /telegram-webhook: human reply in Telegram to an unverified/informational note ----
async function handleWebhook(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch (e) {
    return new Response('ok');
  }

  const msg = update.message;
  if (!msg || !msg.reply_to_message || String(msg.chat.id) !== env.TELEGRAM_CHAT_ID) {
    return new Response('ok');
  }

  const replyText = (msg.text || '').trim().slice(0, 4000);
  if (!replyText) return new Response('ok');

  const target = await firestoreFindByTgMessageId(env, msg.reply_to_message.message_id);
  if (!target) return new Response('ok');

  await firestorePatch(env, target.path, ['reply', 'repliedAt', 'status'], {
    reply: { stringValue: replyText },
    repliedAt: { timestampValue: new Date().toISOString() },
    status: { stringValue: 'done' },
  });

  return new Response('ok');
}

// ---- Telegram REST ----
async function telegramSendMessage(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  if (!res.ok) throw new Error('telegram sendMessage failed: ' + res.status);
  const data = await res.json();
  return data.result;
}

// ---- Firestore REST (plain, unauthenticated — same posture as the rest of this project) ----
function fsBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIRESTORE_PROJECT_ID}/databases/(default)/documents`;
}

async function firestoreCreate(env, collection, id, fields) {
  const res = await fetch(`${fsBase(env)}/${collection}?documentId=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return res.ok;
}

async function firestorePatch(env, path, maskFields, fields) {
  const mask = maskFields.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const res = await fetch(`${fsBase(env)}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return res.ok;
}

async function firestoreFindByTgMessageId(env, tgMessageId) {
  const res = await fetch(`${fsBase(env)}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'notes' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'tgMessageId' },
            op: 'EQUAL',
            value: { integerValue: String(tgMessageId) },
          },
        },
        limit: 1,
      },
    }),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows.find((r) => r.document) : null;
  if (!row) return null;
  const name = row.document.name; // .../documents/notes/{id}
  const path = name.split('/documents/')[1]; // "notes/{id}"
  return { path };
}
