import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { validateEnvironment } = require('../src/infrastructure/config.ts');

const required = {
  JWT_SECRET: 'config-contract-secret-with-at-least-thirty-two-chars',
  MASTER_ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
};

test('source scheduler flag is an explicit true/false delivery switch defaulting off', () => {
  assert.equal(validateEnvironment(required).SOURCE_SCHEDULER_ENABLED, 'false');
  assert.equal(validateEnvironment({ ...required, SOURCE_SCHEDULER_ENABLED: 'true' }).SOURCE_SCHEDULER_ENABLED, 'true');
  assert.equal(validateEnvironment({ ...required, SOURCE_SCHEDULER_ENABLED: 'false' }).SOURCE_SCHEDULER_ENABLED, 'false');
  assert.throws(() => validateEnvironment({ ...required, SOURCE_SCHEDULER_ENABLED: 'yes' }), /SOURCE_SCHEDULER_ENABLED/);
});

test('optional operational configuration accepts the empty example and Compose values', () => {
  const keys = ['LOG_DIRECTORY', 'BACKUP_STATUS_DIRECTORY', 'BACKUP_REPOSITORY_LABEL', 'BACKUP_CRON_SCHEDULE'];
  const config = validateEnvironment({ ...required, ...Object.fromEntries(keys.map(key => [key, '  '])) });
  for (const key of keys) assert.equal(config[key], undefined);
  assert.equal(validateEnvironment({ ...required, LOG_DIRECTORY: ' /var/log/intly ' }).LOG_DIRECTORY, '/var/log/intly');
});
