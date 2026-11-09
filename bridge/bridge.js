// Runs on the shop PC. Pulls queued phone messages from the Railway relay,
// hands them to the local OpenClaw bot, and posts the replies back.
// Only makes OUTBOUND requests — nothing on this PC is exposed to the internet.
//
// Config: bridge/.env  (RELAY_URL=..., BRIDGE_TOKEN=...)

'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------- config ----------
function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}
const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };
const RELAY_URL = (env.RELAY_URL || '').replace(/\/+$/, '');
const BRIDGE_TOKEN = env.BRIDGE_TOKEN || '';
const OPENCLAW = env.OPENCLAW_BIN || 'openclaw';
const AGENT_ID = env.OPENCLAW_AGENT || 'main';
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

// Only these models can be chosen from the phone. Anything else uses the bot's default (free).
const MODEL_MAP = { free: null, chatgpt: 'openai/gpt-6-astra' };

if (!RELAY_URL.startsWith('https://') || BRIDGE_TOKEN.length < 32) {
  console.error('Set RELAY_URL (https://...) and BRIDGE_TOKEN in bridge/.env');
  process.exit(1);
}

const LOG_FILE = path.join(__dirname, 'bridge.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { Authorization: `Bearer ${BRIDGE_TOKEN}` };

// ---------- OpenClaw ----------
function runAgent(job) {
  return new Promise((resolve) => {
    if (!/^[a-f0-9]{16}$/.test(job.conv)) return resolve({ error: 'Bad conversation id.' });
    const args = ['agent', '--agent', AGENT_ID, '--session-id', `phone-${job.conv}`, '-m', job.text, '--json'];
    const model = MODEL_MAP[job.model];
    if (model) args.push('--model', model);

    execFile(OPENCLAW, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      let out;
      try {
        const start = stdout.indexOf('{');
        out = JSON.parse(stdout.slice(start));
      } catch {
        return resolve({ error: err ? `Bot error: ${err.killed ? 'timed out' : err.message.split('\n')[0]}` : 'Could not read the bot reply.' });
      }
      const text = (out.result?.payloads || []).map((p) => p.text).filter(Boolean).join('\n\n');
      const modelUsed = out.result?.meta?.agentMeta?.model || '';
      if (out.status !== 'ok' && !text) return resolve({ error: `Bot error: ${out.summary || out.status}` });
      resolve({ text: text || '(no text reply)', modelUsed });
    });
  });
}

// ---------- relay loop ----------
async function main() {
  log(`bridge started → ${RELAY_URL}`);
  let backoff = 2000;
  for (;;) {
    try {
      const r = await fetch(`${RELAY_URL}/bridge/next`, { headers, signal: AbortSignal.timeout(40000) });
      if (r.status === 204) { backoff = 2000; continue; }
      if (r.status === 401) { log('relay rejected BRIDGE_TOKEN — check bridge/.env'); await sleep(60000); continue; }
      if (!r.ok) throw new Error(`relay HTTP ${r.status}`);
      const job = await r.json();
      log(`job ${job.id} (${job.model}) received`);
      const result = await runAgent(job);
      log(`job ${job.id} ${result.error ? 'failed: ' + result.error : 'done'}`);
      await fetch(`${RELAY_URL}/bridge/reply`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, ...result }),
        signal: AbortSignal.timeout(30000),
      });
      backoff = 2000;
    } catch (e) {
      log(`relay error: ${e.message}; retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

main();
