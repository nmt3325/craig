#!/usr/bin/env bash
# Docker entrypoint for Craig (Oracle A1 ARM64)
set -euo pipefail

# cook.sh uses `at` for temporary-directory cleanup scheduling.
service atd start 2>/dev/null || true

# Activate the nvm-managed Node.js installed by install.sh.
# shellcheck source=/dev/null
source /root/.nvm/nvm.sh
nvm use node

# ── Regenerate per-app .env files from runtime environment variables ───────────
# The image was built with dummy values in install.config.build.
# Real secrets arrive here via docker-compose `environment:` / `env_file:`.
# dotenv does NOT override existing process.env, so these files are only a
# fallback for values not already set in the container environment — but
# writing them out ensures pm2-restarted child processes also pick them up.

cat > /app/apps/bot/.env <<EOF
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}
DISCORD_APP_ID=${DISCORD_APP_ID:-}
DEVELOPMENT_GUILD_ID=${DEVELOPMENT_GUILD_ID:-}
EOF

# prisma/.env — DATABASE_URL is also exported below, but write it here too
# so `yarn prisma:deploy` sees it even if invoked outside this script.
cat > /app/prisma/.env <<EOF
DATABASE_URL=${DATABASE_URL:-}
EOF

cat > /app/apps/dashboard/.env <<EOF
CLIENT_ID=${CLIENT_ID:-}
CLIENT_SECRET=${CLIENT_SECRET:-}
PATREON_CLIENT_ID=${PATREON_CLIENT_ID:-}
PATREON_CLIENT_SECRET=${PATREON_CLIENT_SECRET:-}
PATRON_TIER_MAP=${PATRON_TIER_MAP:-}
PATREON_WEBHOOK_SECRET=${PATREON_WEBHOOK_SECRET:-}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
MICROSOFT_CLIENT_ID=${MICROSOFT_CLIENT_ID:-}
MICROSOFT_CLIENT_SECRET=${MICROSOFT_CLIENT_SECRET:-}
DROPBOX_CLIENT_ID=${DROPBOX_CLIENT_ID:-}
DROPBOX_CLIENT_SECRET=${DROPBOX_CLIENT_SECRET:-}
APP_URI=${APP_URI:-http://localhost:3000}
JWT_SECRET=${JWT_SECRET:-}
EOF

cat > /app/apps/download/.env <<EOF
API_PORT=${API_PORT:-5029}
API_HOST=0.0.0.0
API_HOMEPAGE=${API_HOMEPAGE:-https://localhost:5029/}
ENNUIZEL_BASE=${ENNUIZEL_BASE:-https://ez.craig.horse/}
TRUST_PROXY=${TRUST_PROXY:-}
SENTRY_DSN=${SENTRY_DSN:-}
SENTRY_HOST=${SENTRY_HOST:-}
SENTRY_SAMPLE_RATE=${SENTRY_SAMPLE_RATE:-1.0}
SENTRY_DSN_API=${SENTRY_DSN_API:-}
SENTRY_ENV=${SENTRY_ENV:-}
SENTRY_SAMPLE_RATE_API=${SENTRY_SAMPLE_RATE_API:-1.0}
INFLUX_URL=${INFLUX_URL:-}
INFLUX_TOKEN=${INFLUX_TOKEN:-}
INFLUX_ORG=${INFLUX_ORG:-}
INFLUX_BUCKET=${INFLUX_BUCKET:-}
SERVER_NAME=${SERVER_NAME:-craig}
REDIS_HOST=${REDIS_HOST:-redis}
REDIS_PORT=${REDIS_PORT:-6379}
EOF

# ── Override DB host to the docker-compose postgres service ───────────────────
export DATABASE_URL="postgresql://${POSTGRESQL_USER:-craig}:${POSTGRESQL_PASSWORD:-craig}@db:5432/${DATABASE_NAME:-craig}?schema=public"

# Bind the download API to all interfaces inside the container.
export API_HOST=0.0.0.0

# NOTION_TOKEN is injected by docker-compose; default to empty string if unset.
export NOTION_TOKEN="${NOTION_TOKEN:-}"

cd /app

# Apply any pending database migrations.
yarn prisma:deploy

# Sync slash commands to Discord (non-fatal if it fails).
yarn run sync || true

# Start all services via pm2.
cd /app/apps/bot      && pm2 start ecosystem.config.js
cd /app/apps/dashboard && pm2 start ecosystem.config.js
cd /app/apps/download  && pm2 start ecosystem.config.js
cd /app/apps/tasks     && pm2 start ecosystem.config.js

pm2 save

# Stream all pm2 logs to stdout/stderr so `docker logs` works,
# and keep the container alive.
exec pm2 logs --raw
