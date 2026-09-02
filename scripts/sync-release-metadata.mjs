import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

server.name = pkg.mcpName;
server.version = pkg.version;
for (const entry of server.packages ?? []) {
  entry.version = pkg.version;
  if (entry.registryType === 'npm') entry.identifier = pkg.name;
}

writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
console.log(`Synchronized server.json for ${pkg.name}@${pkg.version}.`);
