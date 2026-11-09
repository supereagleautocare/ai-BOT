#!/usr/bin/env node
// `gog` as the bot sees it. Wraps the real Google CLI (/opt/gog/gog):
//   1. Every command first runs with --readonly: reads work, any change is blocked by gog itself.
//   2. If gog blocked a change, we get a --dry-run description, send it to the owner's phone
//      (ai-BOT relay, private network) and wait for Approve / Deny.
//   3. Only on Approve does the command run for real.
// Auth/setup commands are not available to the bot at all.

import { spawn } from 'node:child_process';

const REAL = process.env.GOG_REAL_BIN || '/opt/gog/gog';
const RELAY = (process.env.APPROVAL_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.APPROVAL_TOKEN || '';
const WAIT_MS = 10 * 60 * 1000;
const BLOCKED = 'request blocked by --readonly';

const args = process.argv.slice(2);

// Outgoing mail goes out as the bot's group address (e.g. ai@...) unless --from was given.
const DEFAULT_FROM = process.env.GOG_DEFAULT_FROM || '';
{
  const pos = args.filter((a) => !a.startsWith('-'));
  const isSend = pos[0] === 'gmail' && (pos[1] === 'send' || (pos[1] === 'drafts' && pos[2] === 'create'));
  if (DEFAULT_FROM && isSend && !args.some((a) => a === '--from' || a.startsWith('--from='))) args.push(`--from=${DEFAULT_FROM}`);
}
const FORBIDDEN = new Set(['auth', 'config', 'mcp', 'login', 'logout']);
// Flags that would weaken the safety wrapper if the bot passed them itself.
const STRIP = new Set(['--readonly', '-n', '--dry-run', '--access-token', '--enable-commands', '--disable-commands', '--enable-commands-exact', '--home', '--client']);

const firstCmd = args.find((a) => !a.startsWith('-'));
if (firstCmd && FORBIDDEN.has(firstCmd)) {
  console.error(`gog ${firstCmd} is managed by the owner, not the bot.`);
  process.exit(2);
}
for (const a of args) {
  const flag = a.split('=')[0];
  if (STRIP.has(flag)) {
    console.error(`The flag ${flag} is not allowed here. Run the command without it; changes are approved by the owner automatically.`);
    process.exit(2);
  }
}

function run(extra, { capture = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(REAL, [...extra, ...args], { stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', env: process.env });
    let out = '';
    let err = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
    }
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    child.on('error', (e) => resolve({ code: 1, out: '', err: String(e) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askOwner(summary) {
  if (!RELAY || TOKEN.length < 32) return { decision: 'unavailable' };
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  let id;
  try {
    const r = await fetch(`${RELAY}/internal/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool: 'Google', command: `gog ${args.join(' ')}`.slice(0, 4000), summary: summary.slice(0, 6000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { decision: 'unavailable' };
    id = (await r.json()).id;
  } catch {
    return { decision: 'unavailable' };
  }
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const r = await fetch(`${RELAY}/internal/approvals/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(10000) });
      if (r.status === 404) return { decision: 'unavailable' };
      const j = await r.json();
      if (j.status === 'approved' || j.status === 'denied') return { decision: j.status };
    } catch {
      /* keep waiting through brief network blips */
    }
  }
  try {
    await fetch(`${RELAY}/internal/approvals/${encodeURIComponent(id)}/expire`, { method: 'POST', headers, signal: AbortSignal.timeout(10000) });
  } catch {}
  return { decision: 'timeout' };
}

// 1) Safe attempt.
const safe = await run(['--readonly', '--wrap-untrusted', '--no-input']);
if (!(safe.code !== 0 && safe.err.includes(BLOCKED))) {
  process.stdout.write(safe.out);
  process.stderr.write(safe.err);
  process.exit(safe.code);
}

// 2) It's a change. Describe it and ask the owner.
const dry = await run(['--dry-run', '--no-input']);
const summary = (dry.out || dry.err || '').trim() || `gog ${args.join(' ')}`;
console.error('This changes something in Google, so it needs the owner\'s approval on their phone. Waiting up to 10 minutes…');
const { decision } = await askOwner(summary);

if (decision === 'approved') {
  const real = await run(['--no-input', '--force'], { capture: false });
  process.exit(real.code);
}
const why = {
  denied: 'The owner DENIED this action. It was not done. Do not retry unless they ask.',
  timeout: 'No approval within 10 minutes, so it was not done. Tell the owner it is waiting on them.',
  unavailable: 'The approval system is unreachable, so it was not done.',
}[decision];
console.error(why);
process.exit(1);
