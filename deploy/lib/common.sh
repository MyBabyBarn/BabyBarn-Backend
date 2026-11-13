#!/usr/bin/env bash
# Shared EC2 deploy helpers (Ubuntu). Source from deploy/*.sh — do not run directly.
set -euo pipefail

: "${DEPLOY_APP_NAME:=app}"
: "${DEPLOY_PM2_NAME:=app}"
: "${DEPLOY_PORT:=5000}"
: "${DEPLOY_TYPE:=backend}"
: "${DEPLOY_LEGACY_PM2_NAME:=}"
: "${DEPLOY_GIT_BRANCH:=master}"
: "${DEPLOY_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

DEPLOY_ROLLBACK_FILE="${DEPLOY_ROOT}/.deploy-rollback"
DEPLOY_LAST_SUCCESS_FILE="${DEPLOY_ROOT}/.deploy-last-success"

configure_deploy() {
  DEPLOY_APP_NAME="$1"
  DEPLOY_PM2_NAME="$2"
  DEPLOY_PORT="$3"
  DEPLOY_TYPE="${4:-backend}"
  DEPLOY_LEGACY_PM2_NAME="${5:-}"
  DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  DEPLOY_ROLLBACK_FILE="${DEPLOY_ROOT}/.deploy-rollback"
  DEPLOY_LAST_SUCCESS_FILE="${DEPLOY_ROOT}/.deploy-last-success"
}

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

require_env_file() {
  if [[ ! -f "${DEPLOY_ROOT}/.env" ]]; then
    echo "ERROR: ${DEPLOY_ROOT}/.env is missing."
    echo "Copy .env.example to .env on the server only (never commit .env)."
    exit 1
  fi
}

validate_production_env() {
  case "${DEPLOY_TYPE}" in
    nextjs)
      local api_url
      api_url="$(grep -E '^NEXT_PUBLIC_API_URL=' "${DEPLOY_ROOT}/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)"
      if [[ -n "$api_url" ]] && echo "$api_url" | grep -qiE 'localhost|127\.0\.0\.1'; then
        log "WARN: NEXT_PUBLIC_API_URL is localhost — client will use /api proxy; set http://YOUR_HOST:5000/api for clarity"
      fi
      ;;
    backend)
      local cors_blob
      cors_blob="$(grep -E '^(CORS_ORIGIN|FRONTEND_USER_URLS|FRONTEND_ADMIN_URLS)=' "${DEPLOY_ROOT}/.env" 2>/dev/null || true)"
      if [[ -z "$cors_blob" ]] || ! echo "$cors_blob" | grep -qvE 'localhost|127\.0\.0\.1'; then
        echo "ERROR: Backend .env must allow production frontends in CORS_ORIGIN (e.g. http://YOUR_IP:3000,http://YOUR_IP:3001)"
        exit 1
      fi
      ;;
  esac
}

git_sync_readonly() {
  cd "${DEPLOY_ROOT}"
  log "Git sync (${DEPLOY_GIT_BRANCH}) — fetch + reset (no pull, no merge)"
  local before
  before="$(git rev-parse HEAD)"
  echo "${before}" > "${DEPLOY_ROLLBACK_FILE}"

  git fetch origin "${DEPLOY_GIT_BRANCH}"
  git checkout -B "${DEPLOY_GIT_BRANCH}" "origin/${DEPLOY_GIT_BRANCH}"
  git reset --hard "origin/${DEPLOY_GIT_BRANCH}"
  git clean -fd -e .env -e .env.* -e uploads || true

  log "Now at $(git rev-parse --short HEAD) ($(git log -1 --pretty=%s))"
}

ensure_swap() {
  # Small EC2 boxes often OOM-kill `npm ci` / Next builds without swap.
  if swapon --show 2>/dev/null | grep -q .; then
    return 0
  fi
  if [[ -f /swapfile ]]; then
    log "Enabling existing /swapfile"
    sudo swapon /swapfile || true
    return 0
  fi
  log "Creating 2G swapfile (npm ci / next build need headroom)"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
}

