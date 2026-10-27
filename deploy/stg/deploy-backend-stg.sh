#!/usr/bin/env bash
set -euo pipefail
BASE="${STG_BASE:-/var/www}"
APP="$BASE/BabyBarn-Backend"
cd "$APP"
[[ -f .env ]] || { echo "Missing $APP/.env"; exit 1; }
npm ci
npx prisma generate
npx prisma migrate deploy
pm2 delete babybarn-stg-api >/dev/null 2>&1 || true
pm2 start "$APP/deploy/stg/ecosystem.stg.config.cjs" --only babybarn-stg-api
pm2 save
echo "OK babybarn-stg-api"
