import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const names = ['package.json', 'package-lock.json', 'server.json', '.mcp.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const source = Object.fromEntries(names.map(name => [name, JSON.parse(readFileSync(name, 'utf8'))]));
const check = resolve('scripts/check-release-metadata.mjs');
const sync = resolve('scripts/sync-release-metadata.mjs');
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'substack-release-control-'));
  mkdirSync(join(dir, '.codex-plugin'));
  mkdirSync(join(dir, '.claude-plugin'));
  const write = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data));
  for (const name of names) write(name, source[name]);
  const exec = script => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  try { run({ write, exec }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('aligned release metadata passes', () => fixture(({ exec }) => {
  assert.equal(exec(check).status, 0);
}));

for (const name of ['.codex-plugin/plugin.json', '.mcp.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
  test(`stale ${name} fails and synchronization repairs it`, () => fixture(({ write, exec }) => {
    const stale = structuredClone(source[name]);
    if (name === '.mcp.json') stale.mcpServers.substack.args[1] = `${source['package.json'].name}@0.0.0`;
    else if (name === '.claude-plugin/marketplace.json') stale.plugins[0].version = '0.0.0';
    else stale.version = '0.0.0';
    write(name, stale);
    const failure = exec(check);
    assert.equal(failure.status, 1);
    assert.ok(failure.stderr.includes(name), failure.stderr);
    assert.equal(exec(sync).status, 0);
    assert.equal(exec(check).status, 0);
  }));
}

test('oversized Registry description is rejected', () => fixture(({ write, exec }) => {
  write('server.json', { ...source['server.json'], description: 'x'.repeat(101) });
  const failure = exec(check);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /1-100 characters/);
}));
