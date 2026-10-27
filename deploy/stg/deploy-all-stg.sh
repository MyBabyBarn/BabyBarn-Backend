#!/usr/bin/env bash
set -euo pipefail
BASE="${STG_BASE:-/var/www}"
BRANCH="${BRANCH:-stg}"

pull() {
  local dir="$1"
  git -C "$dir" fetch origin "$BRANCH"
  git -C "$dir" checkout "$BRANCH"
  git -C "$dir" reset --hard "origin/$BRANCH"
}

pull "$BASE/BabyBarn-Backend"
pull "$BASE/BabyBarn-Frontend"
pull "$BASE/BabyBarn-Admin"

bash "$BASE/BabyBarn-Backend/deploy/stg/deploy-backend-stg.sh"
bash "$BASE/BabyBarn-Backend/deploy/stg/deploy-store-stg.sh"
bash "$BASE/BabyBarn-Backend/deploy/stg/deploy-admin-stg.sh"
pm2 status
echo "Staging deploy complete"
