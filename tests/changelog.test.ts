import assert from 'node:assert/strict';
import test from 'node:test';
import pkg from '../package.json' with { type: 'json' };
import { CHANGELOG } from '../src/utils/changelog.ts';

test('The newest version history entry is the version the site shows', () => {
  assert.equal(CHANGELOG[0].version, pkg.version);
});

test('Each pull request appears once, newest first', () => {
  const prs = CHANGELOG.flatMap(r => r.changes.map(c => c.pr));
  assert.equal(new Set(prs).size, prs.length);
  assert.deepEqual(
    prs,
    [...prs].sort((a, b) => b - a),
  );
  for (const r of CHANGELOG) assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
});
