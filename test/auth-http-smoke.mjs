import 'dotenv/config';
import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { Module, ValidationPipe } from '@nestjs/common';

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '3102';
process.env.BOOTSTRAP_ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'auth-smoke-admin@intly.local';
process.env.BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'Auth-smoke-admin-123';
process.env.BOOTSTRAP_ADMIN_NAME = process.env.BOOTSTRAP_ADMIN_NAME ?? 'Auth Smoke Admin';

const smokeMongo = isolatedMongoUri(process.env.MONGODB_URI);
process.env.MONGODB_URI = smokeMongo.uri;

const baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const frontendOrigin = new URL(process.env.FRONTEND_URL ?? 'http://localhost:3000').origin;

const { HttpErrorFilter } = await import('../dist/common/http-error.filter.js');
const { validateEnvironment } = await import('../dist/infrastructure/config.js');
const { DataModule } = await import('../dist/infrastructure/data.module.js');
const { AuthModule } = await import('../dist/modules/auth/auth.module.js');

class SmokeModule {}
Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    DataModule,
    AuthModule,
  ],
})(SmokeModule);


function isolatedMongoUri(input) {
  if (!input) throw new Error('MONGODB_URI is required for auth smoke');
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!isLoopback) throw new Error('auth smoke refuses to use a non-loopback MongoDB URI');
  const dbName = `intly_auth_smoke_${process.pid}_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  url.pathname = `/${dbName}`;
  return { uri: url.toString(), dbName };
}

function assertSmokeDatabase(connection) {
  const dbName = connection.db?.databaseName;
  assert(dbName && dbName.startsWith('intly_auth_smoke_'), `refusing to drop non-smoke database: ${dbName ?? 'unknown'}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie');
  assert(setCookie, 'expected Set-Cookie header');
  return setCookie.split(';')[0];
}

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

async function main() {
  const app = await NestFactory.create(SmokeModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  await app.listen(Number(process.env.PORT ?? 3102), '127.0.0.1');

  try {
    const adminLoginResponse = await request('/auth/login', {
      method: 'POST',
      headers: { origin: frontendOrigin },
      body: JSON.stringify({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      }),
    });
    const adminCookie = cookieFrom(adminLoginResponse);
    const adminLogin = await json(adminLoginResponse);
    assert(adminLogin.user.role === 'Admin', 'bootstrap admin login should return Admin role');

    const settings = await json(await request('/me/settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminLogin.accessToken}` },
      body: JSON.stringify({
        locale: 'en',
        timezone: 'Europe/Volgograd',
        uiSettings: { theme: 'dark', density: 'compact', reducedMotion: true },
        notificationSettings: { inApp: true, email: false, telegram: false, digestMode: 'instant' },
        aiPreferences: { userPrompt: 'Prefer concise reasoning.', language: 'en' },
      }),
    }));
    assert(settings.locale === 'en' && settings.uiSettings.theme === 'dark', 'settings should persist bounded fields');

    const badOriginRefresh = await request('/auth/refresh', {
      method: 'POST',
      headers: { origin: 'http://evil.local', cookie: adminCookie },
    });
    assert(badOriginRefresh.status === 403, 'refresh should reject untrusted Origin');

    const invite = await json(await request('/admin/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminLogin.accessToken}`, 'x-request-id': 'auth-smoke-invite' },
      body: JSON.stringify({ email: 'smoke-user@intly.local', name: 'Smoke User', role: 'User' }),
    }));
    assert(invite.user.role === 'User', 'invite should create User role');
    assert(invite.activationToken, 'test invite should expose dev activation token when Resend is not configured');

    const mongoConnection = app.get(getConnectionToken());
    const auditCount = await mongoConnection.db.collection('audit_events').countDocuments({
      action: 'user.invite',
      entityId: invite.user.id,
      fields: 'role',
    });
    assert(auditCount === 1, 'admin invite should create audit event');

    const activationResponse = await request('/auth/activate', {
      method: 'POST',
      headers: { origin: frontendOrigin },
      body: JSON.stringify({ token: invite.activationToken, password: 'User-password-123' }),
    });
    const activationCookie = cookieFrom(activationResponse);
    const activation = await json(activationResponse);
    assert(activation.user.status === 'Active', 'activation should make user active');

    const refreshResponse = await request('/auth/refresh', {
      method: 'POST',
      headers: { origin: frontendOrigin, cookie: activationCookie },
    });
    const rotatedCookie = cookieFrom(refreshResponse);
    const refresh = await json(refreshResponse);
    assert(refresh.accessToken, 'refresh should return access token');

    const beforeLogoutMe = await json(await request('/me', {
      headers: { authorization: `Bearer ${refresh.accessToken}` },
    }));
    assert(beforeLogoutMe.id === activation.user.id, 'fresh access token should work before logout');

    const logoutResponse = await request('/auth/logout', {
      method: 'POST',
      headers: { origin: frontendOrigin, cookie: rotatedCookie, authorization: `Bearer ${refresh.accessToken}` },
    });
    assert(logoutResponse.status === 201, 'logout should succeed with trusted origin');

    const afterLogoutRefresh = await request('/auth/refresh', {
      method: 'POST',
      headers: { origin: frontendOrigin, cookie: rotatedCookie },
    });
    assert(afterLogoutRefresh.status === 401, 'logout should immediately revoke refresh family');

    const afterLogoutMe = await request('/me', {
      headers: { authorization: `Bearer ${refresh.accessToken}` },
    });
    assert(afterLogoutMe.status === 401, 'logout should immediately reject access token session');

    const replayResponse = await request('/auth/refresh', {
      method: 'POST',
      headers: { origin: frontendOrigin, cookie: activationCookie },
    });
    assert(replayResponse.status === 401, 'replayed refresh token should be rejected');
    assert(rotatedCookie !== activationCookie, 'refresh cookie should rotate');

    console.log('auth http mongo smoke ok');
  } finally {
    const mongoConnection = app.get(getConnectionToken(), { strict: false });
    if (mongoConnection?.db) {
      assertSmokeDatabase(mongoConnection);
      await mongoConnection.db.dropDatabase();
    }
    await app.close();
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
