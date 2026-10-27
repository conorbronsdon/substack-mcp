/** Synthetic MCP checks only; no stored credentials or network fallback. Build first. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { SubstackClient } from '../dist/api/client.js';
import { readOnlyProbeFetch } from './probe-helpers.mjs';

async function connected(status, run) {
  const originalFetch = globalThis.fetch;
  const counters = { reads: 0, blocked: 0 };
  globalThis.fetch = readOnlyProbeFetch(async (input) => {
    assert.equal(String(input), 'https://example.substack.com/api/v1/publication');
    return Response.json(status === 200
      ? { id: 7, name: 'Example publication', subdomain: 'example' }
      : { error: 'example-sensitive-upstream-detail' }, { status });
  }, counters);
  const server = createServer([{ key: 'example', label: 'Example',
    client: new SubstackClient('https://example.substack.com', 'example-compat-token', '1') }]);
  const client = new Client({ name: 'example-compatibility-smoke', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(ct), server.connect(st)]);
    await run(client, ct, counters);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
  }
}

test('healthy synthetic MCP catalog and publication read', async () => {
  await connected(200, async (client, _transport, counters) => {
    const tool = (await client.listTools()).tools.find(t => t.name === 'get_publication');
    assert.equal(tool.annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'get_publication', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.data.name, 'Example publication');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.match(result.structuredContent.identity_scope, /not verified/);
    assert.deepEqual(counters, { reads: 1, blocked: 0 });
  });
});

for (const status of [401, 403]) {
  test(`synthetic ${status} is a tool error, not evidence of tier compatibility`, async () => {
    await connected(status, async (client, _transport, counters) => {
      const result = await client.callTool({ name: 'get_publication', arguments: {} });
      assert.equal(result.isError, true);
      const body = JSON.parse(result.content[0].text);
      assert.equal(body.status, status);
      assert.equal(body.status_source, 'http');
      assert.equal(body.code, 'upstream_error');
      assert.equal(body.message, 'The read could not be verified within its response contract. Check configuration, authentication and upstream availability. No writes were attempted.');
      assert.doesNotMatch(JSON.stringify(result), /example-sensitive-upstream-detail|example-compat-token/);
      assert.deepEqual(counters, { reads: 1, blocked: 0 });
    });
  });
}

test('client transport rejection happens before any API read', async () => {
  await connected(200, async (client, transport, counters) => {
    transport.send = async () => { throw new Error('example-client-transport-failure'); };
    await assert.rejects(client.callTool({ name: 'get_publication', arguments: {} }), /example-client-transport-failure/);
    assert.deepEqual(counters, { reads: 0, blocked: 0 });
  });
});
