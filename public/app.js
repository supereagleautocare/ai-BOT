'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function newConvId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

let conv = store.get('conv', '') || newConvId();
store.set('conv', conv);
let model = store.get('model', 'free');
let since = 0;
let pollTimer = null;
const rendered = new Map(); // id -> element

// ---------- login ----------
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('password').value }),
  });
  if (r.ok) { $('password').value = ''; showChat(); }
  else $('loginErr').textContent = (await r.json().catch(() => ({}))).error || 'Login failed.';
});

function showLogin() {
  clearTimeout(pollTimer);
  $('chat').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('password').focus();
}

function showChat() {
  $('login').classList.add('hidden');
  $('chat').classList.remove('hidden');
  resetLog();
  poll();
}

// ---------- model + target pickers ----------
let target = store.get('target', 'cloud');
let lastState = null;

function setModel(m) {
  model = m;
  store.set('model', m);
  document.querySelectorAll('#modelSeg button').forEach((b) => b.classList.toggle('active', b.dataset.model === m));
}
function setTarget(t) {
  target = t;
  store.set('target', t);
  document.querySelectorAll('#targetSeg button').forEach((b) => b.classList.toggle('active', b.dataset.target === t));
  if (lastState) showStatus(lastState);
}
document.querySelectorAll('#modelSeg button').forEach((b) => b.addEventListener('click', () => setModel(b.dataset.model)));
document.querySelectorAll('#targetSeg button').forEach((b) => b.addEventListener('click', () => setTarget(b.dataset.target)));
setModel(model);
setTarget(target);

function showStatus(s) {
  const cloud = target === 'cloud';
  const on = cloud ? s.cloudOnline : s.bridgeOnline;
  $('dot').classList.toggle('on', on);
  if (cloud && !s.cloudEnabled) $('status').textContent = 'Cloud bot not set up yet';
  else if (cloud) $('status').textContent = on ? 'Cloud bot online' : 'Cloud bot starting or down';
  else $('status').textContent = on ? 'PC online' : 'PC offline — messages will wait';
}

// ---------- new chat ----------
$('newBtn').addEventListener('click', () => {
  conv = newConvId();
  store.set('conv', conv);
  resetLog();
  poll();
});

// ---------- rendering ----------
function resetLog() {
  since = 0;
  rendered.clear();
  $('log').replaceChildren();
  renderEmpty();
}

function renderEmpty() {
  if ($('log').querySelector('.msg')) { $('log').querySelector('.empty')?.remove(); return; }
  if ($('log').querySelector('.empty')) return;
  const d = document.createElement('div');
  d.className = 'empty';
  const b = document.createElement('b');
  b.textContent = 'What should I do?';
  d.append(b, 'Your bot runs on your PC. "Free" uses the free model; switch to ChatGPT for harder jobs.');
  $('log').append(d);
}

function timeStr(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function upsert(m) {
  let el = rendered.get(m.id);
  if (!el) {
    el = document.createElement('div');
    el.className = `msg ${m.role}`;
    const body = document.createElement('div');
    body.className = 'body';
    const meta = document.createElement('div');
    meta.className = 'meta';
    el.append(body, meta);
    rendered.set(m.id, el);
    $('log').append(el);
  }
  el.querySelector('.body').textContent = m.text; // textContent: never render HTML from the bot
  let meta = timeStr(m.ts);
  if (m.role === 'user') {
    if (m.status === 'queued') meta += ' · waiting for PC';
    else if (m.status === 'working') meta += ' · working…';
    meta += m.target === 'pc' ? ' · 💻' : ' · ☁️';
    if (m.model === 'chatgpt') meta += ' · ChatGPT';
  } else if (m.model) meta += ` · ${m.model.split('/').pop()}`;
  el.querySelector('.meta').textContent = meta;
}

function updateTyping(msgs) {
  const busy = [...rendered.values()].some((el) => /working…|waiting for PC/.test(el.querySelector('.meta').textContent));
  let t = $('log').querySelector('.typing');
  if (busy && !t) {
    t = document.createElement('div');
    t.className = 'typing';
    t.textContent = 'Bot is thinking…';
    $('log').append(t);
  } else if (!busy && t) t.remove();
  else if (busy && t) $('log').append(t); // keep at bottom
}

// ---------- polling ----------
async function poll() {
  clearTimeout(pollTimer);
  try {
    const r = await fetch(`/api/state?since=${since}&conv=${conv}`);
    if (r.status === 401) return showLogin();
    const s = await r.json();
    const nearBottom = $('log').scrollHeight - $('log').scrollTop - $('log').clientHeight < 120;
    for (const m of s.messages) { upsert(m); since = Math.max(since, m.seq); }
    if (s.messages.length) { renderEmpty(); updateTyping(); if (nearBottom || since === 0) scrollDown(); }
    lastState = s;
    showStatus(s);
  } catch {
    $('status').textContent = 'Connection problem…';
  }
  pollTimer = setTimeout(poll, document.hidden ? 10000 : 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('chat').classList.contains('hidden')) poll(); });

function scrollDown() { $('log').scrollTop = $('log').scrollHeight; }

// ---------- sending ----------
const input = $('input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  $('sendBtn').disabled = true;
  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model, target, conv }),
    });
    if (r.status === 401) return showLogin();
    const j = await r.json();
    if (!r.ok) { alert(j.error || 'Could not send.'); return; }
    input.value = '';
    input.style.height = 'auto';
    await poll();
    scrollDown();
  } finally {
    $('sendBtn').disabled = false;
  }
});

// ---------- boot ----------
fetch(`/api/state?since=0&conv=${conv}`).then((r) => (r.status === 401 ? showLogin() : showChat())).catch(showLogin);
