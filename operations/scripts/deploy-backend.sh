#!/usr/bin/env bash
set -Eeuo pipefail

compose_file="${INTLY_COMPOSE_FILE:-compose.yaml}"
env_file="${INTLY_DEPLOY_ENV_FILE:-.env}"
project_name="${COMPOSE_PROJECT_NAME:-intly-backend}"
image_ref="${INTLY_BACKEND_IMAGE:-}"
minio_image_ref="${MINIO_IMAGE:-}"
live_url="${INTLY_HEALTH_LIVE_URL:-http://127.0.0.1:3001/api/v1/health/live}"
ready_url="${INTLY_HEALTH_READY_URL:-http://127.0.0.1:3001/api/v1/health/ready}"
health_timeout_seconds="${INTLY_HEALTH_TIMEOUT_SECONDS:-120}"
compose_wait_timeout_seconds="${INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS:-600}"

usage() {
  cat <<'USAGE'
Usage:
  INTLY_BACKEND_IMAGE=ghcr.io/owner/intly-backend:<commit-sha> MINIO_IMAGE=ghcr.io/owner/intly-backend/minio:<commit-sha> operations/scripts/deploy-backend.sh

Required:
  INTLY_BACKEND_IMAGE must be an immutable commit SHA tag or digest. Do not use latest, main, master, dev, staging, production, or local tags.
  MINIO_IMAGE must be an immutable commit SHA tag or digest for the source-built MinIO runtime.

Optional:
  INTLY_DEPLOY_ENV_FILE=.env
  INTLY_COMPOSE_FILE=compose.yaml
  COMPOSE_PROJECT_NAME=intly-backend
  INTLY_HEALTH_LIVE_URL=http://127.0.0.1:3001/api/v1/health/live
  INTLY_HEALTH_READY_URL=http://127.0.0.1:3001/api/v1/health/ready
  INTLY_HEALTH_TIMEOUT_SECONDS=120
  INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS=600
  COMPOSE_PROFILES=firecrawl,embedding   # production-managed sidecars; set empty when using external endpoints
USAGE
}

fail() {
  echo "deploy-backend: $*" >&2
  exit 1
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

[[ -n "$image_ref" ]] || { usage >&2; fail "INTLY_BACKEND_IMAGE is required"; }
[[ -n "$minio_image_ref" ]] || { usage >&2; fail "MINIO_IMAGE is required"; }
[[ -f "$compose_file" ]] || fail "compose file not found: $compose_file"
[[ -f "$env_file" ]] || fail "environment file not found: $env_file"
[[ "$health_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || fail "INTLY_HEALTH_TIMEOUT_SECONDS must be a positive integer"
[[ "$compose_wait_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || fail "INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS must be a positive integer"

sha_tag_regex=':[0-9a-fA-F]{40}$'
digest_regex='@sha256:[0-9a-fA-F]{64}$'
validate_immutable_image_ref() {
  local name="$1"
  local ref="$2"
  case "$ref" in
    *:latest|*:main|*:master|*:dev|*:staging|*:production|*:local|*:ci-config)
      fail "$name must be an immutable SHA tag or digest, got: $ref"
      ;;
  esac
  if [[ ! "$ref" =~ $digest_regex && ! "$ref" =~ $sha_tag_regex ]]; then
    fail "$name must end with a 40-hex commit SHA tag or use a sha256 digest"
  fi
}

validate_immutable_image_ref INTLY_BACKEND_IMAGE "$image_ref"
validate_immutable_image_ref MINIO_IMAGE "$minio_image_ref"

compose=(docker compose --env-file "$env_file" -f "$compose_file" -p "$project_name")

echo "Validating compose configuration for project $project_name"
"${compose[@]}" config --quiet

echo "Pulling active Compose services for project $project_name"
INTLY_BACKEND_IMAGE="$image_ref" MINIO_IMAGE="$minio_image_ref" "${compose[@]}" pull

echo "Starting active Compose services for project $project_name"
INTLY_BACKEND_IMAGE="$image_ref" MINIO_IMAGE="$minio_image_ref" "${compose[@]}" up -d --no-build --wait --wait-timeout "$compose_wait_timeout_seconds"

wait_for_url() {
  local name="$1"
  local url="$2"
  local deadline=$((SECONDS + health_timeout_seconds))
  until curl --connect-timeout 2 --max-time 5 -fsS "$url" >/dev/null; do
    if (( SECONDS >= deadline )); then
      INTLY_BACKEND_IMAGE="$image_ref" MINIO_IMAGE="$minio_image_ref" "${compose[@]}" ps >&2 || true
      fail "$name health check did not pass before ${health_timeout_seconds}s: $url"
    fi
    sleep 3
  done
}

wait_for_url live "$live_url"
wait_for_url ready "$ready_url"

echo "Backend deployment is healthy: $image_ref"
