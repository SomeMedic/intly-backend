import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { MatchingService } = require('../src/modules/matching/matching.service.ts');
const service = new MatchingService();
const base = { sourceOccurrences: [], firstSeenAt: new Date(), skills: [], technologies: [], money: {} };

describe('distinct skill matching', () => {
  it('counts skills copied into technologies once and keeps every component within 0..100', () => {
    const candidate = { ...base, skills: ['Python', 'Docker', 'PostgreSQL'], technologies: ['Python', 'Docker', 'PostgreSQL'] };
    const profile = { technologies: ['Python', 'PostgreSQL', 'Docker'] };
    const result = service.calculate(candidate, profile);
    assert.equal(result.components.skills, 100);
    assert.equal(result.score, service.calculate({ ...candidate, technologies: [] }, profile).score);
    assert.deepEqual(result.matchedSkills, ['Python', 'Docker', 'PostgreSQL']);
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.ok(Object.values(result.components).every(value => value >= 0 && value <= 100));
  });

  it('normalizes case and spaces on both sides without rewarding repeated profile requirements', () => {
    const result = service.calculate({ ...base, skills: [' Python ', 'python', 'PYTHON', ' '], technologies: [' python '] }, {
      technologies: ['Python', 'PYTHON ', ' Docker', 'docker ', ''],
    });
    assert.equal(result.components.skills, 50);
    assert.deepEqual(result.matchedSkills, ['Python']);
  });

  it('scores partial coverage as a ratio of distinct requested technologies', () => {
    const result = service.calculate({ ...base, skills: ['Python', 'PYTHON'], technologies: ['python', 'Git'] }, {
      technologies: ['Python', 'Docker', 'PostgreSQL'],
    });
    assert.equal(result.components.skills, 33);
    assert.deepEqual(result.matchedSkills, ['Python']);
  });

  it('retains neutral missing-data semantics and scores disjoint known skills zero', () => {
    for (const [skills, technologies] of [[[], ['Python']], [['Python'], []], [[' '], ['Python']], [['Python'], [' ']]]) {
      assert.equal(service.calculate({ ...base, skills }, { technologies }).components.skills, 50);
    }
    assert.equal(service.calculate({ ...base, skills: ['Go'] }, { technologies: ['Python'] }).components.skills, 0);
  });
});
