// Synthetic transport checks. No live publication or credentials are used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pkg from '../package.json' with { type: 'json' };

const [image, revision] = process.argv.slice(2);
assert.ok(image && !image.startsWith('-'), 'Provide a Docker image reference');
assert.match(revision ?? '', /^[a-f0-9]{40}$/, 'Provide the source commit SHA');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
const info = JSON.parse(docker('image', 'inspect', image))[0];
assert.equal(info.Config.User, 'node');
for (const [key, value] of Object.entries({ version: pkg.version, revision, source: 'https://github.com/conorbronsdon/substack-mcp', licenses: 'MIT' })) {
  assert.equal(info.Config.Labels[`org.opencontainers.image.${key}`], value);
}
const env = ['-e', 'SUBSTACK_PUBLICATION_URL=https://example.invalid', '-e', 'SUBSTACK_SESSION_TOKEN=example-container-token', '-e', 'SUBSTACK_USER_ID=1', '-e', 'SUBSTACK_REQUEST_TIMEOUT_MS=1000'];
const status = JSON.parse(docker('run', '--rm', '--network', 'none', ...env, '--entrypoint', 'node', image, 'dist/index.js', 'status', '--json'));
assert.equal(status.version, pkg.version);
const catalog = async client => {
  assert.equal(client.getServerVersion().version, pkg.version);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 24);
  for (const name of ['get_publication', 'list_drafts', 'plan_draft_update', 'update_draft']) assert.ok(tools.some(tool => tool.name === name));
  for (const name of ['publish_post', 'delete_post', 'schedule_post']) assert.ok(!tools.some(tool => tool.name === name));
};
const prefix = `substack-smoke-${randomUUID()}`;
let stdio, http;
try {
  stdio = new Client({ name: 'container-stdio-check', version: '1' });
  await stdio.connect(new StdioClientTransport({ command: 'docker', args: ['run', '--name', `${prefix}-stdio`, '-i', '--rm', '--network', 'none', ...env, image], stderr: 'pipe' }));
  await catalog(stdio);
  await stdio.close(); stdio = undefined;
  docker('run', '-d', '--name', `${prefix}-http`, '--rm', '-p', '127.0.0.1::8080', ...env,
    '-e', 'MCP_TRANSPORT=http', '-e', 'MCP_HTTP_HOST=0.0.0.0', '-e', 'MCP_HTTP_TOKEN=example-http-token',
    '-e', 'MCP_HTTP_ALLOWED_HOSTS=127.0.0.1', image);
  const inspection = JSON.parse(docker('inspect', `${prefix}-http`))[0];
  const port = inspection.NetworkSettings.Ports['8080/tcp'][0].HostPort;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  // Explicit Host keeps the server allowlist exact despite an ephemeral host port.
  const headers = { Host: '127.0.0.1', Authorization: 'Bearer example-http-token' };
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { const response = await fetch(new URL('/health', url), { headers, signal: AbortSignal.timeout(1000) }); ready = response.status === 200; await response.arrayBuffer(); if (ready) break; }
    catch { /* bounded startup polling */ }
    await delay(250);
  }
  assert.ok(ready, 'HTTP container did not become ready');
  for (const authorization of [undefined, 'Bearer example-wrong-token']) {
    const response = await fetch(url, { method: 'POST', headers: { Host: '127.0.0.1', ...(authorization ? { Authorization: authorization } : {}) }, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 401); await response.arrayBuffer();
  }
  http = new Client({ name: 'container-http-check', version: '1' });
  await http.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  await catalog(http);
  console.log(JSON.stringify({ version: pkg.version, revision, user: 'node', stdio: true, authenticated_http: true, rejects_missing_and_wrong_bearer: true, live_api: false }));
} finally {
  await http?.close().catch(() => {}); await stdio?.close().catch(() => {});
  for (const suffix of ['stdio', 'http']) { try { docker('rm', '-f', `${prefix}-${suffix}`); } catch { /* already removed */ } }
}
