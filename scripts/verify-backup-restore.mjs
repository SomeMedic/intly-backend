#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import mongoose from 'mongoose';

const backendRoot = resolve(new URL('..', import.meta.url).pathname);
const projectRoot = resolve(backendRoot, '..');
const reportPath = join(projectRoot, '.local/reports/backup-restore.json');
const runId = `backup-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const tmpRoot = join(projectRoot, '.local/backup-restore-acceptance', runId);
const report = {
  ok: false,
  runId,
  checkedAt: new Date().toISOString(),
  mode: null,
  tools: {},
  checks: [],
  restore: {},
  warnings: [],
};

const mongoProcesses = [];

async function main() {
  await assertLocalOnly();
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  await chmod(tmpRoot, 0o700);
  await mkdir(dirname(reportPath), { recursive: true });

  const tools = await discoverTools();
  report.tools = redactToolsForReport(tools);
  assert.ok(tools.mongod, 'mongod is required for isolated restore verification');
  assert.ok(tools.mongodump, 'mongodump is required for backup verification');
  assert.ok(tools.mongorestore, 'mongorestore is required for restore verification');
  assert.ok(tools.openssl, 'openssl is required for encrypted fallback when restic is unavailable');
  assert.ok(tools.tar, 'tar is required for encrypted fallback when restic is unavailable');

  const sourceMongo = await startIsolatedMongo('source');
  const restoreMongo = await startIsolatedMongo('restore');

  const dbName = `intly_backup_acceptance_${Date.now()}`;
  const seeded = await seedMongo(sourceMongo.uri(dbName));
  const stagingDir = join(tmpRoot, 'staging');
  await mkdir(join(stagingDir, 'mongo'), { recursive: true });
  await mkdir(join(stagingDir, 'minio'), { recursive: true });
  await mkdir(join(stagingDir, 'config'), { recursive: true });

  const dumpPath = join(stagingDir, 'mongo/intly.archive.gz');
  await runTool(tools.mongodump, ['--uri', sourceMongo.uri(dbName), '--archive=' + dumpPath, '--gzip'], { label: 'mongodump.archive' });
  const dumpSha256 = await sha256File(dumpPath);
  const dumpSize = (await stat(dumpPath)).size;
  assert.ok(dumpSize > 0, 'mongodump archive must not be empty');

  const fileFixturePath = join(stagingDir, 'minio/object-fixture.txt');
  const fileFixture = `INTLY backup restore fixture\nrun=${runId}\nseed=${seeded.seed}\n`;
  await writeFile(fileFixturePath, fileFixture, { mode: 0o600 });
  const fileSha256 = await sha256File(fileFixturePath);
  await writeFile(
    join(stagingDir, 'manifest.json'),
    JSON.stringify({
      runId,
      dbName,
      collection: 'backup_acceptance',
      mongoArchiveSha256: dumpSha256,
      fileFixtureSha256: fileSha256,
      createdAt: new Date().toISOString(),
    }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(join(stagingDir, 'config/restore-target.txt'), 'isolated acceptance only\n', { mode: 0o600 });

  const passwordFile = join(tmpRoot, 'restic-or-fallback-password');
  await writeFile(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  await chmod(passwordFile, 0o600);
  const passwordMode = ((await stat(passwordFile)).mode & 0o777).toString(8);
  assert.equal(passwordMode, '600', 'temporary backup password file must be mode 600');
  report.checks.push({ name: 'credential-file.mode-600', ok: true });

  const restoredRoot = tools.restic
    ? await resticRoundTrip(tools, stagingDir, passwordFile)
    : await encryptedFileRoundTrip(tools, stagingDir, passwordFile);

  const restoredDump = await findFile(restoredRoot, 'intly.archive.gz');
  const restoredFixture = await findFile(restoredRoot, 'object-fixture.txt');
  assert.ok(restoredDump, 'restored Mongo archive must exist');
  assert.ok(restoredFixture, 'restored file fixture must exist');
  assert.equal(await sha256File(restoredDump), dumpSha256, 'restored Mongo archive checksum must match');
  assert.equal(await sha256File(restoredFixture), fileSha256, 'restored file fixture checksum must match');
  report.checks.push({ name: 'restored-artifacts.checksum', ok: true });

  await runTool(tools.mongorestore, ['--uri', restoreMongo.uri(dbName), '--archive=' + restoredDump, '--gzip', '--drop'], { label: 'mongorestore.archive' });
  const restored = await readMongo(restoreMongo.uri(dbName));
  assert.equal(restored.length, 1, 'restored collection must contain exactly one QA document');
  assert.deepEqual(restored[0], seeded.document, 'restored QA document must match seeded data');
  report.checks.push({ name: 'mongo.restore-data-match', ok: true });

  report.restore = {
    dbName,
    sourcePort: sourceMongo.port,
    restorePort: restoreMongo.port,
    mongoArchiveBytes: dumpSize,
    mongoArchiveSha256: dumpSha256,
    fileFixtureSha256: fileSha256,
    restoredDocuments: restored.length,
    cleanup: 'temporary Mongo dbpaths, archives, password file and repository are removed after the run',
  };
  report.ok = true;
}

async function assertLocalOnly() {
  const envPath = join(backendRoot, '.env');
  const envText = await readFile(envPath, 'utf8').catch(() => '');
  assert.equal(process.env.NODE_ENV === 'production', false, 'backup restore acceptance refuses production NODE_ENV');
  assert.equal(/^\s*NODE_ENV\s*=\s*production\s*$/m.test(envText), false, 'backup restore acceptance refuses production .env');
  report.checks.push({ name: 'environment.not-production', ok: true });
}

async function discoverTools() {
  const names = ['mongod', 'mongodump', 'mongorestore', 'mongosh', 'restic', 'openssl', 'tar'];
  const discovered = {};
  for (const name of names) discovered[name] = await commandPath(name);
  if (!discovered.restic) {
    for (const candidate of [join(projectRoot, '.local/bin/restic'), join(projectRoot, '.local/vendor/restic/restic')]) {
      if (await exists(candidate)) {
        discovered.restic = candidate;
        break;
      }
    }
  }
  for (const [name, executable] of Object.entries(discovered)) {
    if (executable) discovered[`${name}Version`] = await toolVersion(name, executable);
  }
  if (!discovered.restic) {
    report.warnings.push('restic CLI was not found on PATH or .local vendor paths; encrypted file-only fallback was used for this local rehearsal.');
  }
  return discovered;
}

function redactToolsForReport(tools) {
  const result = {};
  for (const [key, value] of Object.entries(tools)) {
    if (!value) result[key] = null;
    else result[key] = value;
  }
  return result;
}

async function commandPath(name) {
  const result = await execCapture('command', ['-v', name], { shell: true, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function toolVersion(name, executable) {
  const versionArgs = name === 'openssl' || name === 'restic' ? ['version'] : ['--version'];
  const result = await execCapture(executable, versionArgs, { allowFailure: true });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.split('\n').find(Boolean)?.slice(0, 240) ?? 'version unavailable';
}

async function startIsolatedMongo(label) {
  const dbPath = join(tmpRoot, `${label}-db`);
  const logPath = join(tmpRoot, `${label}.log`);
  await mkdir(dbPath, { recursive: true });
  const port = await freePort();
  const child = spawn(report.tools.mongod.path ?? report.tools.mongod, [
    '--dbpath', dbPath,
    '--bind_ip', '127.0.0.1',
    '--port', String(port),
    '--logpath', logPath,
    '--quiet',
    '--setParameter', 'enableTestCommands=1',
  ], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  mongoProcesses.push(child);
  await waitForMongo(`mongodb://127.0.0.1:${port}/admin`, label, logPath);
  report.checks.push({ name: `isolated-mongo.${label}.ready`, ok: true, port });
  return {
    port,
    uri(dbName) {
      return `mongodb://127.0.0.1:${port}/${dbName}`;
    },
  };
}

