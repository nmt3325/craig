#!/usr/bin/env bash
# Docker entrypoint for Craig (Oracle A1 ARM64)
set -euo pipefail

# cook.sh uses `at` for temporary-directory cleanup scheduling.
service atd start 2>/dev/null || true

# Activate the nvm-managed Node.js installed by install.sh.
# shellcheck source=/dev/null
source /root/.nvm/nvm.sh
nvm use node

# Load application configuration (DISCORD_BOT_TOKEN, DB credentials, etc.)
# shellcheck source=/dev/null
source /app/install.config

# Override DB host to the docker-compose postgres service.
export DATABASE_URL="postgresql://${POSTGRESQL_USER}:${POSTGRESQL_PASSWORD}@db:5432/${DATABASE_NAME}?schema=public"

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
