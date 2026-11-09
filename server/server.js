// Private chat relay for the OpenClaw bot on the shop PC.
//
// Phone  --(password login)-->  this server  <--(bridge token, outbound only)--  PC bridge  -->  OpenClaw
//
// The PC is never reachable from the internet: the bridge on the PC polls this
// server for queued messages and posts the bot's replies back.
// No database access, no third-party dependencies. Messages live in memory only.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`session:${APP_PASSWORD}:${BRIDGE_TOKEN}`).digest('hex');

if (APP_PASSWORD.length < 12 || BRIDGE_TOKEN.length < 32) {
  console.error(
    APP_PASSWORD.length < 12
      ? `Refusing to start: APP_PASSWORD is ${APP_PASSWORD.length} characters; it must be at least 12. Set a longer one in Railway Variables.`
      : 'Refusing to start: BRIDGE_TOKEN must be at least 32 characters.'
  );
  process.exit(1);
}

// Cloud bot (OpenClaw gateway on Railway's private network). Optional.
const OPENCLAW_URL = (process.env.OPENCLAW_URL || '').replace(/\/+$/, '');
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
const CLOUD_ENABLED = Boolean(OPENCLAW_URL && OPENCLAW_TOKEN);
const CLOUD_MODEL_OVERRIDE = { free: null, chatgpt: 'openai/gpt-6-astra' };

// Approvals: the cloud bot's tools ask here (private network only) before changing anything.
const APPROVAL_TOKEN = process.env.APPROVAL_TOKEN || '';
const APPROVAL_TTL_MS = 10 * 60 * 1000;

const SESSION_DAYS = 30;
const MAX_TEXT = 8000;
const MAX_MESSAGES = 500;
const JOB_TIMEOUT_MS = 12 * 60 * 1000;
const BRIDGE_ONLINE_MS = 75 * 1000;
const MODELS = new Set(['free', 'chatgpt']);
const TARGETS = new Set(['cloud', 'pc']);

// ---------- state (in memory) ----------
let seq = 0;
const messages = []; // {seq, id, conv, role, text, model, status, ts}
const queue = []; // ids of user messages waiting for the bridge
let lastBridgeSeen = 0;
let bridgeWaiters = []; // pending long-poll responses from the bridge

function nextSeq() {
  return ++seq;
}

function addMessage(m) {
  m.seq = nextSeq();
  m.ts = Date.now();
  messages.push(m);
  while (messages.length > MAX_MESSAGES) messages.shift();
  return m;
}

function findMessage(id) {
  return messages.find((m) => m.id === id);
}

function touch(m) {
  m.seq = nextSeq();
}

// ---------- helpers ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeSessionCookie() {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const val = `${exp}.${sign(String(exp))}`;
  return `s=${val}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

function isAuthed(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)s=([^;]+)/);
  if (!m) return false;
  const [exp, mac] = m[1].split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return safeEqual(mac, sign(exp));
}

function isBridge(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), BRIDGE_TOKEN);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

// Login rate limiting: 8 failed attempts per IP and 40 overall per 15 minutes.
// The overall cap still holds if someone spoofs forwarding headers.
const loginFails = new Map();
const WINDOW = 15 * 60 * 1000;
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Rightmost entry is the one appended by Railway's proxy.
  return xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
}
function failCount(key) {
  const r = loginFails.get(key);
  if (!r) return 0;
  if (Date.now() - r.first > WINDOW) {
    loginFails.delete(key);
    return 0;
  }
  return r.count;
}
function loginBlocked(ip) {
  return failCount(ip) >= 8 || failCount('*') >= 40;
}
function noteLoginFail(ip) {
  for (const key of [ip, '*']) {
    if (failCount(key) === 0) loginFails.set(key, { first: Date.now(), count: 1 });
    else loginFails.get(key).count++;
  }
}

// ---------- bridge queue ----------
function takeJob() {
  while (queue.length) {
    const id = queue.shift();
    const m = findMessage(id);
    if (m && m.status === 'queued') {
      m.status = 'working';
      m.startedAt = Date.now();
      touch(m);
      return { id: m.id, conv: m.conv, text: m.text, model: m.model };
    }
  }
  return null;
}

function wakeBridge() {
  const waiters = bridgeWaiters;
  bridgeWaiters = [];
  for (const w of waiters) {
    const job = takeJob();
    clearTimeout(w.timer);
    if (job) send(w.res, 200, job);
    else send(w.res, 204, '');
  }
}

// Fail jobs the bridge never answered (e.g. PC went to sleep mid-task).
setInterval(() => {
  const now = Date.now();
  for (const m of messages) {
    if (m.role === 'user' && m.status === 'working' && now - m.startedAt > JOB_TIMEOUT_MS) {
      m.status = 'done';
      touch(m);
      addMessage({ id: crypto.randomUUID(), conv: m.conv, role: 'error', text: 'No reply from the PC in time. Try again.', replyTo: m.id });
    }
  }
}, 30 * 1000).unref();

// ---------- cloud bot ----------
let cloudOnline = false;
async function checkCloud() {
  if (!CLOUD_ENABLED) return;
  try {
    const r = await fetch(`${OPENCLAW_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    cloudOnline = r.ok;
  } catch {
    cloudOnline = false;
  }
}
checkCloud();
setInterval(checkCloud, 30 * 1000).unref();

