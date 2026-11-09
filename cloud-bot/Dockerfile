# OpenClaw gateway for Railway. Private-network only (no public domain).
FROM ghcr.io/openclaw/openclaw:2026.11.2

USER root

# Google Workspace CLI (gog), checksum-pinned. The real binary lives outside PATH;
# the bot only sees the approval wrapper installed as `gog`.
ARG GOG_VERSION=0.48.0
ARG GOG_SHA256=8809d2f4fe95a0299b1a2a5c6bc912c4aba4b90a7b5e2c1f5cf11b9945a50004
RUN set -eux; \
    cd /tmp; \
    node -e "fetch('https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_amd64.tar.gz').then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('gog.tgz',Buffer.from(b)))"; \
    echo "${GOG_SHA256}  gog.tgz" | sha256sum -c -; \
    mkdir -p /opt/gog; tar -xzf gog.tgz -C /opt/gog ./gog; rm gog.tgz; \
    chmod 0755 /opt/gog/gog; /opt/gog/gog --version
COPY --chown=root:root gog-approve.mjs /usr/local/bin/gog
RUN chmod 0755 /usr/local/bin/gog

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
    OPENCLAW_DISABLE_BONJOUR=1 \
    GOG_HOME=/home/node/.openclaw/gog

# Starts as root only to fix volume ownership, then drops to the 'node' user.
ENTRYPOINT ["tini", "-s", "--", "sh", "/app/railway-start.sh"]
