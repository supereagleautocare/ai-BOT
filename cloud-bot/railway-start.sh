#!/bin/sh
# Railway start script for the OpenClaw gateway.
# - Railway volumes mount as root, so fix ownership, then drop to the 'node' user.
# - Seed a starter config on first boot only (later edits on the volume are kept).
set -eu

STATE=/home/node/.openclaw

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STATE/workspace" "$STATE/.auth-secrets" /home/node/.config
  # Keep auth-profile secrets on the persistent volume too.
  if [ ! -L /home/node/.config/openclaw ]; then
    rm -rf /home/node/.config/openclaw
    ln -s "$STATE/.auth-secrets" /home/node/.config/openclaw
  fi
  chown -R node:node "$STATE" /home/node/.config
  exec setpriv --reuid=node --regid=node --init-groups sh "$0" "$@"
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ] || [ "${#OPENCLAW_GATEWAY_TOKEN}" -lt 32 ]; then
  echo "OPENCLAW_GATEWAY_TOKEN (>=32 chars) must be set" >&2
  exit 1
fi

if [ ! -f "$STATE/openclaw.json" ]; then
  echo "First boot: seeding $STATE/openclaw.json"
  cp /app/openclaw.seed.json "$STATE/openclaw.json"
  chmod 600 "$STATE/openclaw.json"
fi

# Google Workspace CLI: store the OAuth client once (from a Railway variable), file keyring.
if [ -n "${GOG_CLIENT_SECRET_JSON:-}" ]; then
  mkdir -p "$GOG_HOME"
  umask 077
  tmp="$(mktemp)"
  printf '%s' "$GOG_CLIENT_SECRET_JSON" > "$tmp"
  /opt/gog/gog --no-input auth keyring file >/dev/null 2>&1 || true
  /opt/gog/gog --no-input auth credentials "$tmp" >/dev/null 2>&1 && echo "gog: OAuth client stored" || echo "gog: could not store OAuth client" >&2
  rm -f "$tmp"
fi

# Hand off to the image's own entrypoint so its state-repair logic still runs.
exec node /app/docker-entrypoint.mjs node /app/openclaw.mjs gateway --bind "${OPENCLAW_GATEWAY_BIND:-lan}" --port 18789
