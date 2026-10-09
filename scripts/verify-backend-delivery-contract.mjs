#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'operations/scripts/deploy-backend.sh');
const cases = [];

function makeHarness({ dockerExit = 0, dockerExitSequence = null, curlExitSequence = [0, 0] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'intly-delivery-contract-'));
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  const curlState = path.join(dir, 'curl-state');
  const dockerState = path.join(dir, 'docker-state');
  const compose = path.join(dir, 'compose.yaml');
  const env = path.join(dir, 'prod.env');
  spawnSync('mkdir', ['-p', bin], { stdio: 'inherit' });
  writeFileSync(compose, 'services: {}\n');
  writeFileSync(env, 'NODE_ENV=production\n');
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(process.env.INTLY_QA_LOG, 'docker COMPOSE_PROFILES=' + (process.env.COMPOSE_PROFILES || '') + ' ' + process.argv.slice(2).join(' ') + '\\n');\nconst sequence = JSON.parse(process.env.INTLY_DOCKER_EXIT_SEQUENCE || '[${dockerExit}]');\nlet index = 0;\ntry { index = Number(fs.readFileSync(process.env.INTLY_DOCKER_STATE, 'utf8')); } catch {}\nfs.writeFileSync(process.env.INTLY_DOCKER_STATE, String(index + 1));\nprocess.exit(sequence[Math.min(index, sequence.length - 1)]);\n`);
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node\nconst fs = require('fs');\nconst log = process.env.INTLY_QA_LOG;\nfs.appendFileSync(log, 'curl ' + process.argv.slice(2).join(' ') + '\\n');\nconst statePath = process.env.INTLY_CURL_STATE;\nconst sequence = JSON.parse(process.env.INTLY_CURL_SEQUENCE || '[0]');\nlet index = 0;\ntry { index = Number(fs.readFileSync(statePath, 'utf8')); } catch {}\nfs.writeFileSync(statePath, String(index + 1));\nprocess.exit(sequence[Math.min(index, sequence.length - 1)]);\n`);
  writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path.join(bin, 'docker'), 0o755);
  chmodSync(path.join(bin, 'curl'), 0o755);
  chmodSync(path.join(bin, 'sleep'), 0o755);
  return { dir, bin, log, curlState, dockerState, compose, env, curlExitSequence, dockerExitSequence }; 
}

function runDeploy(harness, overrides = {}) {
  const env = {
    ...process.env,
    PATH: `${harness.bin}:${process.env.PATH}`,
    INTLY_QA_LOG: harness.log,
    INTLY_CURL_STATE: harness.curlState,
    INTLY_CURL_SEQUENCE: JSON.stringify(harness.curlExitSequence),
    INTLY_DOCKER_STATE: harness.dockerState,
    INTLY_DOCKER_EXIT_SEQUENCE: JSON.stringify(harness.dockerExitSequence ?? [0]),
    INTLY_COMPOSE_FILE: harness.compose,
    INTLY_DEPLOY_ENV_FILE: harness.env,
    COMPOSE_PROJECT_NAME: 'intly-contract-qa',
    COMPOSE_PROFILES: '',
    INTLY_BACKEND_IMAGE: 'ghcr.io/example/intly-backend:0123456789abcdef0123456789abcdef01234567',
    MINIO_IMAGE: 'ghcr.io/example/intly-backend/minio:0123456789abcdef0123456789abcdef01234567',
    INTLY_HEALTH_TIMEOUT_SECONDS: '1',
    INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS: '1',
    ...overrides,
  };
  return spawnSync('bash', [scriptPath], { env, encoding: 'utf8', timeout: 15000 });
}

function readLog(harness) {
  try { return readFileSync(harness.log, 'utf8'); } catch { return ''; }
}

