import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRelease } from './check-release-order.mjs';

test('classifies equal and greater releases', () => {
  assert.equal(classifyRelease('1.2.3', 'none'), 'first');
  assert.equal(classifyRelease('1.2.3', '1.2.3'), 'same');
  assert.equal(classifyRelease('1.2.4', '1.2.3'), 'upgrade');
  assert.equal(classifyRelease('2.0.0', '1.99.99'), 'upgrade');
});

test('handles prerelease precedence', () => {
  assert.equal(classifyRelease('1.2.3-beta.2', '1.2.3-beta.1'), 'upgrade');
  assert.throws(() => classifyRelease('1.2.3-beta.1', '1.2.3'));
});

test('rejects lower and invalid versions', () => {
  assert.throws(() => classifyRelease('1.2.2', '1.2.3'), /Refusing non-monotonic release/);
  assert.throws(() => classifyRelease('not-semver', '1.2.3'), /Invalid local version/);
  assert.throws(() => classifyRelease('1.2.3', 'not-semver'), /Invalid published version/);
});
