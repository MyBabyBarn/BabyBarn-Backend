#!/usr/bin/env bash
set -euo pipefail
BASE="${STG_BASE:-/var/www}"
APP="$BASE/BabyBarn-Frontend"
cd "$APP"
[[ -f .env ]] || { echo "Missing $APP/.env"; exit 1; }
npm ci
npm run build
pm2 delete babybarn-stg-store >/dev/null 2>&1 || true
pm2 start "$BASE/BabyBarn-Backend/deploy/stg/ecosystem.stg.config.cjs" --only babybarn-stg-store
pm2 save
echo "OK babybarn-stg-store"
