import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { UsersService } = require('../src/modules/users/users.service.ts');
const { UpdateMeSettingsDto } = require('../src/modules/users/dto/user.dto.ts');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const actor = { id: 'settings-user', role: 'User' };

function settingsFixture() {
  const user = { _id: actor.id, locale: 'ru', timezone: 'Europe/Moscow',
    uiSettings: { theme: 'dark', themePack: 'intly-plum', dashboard: { period: '30d', widgets: ['tasks'] }, exportDefaults: { format: 'xlsx' } },
    notificationSettings: { inApp: true, email: false, digestMode: 'daily', quietHours: { start: '22:00', end: '08:00' } },
    aiPreferences: { language: 'en', userPrompt: 'Legacy prompt', customPrompt: 'Old prompt', userPreferences: 'Existing preference' } };
  const patches = [];
  const service = new UsersService({ update: async (_id, patch) => {
    patches.push(patch);
    for (const [path, value] of Object.entries(patch)) {
      const segments = path.split('.');
      let target = user;
      for (const key of segments.slice(0, -1)) target = target[key] ??= {};
      target[segments.at(-1)] = value;
    }
    return structuredClone(user);
  } });
  return { service, user, patches };
}

test('independent partial settings patches preserve dashboard, export defaults, notification and AI siblings', async () => {
  const { service, user, patches } = settingsFixture();
  await Promise.all([
    service.updateSettings(actor, { uiSettings: { themePack: 'forest-teal' } }),
    service.updateSettings(actor, { uiSettings: { reducedMotion: true } }),
    service.updateSettings(actor, { notificationSettings: { email: true } }),
    service.updateSettings(actor, { aiPreferences: { userPreferences: 'Prefer {{language}}' } }),
  ]);
  assert.equal(user.uiSettings.themePack, 'forest-teal');
  assert.equal(user.uiSettings.reducedMotion, true);
  assert.equal(user.uiSettings.theme, 'dark');
  assert.deepEqual(user.uiSettings.dashboard, { period: '30d', widgets: ['tasks'] });
  assert.deepEqual(user.uiSettings.exportDefaults, { format: 'xlsx' });
  assert.equal(user.notificationSettings.digestMode, 'daily');
  assert.equal(user.notificationSettings.email, true);
  assert.equal(user.aiPreferences.customPrompt, 'Old prompt');
  assert.ok(patches.every(patch => !('uiSettings' in patch) && !('notificationSettings' in patch) && !('aiPreferences' in patch)));
});

test('AI fields remain distinct and explicitly cleared prompt suppresses legacy fallback', async () => {
  const { service, user, patches } = settingsFixture();
  const updated = await service.updateSettings(actor, { aiPreferences: { userPreferences: 'Tone preference', customPrompt: '' } });
  assert.equal(updated.aiPreferences.userPreferences, 'Tone preference');
  assert.equal(updated.aiPreferences.customPrompt, '');
  assert.equal(user.aiPreferences.userPrompt, 'Legacy prompt');
  await assert.rejects(service.updateSettings(actor, { aiPreferences: { customPrompt: 'Use {{secret}}' } }), /Unsupported AI prompt placeholder/);
  assert.equal(patches.length, 1);
});

test('settings request accepts real timezone and four theme packs, rejects invalid zones and undeclared roles', async () => {
  assert.equal((await validate(plainToInstance(UpdateMeSettingsDto, { timezone: 'UTC', uiSettings: { themePack: 'graphite-copper', theme: 'system', reducedMotion: true } }), { whitelist: true, forbidNonWhitelisted: true })).length, 0);
  const invalid = await validate(plainToInstance(UpdateMeSettingsDto, { timezone: 'Europe/NoSuchPlace', role: 'Manager', uiSettings: { themePack: 'invented' } }), { whitelist: true, forbidNonWhitelisted: true });
  assert.ok(invalid.some(error => error.property === 'timezone'));
  assert.ok(invalid.some(error => error.property === 'role'));
  assert.ok(invalid.some(error => error.property === 'uiSettings'));
});

test('the nested me settings route shares strict notification validation and preserves category siblings', async () => {
  const { service, user, patches } = settingsFixture();
  user.notificationSettings.eventChannels = { opportunity: { email: true }, ai: { email: false, mode: 'digest' } };
  await service.updateSettings(actor, { notificationSettings: { eventChannels: { ai: {} }, quietHours: null } });
  assert.deepEqual(user.notificationSettings.eventChannels.ai, {});
  assert.deepEqual(user.notificationSettings.eventChannels.opportunity, { email: true });
  assert.equal(user.notificationSettings.quietHours, null);
  await assert.rejects(service.updateSettings(actor, { notificationSettings: { quietHours: { start: '99:00', end: '08:00' } } }), /time is invalid/);
  await assert.rejects(service.updateSettings(actor, { notificationSettings: { eventChannels: { ai: { email: 'true' } } } }), /must be boolean/);
  assert.equal(patches.length, 1);
});