install_dependencies() {
  cd "${DEPLOY_ROOT}"
  ensure_swap
  log "Free memory before npm ci"
  free -h || true
  log "npm ci"
  npm ci --no-audit --no-fund
}

build_app() {
  cd "${DEPLOY_ROOT}"
  case "${DEPLOY_TYPE}" in
    nextjs)
      log "next build"
      npm run build
      ;;
    backend)
      log "prisma generate + migrate deploy"
      npx prisma generate
      npx prisma migrate deploy
      # Idempotent: creates the 4 design homepage slides when the table is empty
      log "seed homepage carousel (skip if slides already exist)"
      npm run seed:homepage-carousel || true
      ;;
    *)
      echo "Unknown DEPLOY_TYPE: ${DEPLOY_TYPE}"
      exit 1
      ;;
  esac
}

pm2_remove_legacy() {
  local legacy="${DEPLOY_LEGACY_PM2_NAME:-}"
  if [[ -z "$legacy" ]] || ! command -v pm2 >/dev/null 2>&1; then
    return 0
  fi
  if pm2 describe "$legacy" >/dev/null 2>&1; then
    log "Removing legacy PM2 app '${legacy}' (frees port ${DEPLOY_PORT})"
    pm2 delete "$legacy" || true
  fi
}

pm2_reload() {
  cd "${DEPLOY_ROOT}"
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "WARN: pm2 not installed. Install: sudo npm install -g pm2"
    return 1
  fi
  export PORT="${DEPLOY_PORT}"
  if pm2 describe "${DEPLOY_PM2_NAME}" >/dev/null 2>&1; then
    log "pm2 restart ${DEPLOY_PM2_NAME}"
    pm2 restart "${DEPLOY_PM2_NAME}" --update-env
  else
    log "pm2 start ecosystem.config.cjs"
    pm2 start ecosystem.config.cjs --env production
    pm2 save
  fi
  pm2 status "${DEPLOY_PM2_NAME}"
}

health_hint() {
  case "${DEPLOY_TYPE}" in
    nextjs) log "Listen: http://127.0.0.1:${DEPLOY_PORT}" ;;
    backend) log "Health: curl -s http://127.0.0.1:${DEPLOY_PORT}/health" ;;
  esac
}

on_deploy_failure() {
  log "Deploy failed — attempting rollback to ${DEPLOY_ROLLBACK_FILE}"
  if [[ -f "${DEPLOY_ROLLBACK_FILE}" ]]; then
    local rev
    rev="$(cat "${DEPLOY_ROLLBACK_FILE}")"
    cd "${DEPLOY_ROOT}"
    git reset --hard "${rev}"
    build_app || true
    pm2_reload || true
    log "Rolled back to ${rev}"
  fi
  exit 1
}

run_deploy() {
  trap on_deploy_failure ERR
  cd "${DEPLOY_ROOT}"
  log "=== Deploy ${DEPLOY_APP_NAME} ==="
  require_env_file
  validate_production_env
  git_sync_readonly
  install_dependencies
  build_app
  pm2_remove_legacy
  pm2_reload
  git rev-parse HEAD > "${DEPLOY_LAST_SUCCESS_FILE}"
  health_hint
  trap - ERR
  log "=== Deploy complete ==="
}

run_rollback() {
  cd "${DEPLOY_ROOT}"
  if [[ ! -f "${DEPLOY_LAST_SUCCESS_FILE}" ]]; then
    echo "No ${DEPLOY_LAST_SUCCESS_FILE} — nothing to roll back to."
    exit 1
  fi
  local rev
  rev="$(cat "${DEPLOY_LAST_SUCCESS_FILE}")"
  log "Rollback to last successful deploy: ${rev}"
  git reset --hard "${rev}"
  install_dependencies
  build_app
  pm2_reload
  log "Rollback complete"
}
