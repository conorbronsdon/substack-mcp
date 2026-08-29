import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const server = readJson('server.json');

const errors = [];
const requireEqual = (source, actual, expected) => {
  if (actual !== expected) {
    errors.push(`${source}: ${actual ?? '<missing>'} (expected ${expected})`);
  }
};

if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
  errors.push('package.json version is missing');
}
if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  errors.push('package.json name is missing');
}
if (typeof pkg.mcpName !== 'string' || pkg.mcpName.length === 0) {
  errors.push('package.json mcpName is missing');
}

requireEqual('package-lock.json version', lock.version, pkg.version);
requireEqual('package-lock.json name', lock.name, pkg.name);
requireEqual('package-lock.json root version', lock.packages?.['']?.version, pkg.version);
requireEqual('package-lock.json root name', lock.packages?.['']?.name, pkg.name);
requireEqual('server.json version', server.version, pkg.version);
requireEqual('server.json name', server.name, pkg.mcpName);

if (!Array.isArray(server.packages) || server.packages.length === 0) {
  errors.push('server.json packages must contain at least one package');
} else {
  server.packages.forEach((entry, index) => {
    requireEqual(`server.json packages[${index}] version`, entry.version, pkg.version);
    requireEqual(`server.json packages[${index}] identifier`, entry.identifier, pkg.name);
  });
}

if (errors.length > 0) {
  console.error('Release metadata is inconsistent:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release metadata agrees for ${pkg.name}@${pkg.version}.`);
