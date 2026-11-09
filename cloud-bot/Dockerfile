# OpenClaw gateway for Railway. Private-network only (no public domain).
FROM ghcr.io/openclaw/openclaw:2026.11.2

USER root
COPY --chown=root:root railway-start.sh /app/railway-start.sh
COPY --chown=root:root openclaw.seed.json /app/openclaw.seed.json
RUN chmod 0755 /app/railway-start.sh

ENV HOME=/home/node \
    OPENCLAW_HOME=/home/node \
    OPENCLAW_STATE_DIR=/home/node/.openclaw \
    OPENCLAW_CONFIG_DIR=/home/node/.openclaw \
    OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace \
    OPENCLAW_GATEWAY_PORT=18789 \
    OPENCLAW_DISABLE_BONJOUR=1

# Starts as root only to fix volume ownership, then drops to the 'node' user.
ENTRYPOINT ["tini", "-s", "--", "sh", "/app/railway-start.sh"]
