# INTLY backend deployment

Pushes to `main` run frozen install, typecheck, lint, full tests, build, OpenAPI, delivery contract and SSH gateway tests. Successful verification publishes backend and MinIO images, then deploys over SSH. Pull requests verify without production secrets. Manual `deploy=true` runs use the same gates from `main`.

Images are `ghcr.io/somemedic/intly-backend:<40-hex-SHA>` and `ghcr.io/somemedic/intly-backend/minio:<40-hex-SHA>`. GitHub-hosted Ubuntu handles CI, with Docker build caches in Actions.

## Server contract

Initial provisioning installs `operations/scripts/github-deploy.py` as `/opt/intly/bin/github-deploy`, and `backup-netcup.py` as `/opt/intly/bin/backup-netcup`. Host tools are updated explicitly during infrastructure maintenance.

Each repository has a separate root SSH key restricted in `authorized_keys`:

```text
restrict,command="/opt/intly/bin/github-deploy backend" ssh-ed25519 PUBLIC_KEY
```

Configure secret `DEPLOY_SSH_KEY` and variables `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_KNOWN_HOSTS`. Pin the host key obtained through an authenticated connection. The GitHub `production` environment permits automatic deployments only from `main`.

The request is exactly `deploy <40-hex-SHA>`. Stdin contains a short-lived package-read GitHub token, then a tracked-source tar archive. The gateway rejects private ENV files, generated directories, unsafe paths and links. Registry credentials use a temporary Docker configuration removed after the request.

Runtime secrets stay in `/opt/intly/secrets/backend.env`, mode 600. Releases live under `/opt/intly/releases/backend/<SHA>-<unique-suffix>`, each with `production.override.json` containing resolved image IDs. Persistent service images stay pinned. `/opt/intly/current/backend` points to the last healthy release.

A global lock serializes both deployments and backups. The gateway validates Compose, starts services without rebuilding or pulling mutable dependencies, waits up to 600 seconds for services and verifies live/ready endpoints. It promotes the pointer after readiness. Failed startup or health checks trigger the previous release; persistent data is retained.

## Services and inspection

The stack includes API, worker, MongoDB replica set, Redis, Meilisearch, MinIO, Firecrawl API/Playwright/Redis/RabbitMQ/NuQ Postgres, and local embeddings. Profiles are `firecrawl,embedding`. Set `SOURCE_SCHEDULER_ENABLED=true` in the host ENV for recurring source collection.

```sh
/opt/intly/bin/backend-compose config --quiet
/opt/intly/bin/backend-compose ps
/opt/intly/bin/backend-compose logs --tail 100 api worker
curl -fsS http://127.0.0.1:3001/api/v1/health/live
curl -fsS http://127.0.0.1:3001/api/v1/health/ready
```

Only SSH and Nginx ports 80/443 are public. App ports bind to loopback; state and sidecars use private Docker networks. Ubuntu 22.04 production Nginx uses `listen 443 ssl http2;`; run `nginx -t` before reload. Certbot renews TLS.

For an independent manually provisioned host, `operations/scripts/deploy-backend.sh` remains available with immutable `INTLY_BACKEND_IMAGE`, `MINIO_IMAGE` and external `INTLY_DEPLOY_ENV_FILE`. CI uses the gateway.

## Backups and administrator

Encrypted Restic backups run daily at 03:15 in the server timezone, retaining 7 daily, 4 weekly and 3 monthly copies. The wrapper reads both current release pointers and includes database, files, private ENV and deployment config. Keep the separately provisioned Restic key outside the server for recovery. See [backup and restore](backup-restore.md).

Create the first administrator through [production bootstrap](admin-bootstrap.md). Change the temporary password through ordinary authentication before use.
