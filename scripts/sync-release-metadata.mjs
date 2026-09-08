import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));
const plugin = JSON.parse(readFileSync('.codex-plugin/plugin.json', 'utf8'));
const mcp = JSON.parse(readFileSync('.mcp.json', 'utf8'));
const claude = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
const marketplace = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));

if (!mcp.mcpServers?.substack || typeof mcp.mcpServers.substack !== 'object') {
  throw new Error('.mcp.json must contain the substack server before release synchronization');
}

server.name = pkg.mcpName;
server.version = pkg.version;
for (const entry of server.packages ?? []) {
  entry.version = pkg.version;
  if (entry.registryType === 'npm') entry.identifier = pkg.name;
}

writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
plugin.version = pkg.version;
claude.version = pkg.version;
marketplace.plugins[0].version = pkg.version;
writeFileSync('.claude-plugin/plugin.json', `${JSON.stringify(claude, null, 2)}\n`);
writeFileSync('.claude-plugin/marketplace.json', `${JSON.stringify(marketplace, null, 2)}\n`);
mcp.mcpServers.substack.args = ['-y', `${pkg.name}@${pkg.version}`];
writeFileSync('.codex-plugin/plugin.json', `${JSON.stringify(plugin, null, 2)}\n`);
writeFileSync('.mcp.json', `${JSON.stringify(mcp, null, 2)}\n`);
console.log(`Synchronized server.json for ${pkg.name}@${pkg.version}.`);
