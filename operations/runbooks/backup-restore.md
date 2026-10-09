# INTLY backend backup and restore runbook

Backups are server-side Restic snapshots. They include an application-consistent `mongodump`, MinIO volume tar, and deployment config copies. They do not copy live MongoDB data files.

## Required secrets

- `RESTIC_REPOSITORY`
- `RESTIC_PASSWORD_FILE`
- `MONGO_ROOT_PASSWORD`
- Optional retention: `RESTIC_KEEP_DAILY`, `RESTIC_KEEP_WEEKLY`, `RESTIC_KEEP_MONTHLY`

## Backup cron example

Run as root or a dedicated backup user that can read the Restic password file and access Docker:

```cron
15 3 * * * cd /opt/intly/intly-backend && RESTIC_REPOSITORY=... RESTIC_PASSWORD_FILE=/root/.secrets/intly-restic-password MONGO_ROOT_PASSWORD=... ./scripts/backup-restic.sh >> /var/log/intly-backup.log 2>&1
```

## Admin backup history

The backup script writes atomic JSON receipts into `BACKUP_STATUS_DIRECTORY` (default `/var/backups/intly/status`). API and worker mount this host directory read-only; the backup user needs write access. The admin Infrastructure → Backups tab shows the real Running/Succeeded/Failed result, duration, Restic snapshot ID and repository snapshot count when available. Unconfigured storage or unreadable receipts are shown explicitly; an empty history does not prove a successful backup.

Set `BACKUP_REPOSITORY_LABEL` to a human-readable label without credentials and `BACKUP_CRON_SCHEDULE` to the schedule actually installed on the server. This value documents the installed cron; it does not create a scheduled job. The application has no restore action. Use the procedure below for a separately named isolated target or an explicitly authorized incident restore.

## Restore drill

1. Restore files only:
   ```bash
   RESTIC_REPOSITORY=... RESTIC_PASSWORD_FILE=/root/.secrets/intly-restic-password SNAPSHOT=latest ./scripts/restore-restic.sh
   ```
2. Inspect the restored `intly.archive.gz` and `minio-data.tar` under `/var/backups/intly/restore`.
3. Apply to an isolated compose project only:
   ```bash
   COMPOSE_PROJECT_NAME=intly-restore APPLY_RESTORE=yes RESTIC_REPOSITORY=... RESTIC_PASSWORD_FILE=/root/.secrets/intly-restic-password MONGO_ROOT_PASSWORD=... ./scripts/restore-restic.sh
   ```
4. Start API/worker against the isolated restored stack, run `/health/ready`, search rebuild, file download smoke, and a queue counts check.

Never run destructive restore into production unless an incident commander has explicitly approved the target snapshot and downtime window.

## Local acceptance rehearsal

Use the local rehearsal before relying on the operational scripts on a new host:

```bash
node intly-backend/scripts/verify-backup-restore.mjs
```

The rehearsal refuses production `NODE_ENV`, creates temporary credentials with mode `600`, starts two isolated `mongod` processes on loopback-only random ports, seeds a QA document, runs a real `mongodump`, restores the backup artifact, imports it with `mongorestore` into the second isolated MongoDB, and compares the restored document plus file checksums. It does not read from or write to the running application MongoDB, MinIO, Docker volumes, or remote storage. It writes the secret-free result to `.local/reports/backup-restore.json` and removes its temporary dbpaths, archives, repository, and password file.

When `restic` is installed on `PATH` or `.local/bin/restic`, the rehearsal initializes a local temporary Restic repository, runs `restic backup`, `restic check`, and `restic restore`, then verifies the restored data. If `restic` is unavailable, it falls back to an encrypted local tar archive via `openssl` so the Mongo dump/restore and file checksum proof still run; the report records this as `mode: "encrypted-file-fallback"` and keeps the Restic gap explicit.

For local development, the verified standalone Restic binary is installed at `.local/vendor/restic/restic` and linked from `.local/bin/restic`. It is not a project dependency. If it must be refreshed, download the matching OS/architecture binary from the official `restic/restic` GitHub release, compare the downloaded archive SHA256 with the release asset checksum before extracting it, then rerun the local acceptance rehearsal.

Do not use `APPLY_RESTORE=yes` against the shared development or production compose project. File-only restore is the default safe mode; applying a restore is only for a separately named isolated compose project or an incident-approved production target.
