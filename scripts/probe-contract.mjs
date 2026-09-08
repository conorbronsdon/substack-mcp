// Explicitly opt-in, read-only live contract evidence. No private result content is logged.
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import packageMetadata from '../package.json' with { type: 'json' };
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolvePublications } from '../dist/auth/resolve-publications.js';
import { SubstackClient } from '../dist/api/client.js';
import { createServer } from '../dist/server.js';

if (process.env.SUBSTACK_CONTRACT_PROBE !== '1' || process.argv.slice(2).join(' ') !== '--read-only') {
  console.error('Disabled. Build first; set SUBSTACK_CONTRACT_PROBE=1 and explicitly pass --read-only. For multiple configured publications also set SUBSTACK_PROBE_PUBLICATION to a configured key. This performs authenticated reads, never writes.');
  process.exitCode = 2;
} else {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const report = { format_version: 1, captured_at: new Date().toISOString(), version: packageMetadata.version,
    node: process.version, client: 'MCP TypeScript SDK', transport: 'in_memory', live: true,
    write_attempts: 0, user_identity: 'not_verified', account_eligibility: 'not_independently_verified', checks: [], ok: false };
  let server, client;
  try {
    report.source_revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!/^[a-f0-9]{40}$/.test(report.source_revision)) throw new Error('Invalid source revision');
    const gitOptions = { cwd: sourceRoot, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] };
    execFileSync('git', ['diff', '--quiet'], gitOptions);
    execFileSync('git', ['diff', '--cached', '--quiet'], gitOptions);
    if (execFileSync('git', ['ls-files', '--others', '--exclude-standard'], gitOptions).trim()) throw new Error('Untracked source files');
    const publications = resolvePublications();
    const key = process.env.SUBSTACK_PROBE_PUBLICATION;
    const selected = key ? publications.find(p => p.key === key) : publications.length === 1 ? publications[0] : undefined;
    if (!selected || selected.missing.length) throw new Error('Invalid selection');
    const api = new SubstackClient(selected.publicationUrl, selected.sessionToken, selected.userId);
    const auth = await api.validateAuth();
    report.checks.push({ name: 'authenticated_read', ok: auth.authentication === 'authenticated_read_succeeded' });
    server = createServer([{ key: selected.key, label: 'Contract probe', client: api }]);
    client = new Client({ name: 'substack-contract-probe', version: packageMetadata.version });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const catalog = (await client.listTools()).tools;
    report.checks.push({ name: 'tool_discovery', ok: ['get_publication', 'list_drafts', 'get_subscriber_count'].every(name => catalog.some(tool => tool.name === name)) });
    for (const [name, args] of [['get_publication', {}], ['list_drafts', { offset: 0, limit: 1 }], ['get_subscriber_count', {}]]) {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
      const block = response.content?.[0];
      const value = block?.type === 'text' ? JSON.parse(block.text) : undefined;
      const matches = name === 'list_drafts' ? Array.isArray(value) : value && typeof value === 'object' && JSON.stringify(value) === JSON.stringify(response.structuredContent);
      report.checks.push({ name, ok: response.isError !== true && Boolean(matches) });
    }
    report.ok = report.checks.every(check => check.ok);
  } catch { report.checks.push({ name: 'setup_or_read', ok: false }); }
  finally { await client?.close().catch(() => {}); await server?.close().catch(() => {}); }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