async function seedMongo(uri) {
  const seed = randomUUID();
  const document = {
    acceptanceId: seed,
    title: 'INTLY backup restore acceptance',
    nested: { value: 42, tags: ['backup', 'restore', 'isolated'] },
    createdAtIso: new Date().toISOString(),
  };
  const expectedDocument = JSON.parse(JSON.stringify(document));
  const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5_000 }).asPromise();
  try {
    await connection.db.collection('backup_acceptance').insertOne(document);
    const count = await connection.db.collection('backup_acceptance').countDocuments({ acceptanceId: seed });
    assert.equal(count, 1, 'seeded QA document must be present before dump');
    report.checks.push({ name: 'mongo.seed-source-document', ok: true });
    return { seed, document: expectedDocument };
  } finally {
    await connection.close();
  }
}

async function readMongo(uri) {
  const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5_000 }).asPromise();
  try {
    const docs = await connection.db.collection('backup_acceptance').find({}, { projection: { _id: 0 } }).toArray();
    return docs.map((doc) => JSON.parse(JSON.stringify(doc)));
  } finally {
    await connection.close();
  }
}

async function resticRoundTrip(tools, stagingDir, passwordFile) {
  report.mode = 'restic';
  const repo = join(tmpRoot, 'restic-repo');
  const restoredRoot = join(tmpRoot, 'restic-restore');
  const env = { ...process.env, RESTIC_REPOSITORY: repo, RESTIC_PASSWORD_FILE: passwordFile };
  await runTool(tools.restic, ['init'], { env, label: 'restic.init' });
  await runTool(tools.restic, ['backup', '.'], { env, cwd: stagingDir, label: 'restic.backup' });
  await runTool(tools.restic, ['check'], { env, label: 'restic.check' });
  await runTool(tools.restic, ['restore', 'latest', '--target', restoredRoot], { env, label: 'restic.restore' });
  report.checks.push({ name: 'restic.roundtrip', ok: true });
  return restoredRoot;
}

