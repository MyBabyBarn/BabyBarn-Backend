#!/usr/bin/env bash
# One-time Ubuntu bootstrap for MyBABY BARN staging on AWS (separate EC2).
# Isolates staging from production EC2 (13.218.44.12). Safe to re-run.
# See docs/STAGING-AWS.md
set -euo pipefail

ORG="${GITHUB_ORG:-MyBabyBarn}"
BRANCH="${BRANCH:-stg}"
BASE="${STG_BASE:-/var/www}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates nginx ufw

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

mkdir -p "$BASE"
clone_or_update() {
  local name="$1"
  local dir="$BASE/$name"
  if [[ -d "$dir/.git" ]]; then
    git -C "$dir" fetch origin "$BRANCH" || true
    git -C "$dir" checkout "$BRANCH" || git -C "$dir" checkout -B "$BRANCH"
    git -C "$dir" reset --hard "origin/$BRANCH" || true
  else
    git clone -b "$BRANCH" "https://github.com/${ORG}/${name}.git" "$dir" \
      || git clone "https://github.com/${ORG}/${name}.git" "$dir"
    git -C "$dir" checkout -B "$BRANCH" "origin/$BRANCH" 2>/dev/null \
      || git -C "$dir" checkout -B "$BRANCH"
  fi
}

clone_or_update BabyBarn-Backend
clone_or_update BabyBarn-Frontend
clone_or_update BabyBarn-Admin

chmod +x "$BASE"/BabyBarn-Backend/deploy/stg/*.sh 2>/dev/null || true

ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

echo ""
echo "Bootstrap done under $BASE"
echo "Next:"
echo "  cp $BASE/BabyBarn-Backend/.env.stg.example $BASE/BabyBarn-Backend/.env"
echo "  cp $BASE/BabyBarn-Admin/.env.stg.example $BASE/BabyBarn-Admin/.env"
echo "  cp $BASE/BabyBarn-Frontend/.env.stg.example $BASE/BabyBarn-Frontend/.env"
echo "  # edit each .env with STAGING secrets only"
echo "  bash $BASE/BabyBarn-Backend/deploy/stg/deploy-all-stg.sh"
