import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { ProfilesRepository } = require('../src/modules/profiles/profiles.repository.ts');

const ACTIVE_USER = '11111111-1111-4111-8111-111111111111';
const DELETED_USER = '22222222-2222-4222-8222-222222222222';
const DISABLED_USER = '33333333-3333-4333-8333-333333333333';
const LOCKED_USER = '44444444-4444-4444-8444-444444444444';
const INVITED_USER = '55555555-5555-4555-8555-555555555555';

test('listForIngestionMatching returns profiles owned by active available users only', async () => {
  const users = [
    { _id: ACTIVE_USER, status: 'Active' },
    { _id: DELETED_USER, status: 'Deleted', deletedAt: new Date('2026-10-01T00:00:00Z') },
    { _id: DISABLED_USER, status: 'Disabled' },
    { _id: LOCKED_USER, status: 'Locked' },
    { _id: INVITED_USER, status: 'Invited' },
  ];
  const profiles = [
    { _id: 'profile-active-old', userId: ACTIVE_USER, updatedAt: new Date('2026-10-01T00:00:00Z') },
    { _id: 'profile-active-new', userId: ACTIVE_USER, updatedAt: new Date('2026-10-02T00:00:00Z') },
    { _id: 'profile-deleted-user', userId: DELETED_USER, updatedAt: new Date('2026-10-03T00:00:00Z') },
    { _id: 'profile-disabled-user', userId: DISABLED_USER, updatedAt: new Date('2026-10-03T00:00:00Z') },
    { _id: 'profile-locked-user', userId: LOCKED_USER, updatedAt: new Date('2026-10-03T00:00:00Z') },
    { _id: 'profile-invited-user', userId: INVITED_USER, updatedAt: new Date('2026-10-03T00:00:00Z') },
    { _id: 'profile-soft-deleted', userId: ACTIVE_USER, deletedAt: new Date('2026-10-03T00:00:00Z') },
  ];
  const model = fakeProfileModel({ profiles, users });
  const repository = new ProfilesRepository(model);

  const result = await repository.listForIngestionMatching();

  assert.deepEqual(result.map((profile) => profile._id), ['profile-active-new', 'profile-active-old']);
  assert.deepEqual(model.pipeline.map((stage) => Object.keys(stage)[0]), ['$match', '$lookup', '$match', '$project', '$sort']);
  assert.deepEqual(model.pipeline[1].$lookup.pipeline[0].$match, { status: 'Active', deletedAt: { $exists: false } });
});

function fakeProfileModel(seed) {
  const state = { pipeline: null };
  return {
    get pipeline() { return state.pipeline; },
    aggregate(pipeline) {
      state.pipeline = pipeline;
      return {
        async exec() {
          let rows = seed.profiles.filter((profile) => !profile.deletedAt);
          const lookup = pipeline.find((stage) => stage.$lookup).$lookup;
          rows = rows.map((profile) => ({
            ...profile,
            [lookup.as]: seed.users
              .filter((user) => user[lookup.foreignField] === profile[lookup.localField])
              .filter((user) => user.status === 'Active' && !user.deletedAt)
              .map((user) => ({ _id: user._id })),
          }));
          rows = rows.filter((profile) => profile.owner.length !== 0);
          rows = rows.map((profile) => { const { owner: _owner, ...publicProfile } = profile; return publicProfile; });
          return rows.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0) || left._id.localeCompare(right._id));
        },
      };
    },
  };
}