async function runCloud(m) {
  m.status = 'working';
  m.startedAt = Date.now();
  touch(m);
  const headers = { Authorization: `Bearer ${OPENCLAW_TOKEN}`, 'Content-Type': 'application/json' };
  const override = CLOUD_MODEL_OVERRIDE[m.model];
  if (override) headers['x-openclaw-model'] = override;
  let reply;
  try {
    const r = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'openclaw:main', user: `phone:${m.conv}`, messages: [{ role: 'user', content: m.text }] }),
      signal: AbortSignal.timeout(JOB_TIMEOUT_MS - 60 * 1000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) reply = { error: `Cloud bot error (${r.status}): ${j.error?.message || j.error || 'unknown'}` };
    else reply = { text: j.choices?.[0]?.message?.content || '(no text reply)', modelUsed: j.model || '' };
  } catch (e) {
    reply = { error: `Cloud bot unreachable: ${e.name === 'TimeoutError' ? 'timed out' : e.message}` };
  }
  if (m.status !== 'working') return; // already timed out
  m.status = 'done';
  touch(m);
  addMessage({
    id: crypto.randomUUID(),
    conv: m.conv,
    role: reply.error ? 'error' : 'assistant',
    text: String(reply.error || reply.text).slice(0, 100000),
    model: String(reply.modelUsed || '').slice(0, 120),
    replyTo: m.id,
  });
}

// ---------- approvals ----------
const approvals = new Map(); // id -> {id, tool, command, summary, status, createdAt, decidedAt}

function approvalView(a) {
  const expired = a.status === 'pending' && Date.now() - a.createdAt > APPROVAL_TTL_MS;
  return { ...a, status: expired ? 'expired' : a.status };
}

setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, a] of approvals) if (a.createdAt < cutoff) approvals.delete(id);
}, 3600 * 1000).unref();

function isInternal(req) {
  // Only reachable over Railway's private network, and only with the approval token.
  const host = String(req.headers.host || '').split(':')[0];
  const h = req.headers.authorization || '';
  return (
    APPROVAL_TOKEN.length >= 32 &&
    host.endsWith('.railway.internal') &&
    h.startsWith('Bearer ') &&
    safeEqual(h.slice(7), APPROVAL_TOKEN)
  );
}

function pendingApprovals() {
  return [...approvals.values()].map(approvalView).filter((a) => a.status === 'pending');
}

