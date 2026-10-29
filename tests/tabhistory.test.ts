import assert from 'node:assert/strict';
import test from 'node:test';
import { TabHistory } from '../src/utils/tabhistory.ts';

// Back, Forward and Reload in the toolbar (src/utils/navigation.ts) follow this list.
const A = 'https://persec.test/sc/a';
const B = 'https://persec.test/sc/b';
const C = 'https://persec.test/sc/c';

test('Pages reached by clicking inside a site are in the history', () => {
  const h = new TabHistory();
  h.open(A, '');
  h.landed(A);
  h.landed(B);
  h.landed(C);
  assert.deepEqual(h.stack, [A, B, C]);
  assert.equal(h.current, C, 'Reload reloads the page the tab is on');
  assert.equal(h.back(C), B, 'Back goes to the page clicked from, not the one typed');
  h.landed(B);
  assert.equal(h.forward(B), C);
});

test('Going somewhere new after Back drops the pages ahead', () => {
  const h = new TabHistory();
  h.open(A, '');
  h.landed(A);
  h.landed(B);
  h.back(B);
  h.landed(A);
  h.landed(C);
  assert.deepEqual(h.stack, [A, C]);
  assert.equal(h.forward(C), undefined);
});

test('The old page seen while a new one loads is not a navigation', () => {
  const h = new TabHistory();
  h.open(A, '');
  h.landed(A);
  h.open(B, A);
  h.landed(A);
  h.landed('about:blank');
  assert.deepEqual(h.stack, [A, B]);
  h.landed(B);
  assert.deepEqual(h.stack, [A, B]);
});

test('Where an opened page redirects to takes its place', () => {
  const h = new TabHistory();
  h.open(A, '');
  h.landed(A);
  h.open(B, A);
  h.landed(C);
  assert.deepEqual(h.stack, [A, C]);
  assert.equal(h.back(C), A);
  assert.equal(h.back(A), undefined, 'nothing before the first page');
});