async function encryptedFileRoundTrip(tools, stagingDir, passwordFile) {
  report.mode = 'encrypted-file-fallback';
  const tarPath = join(tmpRoot, 'staging.tar');
  const encryptedPath = join(tmpRoot, 'staging.tar.enc');
  const decryptedPath = join(tmpRoot, 'restored.tar');
  const restoredRoot = join(tmpRoot, 'file-restore');
  await mkdir(restoredRoot, { recursive: true });
  await runTool(tools.tar, ['-cf', tarPath, '-C', stagingDir, '.'], { label: 'fallback.tar-create' });
  await runTool(tools.openssl, ['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', `file:${passwordFile}`, '-in', tarPath, '-out', encryptedPath], { label: 'fallback.encrypt' });
  await runTool(tools.openssl, ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `file:${passwordFile}`, '-in', encryptedPath, '-out', decryptedPath], { label: 'fallback.decrypt' });
  await runTool(tools.tar, ['-xf', decryptedPath, '-C', restoredRoot], { label: 'fallback.tar-extract' });
  report.checks.push({ name: 'encrypted-file-fallback.roundtrip', ok: true });
  return restoredRoot;
}

async function runTool(command, args, options = {}) {
  const result = await execCapture(command, args, options);
  assert.equal(result.code, 0, `${options.label ?? command} failed: ${result.stderr || result.stdout}`);
  report.checks.push({ name: options.label ?? command, ok: true });
  return result;
}

function execCapture(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      resolvePromise({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      if (code !== 0 && !options.allowFailure) {
        resolvePromise({ code, stdout, stderr });
      } else {
        resolvePromise({ code, stdout, stderr });
      }
    });
  });
}

async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePromise(address.port));
    });
    server.on('error', reject);
  });
}

async function waitForMongo(uri, label, logPath) {
  const deadline = Date.now() + 20_000;
  let lastError = '';
  while (Date.now() < deadline) {
    const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 750 });
    try {
      await connection.asPromise();
      await connection.db.admin().ping();
      await connection.close();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await connection.close().catch(() => undefined);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  const log = await readFile(logPath, 'utf8').catch(() => '');
  throw new Error(`isolated Mongo ${label} did not become ready: ${lastError}; log=${log.slice(-1000)}`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function findFile(root, basename) {
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(root, { withFileTypes: true }));
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isFile() && entry.name === basename) return fullPath;
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, basename);
      if (found) return found;
    }
  }
  return null;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  for (const child of mongoProcesses.reverse()) {
    if (!child.killed) {
      child.kill('SIGTERM');
      await new Promise((resolvePromise) => {
        const timeout = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
          resolvePromise();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolvePromise();
        });
      });
    }
  }
  await rm(tmpRoot, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : 'backup restore acceptance failed';
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    report.warnings.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: '.local/reports/backup-restore.json' }));
}
