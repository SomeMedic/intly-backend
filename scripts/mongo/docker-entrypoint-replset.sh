#!/usr/bin/env bash
set -euo pipefail

keyfile="/data/configdb/intly-mongo-keyfile"

if [[ ! -s "$keyfile" ]]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 756 | tr -d '\n' > "$keyfile"
  else
    head -c 756 /dev/urandom | base64 | tr -d '\n' > "$keyfile"
  fi
  printf '\n' >> "$keyfile"
fi

chmod 400 "$keyfile"
chown mongodb:mongodb "$keyfile" 2>/dev/null || true

exec docker-entrypoint.sh mongod --replSet intly-rs --bind_ip_all --keyFile "$keyfile"
