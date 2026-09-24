import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const names = ['package.json', 'package-lock.json', 'server.json', '.mcp.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const source = Object.fromEntries(names.map(name => [name, JSON.parse(readFileSync(name, 'utf8'))]));
const containerGuide = readFileSync('docs/containers.md', 'utf8');
const check = resolve('scripts/check-release-metadata.mjs');
const sync = resolve('scripts/sync-release-metadata.mjs');
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'substack-release-control-'));
  mkdirSync(join(dir, '.codex-plugin'));
  mkdirSync(join(dir, '.claude-plugin'));
  mkdirSync(join(dir, 'docs'));
  const write = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data));
  for (const name of names) write(name, source[name]);
  writeFileSync(join(dir, 'docs/containers.md'), containerGuide);
  const exec = script => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  try { run({ write, exec, dir }); }
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

for (const example of [1, 2, 3]) {
  test(`stale container image example ${example} fails and synchronization repairs it`, () => fixture(({ dir, exec }) => {
    const file = join(dir, 'docs/containers.md');
    let seen = 0;
    const stale = containerGuide.replace(/ghcr\.io\/conorbronsdon\/substack-mcp:[0-9]+\.[0-9]+\.[0-9]+/g, match => {
      seen += 1;
      return seen === example ? 'ghcr.io/conorbronsdon/substack-mcp:0.0.0' : match;
    });
    assert.equal(seen, 3);
    writeFileSync(file, stale);
    const failure = exec(check);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, new RegExp(`docs/containers\\.md image example ${example}`));
    assert.equal(exec(sync).status, 0);
    assert.equal(readFileSync(file, 'utf8'), containerGuide);
    assert.equal(exec(check).status, 0);
  }));
}

test('missing container image example blocks checking and synchronization', () => fixture(({ dir, exec }) => {
  const file = join(dir, 'docs/containers.md');
  const missing = containerGuide.replace(`ghcr.io/conorbronsdon/substack-mcp:${source['package.json'].version}`,
    'ghcr.io/conorbronsdon/substack-mcp:<version>');
  assert.notEqual(missing, containerGuide);
  writeFileSync(file, missing);
  assert.match(exec(check).stderr, /docs\/containers\.md current image example count/);
  assert.notEqual(exec(sync).status, 0);
  assert.equal(readFileSync(file, 'utf8'), missing);
}));
