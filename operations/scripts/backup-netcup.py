#!/usr/bin/env python3
"""Deployment backup wrapper. Requires separately approved backup key provisioning."""
import os
import fcntl
import pathlib
import shutil
import subprocess
from datetime import datetime, timezone

# Serialize with deployments so one snapshot contains a consistent release pair.
lock = open('/opt/intly/operations/github-deploy.lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
backend = pathlib.Path('/opt/intly/current/backend').resolve(strict=True)
frontend = pathlib.Path('/opt/intly/current/frontend').resolve(strict=True)
env = dict(os.environ)
for line in pathlib.Path('/opt/intly/secrets/backend.env').read_text().splitlines():
    if line and not line.startswith('#'):
        key, value = line.split('=', 1)
        env[key] = value
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
staging = pathlib.Path('/var/backups/intly/staging') / stamp
(staging / 'config').mkdir(parents=True, mode=0o700)
shutil.copy2(backend / 'production.override.json', staging / 'config/backend.production.json')
shutil.copy2(frontend / 'production.override.json', staging / 'config/frontend.production.json')
shutil.copy2(frontend / 'compose.yaml', staging / 'config/frontend.compose.yaml')
for source in [pathlib.Path('/opt/intly/secrets/backend.env'), pathlib.Path('/opt/intly/secrets/frontend.env'),
               pathlib.Path('/etc/nginx/sites-available/intly.conf')]:
    shutil.copy2(source, staging / 'config' / source.name)
env.update(RESTIC_REPOSITORY='/var/backups/intly/restic', RESTIC_PASSWORD_FILE='/opt/intly/secrets/restic-password',
           RESTIC_KEEP_DAILY='7', RESTIC_KEEP_WEEKLY='4', RESTIC_KEEP_MONTHLY='3',
           RESTIC_CHECK_SUBSET='100%',
           BACKUP_REPOSITORY_LABEL='Local encrypted backup', STAGING_DIR=str(staging),
           INTLY_DEPLOY_ENV_FILE='/opt/intly/secrets/backend.env',
           COMPOSE_FILE=str(backend / 'compose.yaml'), COMPOSE_PROJECT_NAME='intly-backend')
try:
    subprocess.run([str(backend / 'scripts/backup-restic.sh')], cwd=backend, env=env, check=True)
finally:
    pathlib.Path('/var/backups/intly/status').chmod(0o755)