function cleanup(harness) {
  rmSync(harness.dir, { recursive: true, force: true });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function test(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (error) {
    cases.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}



test('compose topology contract keeps production sidecars and images wired to verified services', () => {
  const composeText = readFileSync(path.join(repoRoot, 'compose.yaml'), 'utf8');
  const productionEnv = readFileSync(path.join(repoRoot, 'operations/environments/backend.production.env.example'), 'utf8');
  const workflowText = readFileSync(path.join(repoRoot, '.github/workflows/backend-ci.yml'), 'utf8');
  const firecrawlApiStart = composeText.search(/^  firecrawl-api:/m);
  const firecrawlApiBlock = composeText.slice(firecrawlApiStart, composeText.indexOf('networks:', firecrawlApiStart));
  const apiStart = composeText.search(/^  api:/m);
  const apiBlock = composeText.slice(apiStart, composeText.search(/^  worker:/m));
  const workerStart = composeText.search(/^  worker:/m);
  const workerBlock = composeText.slice(workerStart, composeText.search(/^  mongo:/m));

  assert.match(composeText, /image: \$\{MINIO_IMAGE:-intly-minio:\$\{INTLY_IMAGE_TAG:-local\}\}/);
  assert.match(composeText, /curl -fsS http:\/\/127\.0\.0\.1:9000\/minio\/health\/live/);
  assert.doesNotMatch(composeText, /mc", "ready", "local/);
  assert.match(composeText, /image: \$\{EMBEDDING_IMAGE:-ghcr\.io\/huggingface\/text-embeddings-inference:cpu-1\.9\}/);

  assert.equal((composeText.match(/^  firecrawl-api:/gm) || []).length, 1);
  assert.doesNotMatch(composeText, /^  firecrawl-worker:/m);
  assert.doesNotMatch(composeText, /^  firecrawl-postgres:/m);
  assert.match(composeText, /^  firecrawl-nuq-postgres:/m);
  assert.match(composeText, /ghcr\.io\/firecrawl\/firecrawl@sha256:2b5ca4e5b1a0a4c092ff15b874fa1a6a3d9af5aaa7efb13142f7ca38eea1ff6b/);
  assert.match(composeText, /ghcr\.io\/firecrawl\/playwright-service@sha256:47da52c036b55580d5d0812fa530eacfe03533ebad9449a50858ff697db04f71/);
  assert.match(composeText, /ghcr\.io\/firecrawl\/nuq-postgres@sha256:9b638af78d99873bc0ba2b57c9cbcd01df6ce96efeaa72d36cfbe0f76521e8fc/);
  assert.match(composeText, /\/v0\/health\/readiness/);
  assert.doesNotMatch(composeText, /\/v1\/health\/liveness/);
  assert.match(composeText, /POSTGRES_DB: postgres/);
  assert.doesNotMatch(composeText, /POSTGRES_DB: firecrawl/);
  assert.match(composeText, /pg_isready -U firecrawl -d postgres/);
  assert.doesNotMatch(composeText, /pg_isready -U firecrawl -d firecrawl/);
  assert.match(composeText, /EXTRACT_WORKER_PORT: \$\{FIRECRAWL_EXTRACT_WORKER_PORT:-3004\}/);
  assert.match(composeText, /WORKER_PORT: \$\{FIRECRAWL_WORKER_PORT:-3005\}/);
  assert.match(firecrawlApiBlock, /ENV: local/);
  assert.doesNotMatch(firecrawlApiBlock, /ENV: production/);

  assert.match(productionEnv, /MINIO_IMAGE=ghcr\.io\/OWNER\/intly-backend\/minio:COMMIT_SHA/);
  assert.match(productionEnv, /EMBEDDING_IMAGE=ghcr\.io\/huggingface\/text-embeddings-inference:cpu-1\.9/);
  assert.match(productionEnv, /cpu-arm64-1\.9/);
  assert.match(productionEnv, /EMBEDDING_MODEL=intfloat\/multilingual-e5-small/);
  assert.match(productionEnv, /EMBEDDING_MAX_BATCH_TOKENS=2048/);
  assert.match(productionEnv, /EMBEDDING_MAX_BATCH_REQUESTS=4/);
  assert.match(productionEnv, /EMBEDDING_MAX_CONCURRENT_REQUESTS=8/);
  assert.match(productionEnv, /EMBEDDING_TOKENIZATION_WORKERS=2/);
  assert.match(productionEnv, /FIRECRAWL_NUQ_POSTGRES_IMAGE=ghcr\.io\/firecrawl\/nuq-postgres@sha256:9b638af78d99873bc0ba2b57c9cbcd01df6ce96efeaa72d36cfbe0f76521e8fc/);
  assert.match(productionEnv, /FIRECRAWL_EXTRACT_WORKER_PORT=3004/);
  assert.match(productionEnv, /FIRECRAWL_WORKER_PORT=3005/);
  assert.match(workflowText, /minio_image=ghcr\.io\/\$\{repository\}\/minio:\$\{GITHUB_SHA\}/);
  assert.match(workflowText, /image=ghcr\.io\/\$\{repository\}:\$\{GITHUB_SHA\}/);
  assert.match(workflowText, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(workflowText, /self-hosted/);
  assert.match(workflowText, /packages: write/);
  assert.match(workflowText, /packages: read/);
  assert.match(workflowText, /cancel-in-progress: false/);
  assert.match(workflowText, /DEPLOY_KNOWN_HOSTS/);
  assert.match(workflowText, /python3 -m unittest discover -s operations\/tests -p 'test_github_deploy\.py'/);
  assert.match(workflowText, /StrictHostKeyChecking=yes/);
  assert.match(workflowText, /IdentitiesOnly=yes/);
  assert.match(workflowText, /git archive --format=tar --output="\$tarball" HEAD/);
  assert.match(workflowText, /printf '%s\\n' "\$GHCR_TOKEN"/);
  assert.match(workflowText, /"deploy \$\{GITHUB_SHA\}"/);
});

test('40-hex SHA tag deploy runs config, pull, up, then bounded live and ready health checks', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = readLog(h).trim().split('\n');
    assert.deepEqual(calls, [
      `docker COMPOSE_PROFILES= compose --env-file ${h.env} -f ${h.compose} -p intly-contract-qa config --quiet`,
      `docker COMPOSE_PROFILES= compose --env-file ${h.env} -f ${h.compose} -p intly-contract-qa pull`,
      `docker COMPOSE_PROFILES= compose --env-file ${h.env} -f ${h.compose} -p intly-contract-qa up -d --no-build --wait --wait-timeout 1`,
      'curl --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:3001/api/v1/health/live',
      'curl --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:3001/api/v1/health/ready',
    ]);
  } finally { cleanup(h); }
});

test('sha256 digest deploy accepts immutable backend and minio digests and uses the same command order', () => {
  const h = makeHarness();
  try {
    const digest = `ghcr.io/example/intly-backend@sha256:${'a'.repeat(64)}`;
    const minioDigest = `ghcr.io/example/intly-backend/minio@sha256:${'b'.repeat(64)}`;
    const result = runDeploy(h, { INTLY_BACKEND_IMAGE: digest, MINIO_IMAGE: minioDigest });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`Backend deployment is healthy: ${digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(readLog(h).trim().split('\n').length, 5);
  } finally { cleanup(h); }
});



test('managed sidecar profiles are passed through to compose commands when enabled by deployment environment', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { COMPOSE_PROFILES: 'firecrawl,embedding' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const dockerCalls = readLog(h).trim().split('\n').filter((line) => line.startsWith('docker '));
    assert.deepEqual(dockerCalls, [
      `docker COMPOSE_PROFILES=firecrawl,embedding compose --env-file ${h.env} -f ${h.compose} -p intly-contract-qa config --quiet`,
      `docker COMPOSE_PROFILES=firecrawl,embedding compose --env-file ${h.env} -f ${h.compose} -p intly-contract-qa pull`,
      `docker COMPOSE_PROFILES=firecrawl,embedding compose --env-file ${h.env} -f ${h.compose} -p intly-contract-qa up -d --no-build --wait --wait-timeout 1`,
    ]);
  } finally { cleanup(h); }
});



test('missing minio image is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { MINIO_IMAGE: '' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MINIO_IMAGE is required/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('mutable minio latest tag is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { MINIO_IMAGE: 'ghcr.io/example/intly-backend/minio:latest' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MINIO_IMAGE must be an immutable SHA tag or digest/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('malformed minio tag is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { MINIO_IMAGE: 'ghcr.io/example/intly-backend/minio:1234abcd' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MINIO_IMAGE must end with a 40-hex commit SHA tag/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('mutable latest tag is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { INTLY_BACKEND_IMAGE: 'ghcr.io/example/intly-backend:latest' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /immutable SHA tag or digest/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('malformed tag is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { INTLY_BACKEND_IMAGE: 'ghcr.io/example/intly-backend:1234abcd' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /40-hex commit SHA tag/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});



test('failed compose wait exits nonzero before URL health success is reported', () => {
  const h = makeHarness({ dockerExitSequence: [0, 0, 17] });
  try {
    const result = runDeploy(h, { COMPOSE_PROFILES: 'firecrawl,embedding' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Backend deployment is healthy/);
    const calls = readLog(h);
    assert.match(calls, new RegExp(`docker COMPOSE_PROFILES=firecrawl,embedding compose --env-file ${escapeRegExp(h.env)} -f ${escapeRegExp(h.compose)} -p intly-contract-qa config --quiet`));
    assert.doesNotMatch(calls, /curl --connect-timeout/);
  } finally { cleanup(h); }
});

test('zero timeout is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { INTLY_HEALTH_TIMEOUT_SECONDS: '0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /positive integer/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});



test('zero compose wait timeout is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS: '0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS must be a positive integer/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('nonnumeric compose wait timeout is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS: 'slow' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS must be a positive integer/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('nonnumeric timeout is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const result = runDeploy(h, { INTLY_HEALTH_TIMEOUT_SECONDS: 'soon' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /positive integer/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('missing env file is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const missingEnv = path.join(h.dir, 'missing.env');
    const result = runDeploy(h, { INTLY_DEPLOY_ENV_FILE: missingEnv });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /environment file not found/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('missing compose file is rejected before docker or curl', () => {
  const h = makeHarness();
  try {
    const missingCompose = path.join(h.dir, 'missing-compose.yaml');
    const result = runDeploy(h, { INTLY_COMPOSE_FILE: missingCompose });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /compose file not found/);
    assert.equal(readLog(h), '');
  } finally { cleanup(h); }
});

test('failed live health exits nonzero with bounded curl and diagnostic compose ps', () => {
  const h = makeHarness({ curlExitSequence: [22, 22, 22] });
  try {
    const result = runDeploy(h);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /live health check did not pass/);
    const log = readLog(h);
    assert.match(log, /curl --connect-timeout 2 --max-time 5 -fsS http:\/\/127\.0\.0\.1:3001\/api\/v1\/health\/live/);
    assert.match(log, /docker COMPOSE_PROFILES= compose .* ps/);
  } finally { cleanup(h); }
});

test('failed ready health exits nonzero after live success with bounded curl and diagnostic compose ps', () => {
  const h = makeHarness({ curlExitSequence: [0, 22, 22, 22] });
  try {
    const result = runDeploy(h);
    assert.notEqual(result.status, 0);
    const log = readLog(h);
    assert.match(log, /curl --connect-timeout 2 --max-time 5 -fsS http:\/\/127\.0\.0\.1:3001\/api\/v1\/health\/ready/);
    assert.match(log, /docker COMPOSE_PROFILES= compose .* ps/);
  } finally { cleanup(h); }
});

const failed = cases.filter((result) => !result.ok);
console.log(JSON.stringify({ cases, passed: failed.length === 0 }, null, 2));
if (failed.length) process.exit(1);