// ---------- static files ----------
const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), { 'Content-Type': type });
    }

    // ----- internal API for the cloud bot's tools (private network + token) -----
    if (p.startsWith('/internal/')) {
      if (!isInternal(req)) return send(res, 404, 'Not found');
      if (req.method === 'POST' && p === '/internal/approvals') {
        const body = await readJson(req);
        if (pendingApprovals().length >= 20) return send(res, 429, { error: 'Too many pending approvals.' });
        const a = {
          id: crypto.randomUUID(),
          tool: String(body.tool || 'Tool').slice(0, 40),
          command: String(body.command || '').slice(0, 4000),
          summary: String(body.summary || '').slice(0, 6000),
          status: 'pending',
          createdAt: Date.now(),
          decidedAt: null,
        };
        approvals.set(a.id, a);
        console.log(`approval requested ${a.id} (${a.tool})`);
        return send(res, 200, { id: a.id });
      }
      const m = p.match(/^\/internal\/approvals\/([0-9a-f-]{36})(\/expire)?$/);
      if (m) {
        const a = approvals.get(m[1]);
        if (!a) return send(res, 404, { error: 'Unknown approval.' });
        if (req.method === 'POST' && m[2]) {
          if (a.status === 'pending') a.status = 'expired';
          return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && !m[2]) return send(res, 200, { status: approvalView(a).status });
      }
      return send(res, 404, 'Not found');
    }

    // ----- phone / browser API -----
    if (req.method === 'POST' && p === '/api/login') {
      const ip = clientIp(req);
      if (loginBlocked(ip)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
      const body = await readJson(req);
      if (!safeEqual(body.password || '', APP_PASSWORD)) {
        noteLoginFail(ip);
        return send(res, 401, { error: 'Wrong password.' });
      }
      loginFails.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': makeSessionCookie() });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 's=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
    }

    if (p.startsWith('/api/')) {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not logged in.' });

      if (req.method === 'GET' && p === '/api/state') {
        const since = Number(url.searchParams.get('since')) || 0;
        const conv = String(url.searchParams.get('conv') || '');
        return send(res, 200, {
          seq,
          pendingApprovals: pendingApprovals().length,
          cloudEnabled: CLOUD_ENABLED,
          cloudOnline,
          bridgeOnline: Date.now() - lastBridgeSeen < BRIDGE_ONLINE_MS,
          messages: messages
            .filter((m) => m.seq > since && m.conv === conv)
            .map(({ seq: s, id, role, text, model, target, status, ts }) => ({ seq: s, id, role, text, model, target, status, ts })),
        });
      }

      if (req.method === 'GET' && p === '/api/approvals') {
        const all = [...approvals.values()].map(approvalView).sort((a, b) => b.createdAt - a.createdAt);
        return send(res, 200, { approvals: all.slice(0, 30) });
      }

      const am = p.match(/^\/api\/approvals\/([0-9a-f-]{36})$/);
      if (req.method === 'POST' && am) {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, { error: 'JSON only.' });
        const body = await readJson(req);
        const a = approvals.get(am[1]);
        if (!a) return send(res, 404, { error: 'Unknown approval.' });
        if (approvalView(a).status !== 'pending') return send(res, 409, { error: `Already ${approvalView(a).status}.` });
        if (body.decision !== 'approve' && body.decision !== 'deny') return send(res, 400, { error: 'Bad decision.' });
        a.status = body.decision === 'approve' ? 'approved' : 'denied';
        a.decidedAt = Date.now();
        console.log(`approval ${a.id} ${a.status}`);
        return send(res, 200, { ok: true, status: a.status });
      }

      if (req.method === 'POST' && p === '/api/send') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, { error: 'JSON only.' });
        const body = await readJson(req);
        const text = String(body.text || '').trim();
        const model = MODELS.has(body.model) ? body.model : 'free';
        const target = TARGETS.has(body.target) ? body.target : CLOUD_ENABLED ? 'cloud' : 'pc';
        const conv = String(body.conv || '');
        if (!/^[a-f0-9]{16}$/.test(conv)) return send(res, 400, { error: 'Bad conversation id.' });
        if (!text) return send(res, 400, { error: 'Empty message.' });
        if (text.length > MAX_TEXT) return send(res, 400, { error: `Keep messages under ${MAX_TEXT} characters.` });
        if (target === 'cloud' && !CLOUD_ENABLED) return send(res, 400, { error: 'Cloud bot is not set up.' });
        const m = addMessage({ id: crypto.randomUUID(), conv, role: 'user', text, model, target, status: 'queued' });
        if (target === 'cloud') runCloud(m);
        else {
          queue.push(m.id);
          wakeBridge();
        }
        return send(res, 200, { ok: true, id: m.id });
      }

      return send(res, 404, { error: 'Not found.' });
    }

    // ----- PC bridge API (bearer token) -----
    if (p.startsWith('/bridge/')) {
      if (!isBridge(req)) return send(res, 401, { error: 'Bad bridge token.' });
      lastBridgeSeen = Date.now();

      if (req.method === 'GET' && p === '/bridge/next') {
        const job = takeJob();
        if (job) return send(res, 200, job);
        // Long-poll up to 25s so replies feel instant without hammering the server.
        const waiter = { res };
        waiter.timer = setTimeout(() => {
          bridgeWaiters = bridgeWaiters.filter((w) => w !== waiter);
          send(res, 204, '');
        }, 25 * 1000);
        req.on('close', () => {
          clearTimeout(waiter.timer);
          bridgeWaiters = bridgeWaiters.filter((w) => w !== waiter);
        });
        bridgeWaiters.push(waiter);
        return;
      }

      if (req.method === 'POST' && p === '/bridge/reply') {
        const body = await readJson(req, 512 * 1024);
        const m = findMessage(String(body.id || ''));
        if (!m || m.role !== 'user') return send(res, 404, { error: 'Unknown message.' });
        m.status = 'done';
        touch(m);
        const isErr = Boolean(body.error);
        addMessage({
          id: crypto.randomUUID(),
          conv: m.conv,
          role: isErr ? 'error' : 'assistant',
          text: String(isErr ? body.error : body.text || '(empty reply)').slice(0, 100000),
          model: String(body.modelUsed || '').slice(0, 120),
          replyTo: m.id,
        });
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'Not found.' });
    }

    return send(res, 404, 'Not found');
  } catch (err) {
    console.error('request error', p, err.message);
    if (!res.headersSent) send(res, 400, { error: 'Bad request.' });
  }
});

server.listen(PORT, () => console.log(`ai-BOT relay listening on :${PORT}`));
