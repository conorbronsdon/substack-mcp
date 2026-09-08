import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'substack-package-'));
// npm supplies its JS entrypoint: avoid platform-dependent shell/bin quoting.
assert.ok(process.env.npm_execpath, 'Run through npm run test:package');
const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
  cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  // npm 11 forwards this global setting into lifecycle environments, then
  // rejects it in a project install. Scripts remain disabled explicitly.
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_allow_scripts')),
});
const expectedTools = [
  'export_draft',
  'add_free_subscriber', 'create_draft', 'create_note', 'create_note_with_link',
  'get_draft', 'get_post', 'get_post_analytics', 'get_post_comments', 'get_sections',
  'get_subscriber', 'get_subscriber_count', 'list_drafts', 'list_published_posts',
  'list_scheduled_posts', 'list_subscribers', 'update_draft', 'upload_image',
  'search_posts', 'preflight_draft', 'plan_draft_update',
  'get_publication',
  'list_publication_tags', 'get_post_tags',
].sort();

const requiredFiles = ['package.json', 'server.json', 'README.md', 'LICENSE', 'CHANGELOG.md',
  'docs/calendar-sync.md', 'docs/cloud-calendar-sync.md', 'docs/subscribers.md', 'docs/authoring.md', 'docs/export.md', 'docs/draft-changes.md',
  'docs/workflow.md', 'dist/index.js', 'dist/login.js'];
let transport;
try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], process.cwd()));
  const paths = new Set(packed.files.map(file => file.path));
  for (const path of requiredFiles) assert.ok(paths.has(path), `Missing package file: ${path}`);
  for (const { path } of packed.files) {
    assert.ok(path.startsWith('dist/') || requiredFiles.includes(path), `Unexpected package file: ${path}`);
    assert.ok(!path.includes('__tests__') && !path.endsWith('.map'), `Development artifact: ${path}`);
  }
  npm(['install', '--prefix', scratch, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename)], scratch);
  const installed = join(scratch, 'node_modules', ...pkg.name.split('/'));
  const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(installedPkg.version, pkg.version);
  for (const bin of Object.values(installedPkg.bin)) assert.ok(existsSync(resolve(installed, bin)), `Missing bin: ${bin}`);
  const help = execFileSync(process.execPath, [resolve(installed, installedPkg.bin['substack-mcp-login']), '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.match(help, /Usage: substack-mcp-login/);

  const requireInstalled = createRequire(join(installed, 'package.json'));
  const { Client } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  // A deliberately tiny environment excludes actual credentials and multi-publication config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key) && value !== undefined));
  const testSessionToken = randomUUID();
  Object.assign(env, {
    SUBSTACK_MCP_HOME: join(scratch, 'empty-session'),
    SUBSTACK_PUBLICATION_URL: 'http://127.0.0.1:1',
    SUBSTACK_USER_ID: '0', SUBSTACK_SESSION_TOKEN: testSessionToken,
    SUBSTACK_REQUEST_TIMEOUT_MS: '100', MCP_TRANSPORT: 'stdio',
  });
  const cli = resolve(installed, installedPkg.bin['substack-mcp']);
  assert.match(execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8', timeout: 10_000 }), /Usage: substack-mcp/);
  assert.match(execFileSync(process.execPath, [cli, 'export', '--help'], { env, encoding: 'utf8', timeout: 10_000 }), /source\.json/);
  assert.throws(() => execFileSync(process.execPath, [cli, 'export', '-1'], { env, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' }), error => error.status === 2);
  assert.match(execFileSync(process.execPath, [cli, 'drafts', '--help'], { env, encoding: 'utf8', timeout: 10_000 }), /drafts apply/);
  assert.throws(() => execFileSync(process.execPath, [cli, 'drafts', 'apply'], { env, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' }), error => error.status === 2);
  const doctorEnv = { ...env, SUBSTACK_PUBLICATION_URL: 'https://example.invalid', SUBSTACK_USER_ID: '1' };
  const diagnosis = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--json'], { env: doctorEnv, encoding: 'utf8', timeout: 10_000 }));
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.mode, 'configuration_only');
  assert.equal(diagnosis.publications[0].authentication, 'not_checked');
  assert.ok(!JSON.stringify(diagnosis).includes(testSessionToken), 'Doctor must not print session tokens');
  for (const [args, commandEnv, status] of [
    [['doctor', '--json'], env, 1],
    [['doctor', '--unknown'], doctorEnv, 2],
    [['unknown'], doctorEnv, 2],
  ]) {
    assert.throws(() => execFileSync(process.execPath, [cli, ...args], { env: commandEnv, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' }), error => error.status === status);
  }
  for (const overrides of [
    { SUBSTACK_PUBLICATION_URL: '', SUBSTACK_SESSION_TOKEN: '', SUBSTACK_USER_ID: '' },
    { SUBSTACK_PUBLICATION_URL: 'https://example.invalid/path' },
    { SUBSTACK_USER_ID: '1partial' },
    { SUBSTACK_SESSION_TOKEN: `${testSessionToken}; other=value` },
    { SUBSTACK_PUB_A_PUBLICATION_URL: 'https://example.invalid', SUBSTACK_PUB_A_SESSION_TOKEN: testSessionToken, SUBSTACK_PUB_A_USER_ID: '1',
      SUBSTACK_PUB_B_PUBLICATION_URL: 'https://example.invalid', SUBSTACK_PUB_B_SESSION_TOKEN: testSessionToken, SUBSTACK_PUB_B_USER_ID: '0' },
  ]) {
    assert.throws(() => execFileSync(process.execPath, [cli, 'serve'], { env: { ...doctorEnv, ...overrides }, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' }), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /Invalid (publication URL|SUBSTACK_USER_ID|session token)/);
      assert.ok(!error.stderr.includes(testSessionToken), 'Startup must not print session tokens');
      assert.ok(!error.stderr.includes('server running'), 'Invalid configuration must fail before connection');
      assert.ok(error.stderr.includes('substack-mcp doctor --json'), 'Startup must explain the diagnostic command');
      assert.ok(!/\n\s+at /.test(error.stderr), 'Configuration failures should not dump a stack');
      if (overrides.SUBSTACK_PUB_B_USER_ID) assert.match(error.stderr, /publication "b"/);
      return true;
    });
  }
  // Startup validates the same config as doctor. Its background auth read may
  // attempt the reserved .invalid host, bounded by the synthetic 100ms deadline.
  transport = new StdioClientTransport({ command: process.execPath, args: [resolve(installed, installedPkg.bin['substack-mcp'])], env: doctorEnv, stderr: 'pipe' });
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  await client.connect(transport, { timeout: 10_000 });
  assert.equal(client.getServerVersion()?.version, pkg.version, 'MCP handshake version must match npm');
  const { tools } = await client.listTools({}, { timeout: 10_000 });
  assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
  for (const tool of tools) assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `Missing annotation: ${tool.name}`);
  console.log(`Installed ${pkg.name}@${pkg.version}: ${packed.files.length} files, both bins load, handshake version agrees, all ${tools.length} tools present.`);
} finally {
  await transport?.close();
  // Only remove the unique directory created above, never a caller-supplied path.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
