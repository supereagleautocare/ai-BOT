#!/bin/sh
# Owner-run Google sign-in for the cloud bot (run via `railway ssh`).
#   sh /app/google-login.sh start you@domain.com      -> prints a Google link to open
#   sh /app/google-login.sh finish 'http://localhost/?...'  -> paste the address bar after clicking Allow
#   sh /app/google-login.sh status
set -eu

# `railway ssh` shells may not carry the service env; borrow it from the main process.
if [ -r /proc/1/environ ]; then
  for k in GOG_HOME GOG_KEYRING_PASSWORD GOG_KEYRING_BACKEND; do
    v="$(tr '\0' '\n' < /proc/1/environ | sed -n "s/^$k=//p" | head -n1)"
    [ -n "$v" ] && export "$k=$v"
  done
fi
export GOG_HOME="${GOG_HOME:-/home/node/.openclaw/gog}"

SERVICES="gmail,calendar,drive,docs,sheets,slides,contacts,people,tasks,forms,chat,analytics,searchconsole"
STATE_FILE="$GOG_HOME/.login-email"

gog_as_node() {
  if [ "$(id -u)" = "0" ]; then
    setpriv --reuid=node --regid=node --init-groups env GOG_HOME="$GOG_HOME" GOG_KEYRING_PASSWORD="${GOG_KEYRING_PASSWORD:-}" HOME=/home/node /opt/gog/gog "$@"
  else
    /opt/gog/gog "$@"
  fi
}

case "${1:-}" in
  start)
    email="${2:?usage: start you@domain.com}"
    printf '%s' "$email" > "$STATE_FILE"
    [ "$(id -u)" = "0" ] && chown node:node "$STATE_FILE"
    gog_as_node auth add "$email" --services "$SERVICES" --remote --step 1 --force-consent
    echo
    echo "Open the auth_url above, sign in, click Allow."
    echo "The next page will fail to load (localhost) - that's expected. Copy its full address, then run:"
    echo "  sh /app/google-login.sh finish '<paste address here>'"
    ;;
  finish)
    url="${2:?usage: finish '<redirect url>'}"
    email="$(cat "$STATE_FILE")"
    gog_as_node auth add "$email" --services "$SERVICES" --remote --step 2 --auth-url "$url" --force-consent
    gog_as_node auth list --check || true
    ;;
  status)
    gog_as_node auth list --check || true
    ;;
  *)
    echo "usage: sh /app/google-login.sh start you@domain.com | finish '<url>' | status" >&2
    exit 2
    ;;
esac
