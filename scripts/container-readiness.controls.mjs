import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForHealth } from './container-readiness.mjs';
import { assertExpectedTools, expectedTools } from './expected-tools.mjs';

test('catalog requires every exact tool name', () => {
  const tools = expectedTools.map(name => ({ name }));
  assertExpectedTools(tools);
  assert.throws(() => assertExpectedTools(tools.slice(1)), assert.AssertionError);
  assert.throws(() => assertExpectedTools([...tools.slice(1), { name: 'publish_post' }]), assert.AssertionError);
});

test('health readiness retries a non-200 response and drains each body', async () => {
  const statuses = [503, 200];
  const seen = [];
  await waitForHealth(new URL('http://127.0.0.1:8080/mcp'), { Authorization: 'Bearer example-token' }, {
    totalBudgetMs: 100, retryDelayMs: 1,
    fetchImpl: async (url, options) => {
      seen.push({ path: url.pathname, auth: options.headers.Authorization });
      return new Response('', { status: statuses.shift() });
    },
  });
  assert.deepEqual(seen, [
    { path: '/health', auth: 'Bearer example-token' },
    { path: '/health', auth: 'Bearer example-token' },
  ]);
});

test('pending fetch reaches a bounded failure with diagnostics', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('example-bind-pending')), { once: true });
  });
  await assert.rejects(waitForHealth(new URL('http://127.0.0.1:8080/mcp'), {},
    { fetchImpl, totalBudgetMs: 40, attemptTimeoutMs: 10, retryDelayMs: 1 }),
    error => /after [1-9][0-9]* attempts in [1-9][0-9]* ms: example-bind-pending/.test(error.message));
});
