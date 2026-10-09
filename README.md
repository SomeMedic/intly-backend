# INTLY Backend

NestJS API and background workers for shared job, freelance and tender collection, search, AI analysis and personal workspaces. The frontend lives in [intly-frontend](https://github.com/SomeMedic/intly-frontend).

Use Node.js 22 and pnpm 10.11.0. Copy `.env.example` to `.env` and configure local services before starting the API.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm openapi
```

Pushes to `main` run checks, publish immutable backend and MinIO images to GHCR, and deploy to production over a restricted SSH key. Production secrets and persistent data stay on the server. See [deployment](operations/runbooks/deployment.md), [admin bootstrap](operations/runbooks/admin-bootstrap.md) and [backup and restore](operations/runbooks/backup-restore.md).
