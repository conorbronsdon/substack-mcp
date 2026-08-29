import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const server = readJson('server.json');

const versions = [
  ['package-lock.json', lock.version],
  ['package-lock.json root package', lock.packages?.['']?.version],
  ['server.json', server.version],
  ...((server.packages ?? []).map((entry, index) => [
    `server.json packages[${index}]`,
    entry.version,
  ])),
];

const mismatches = versions.filter(([, version]) => version !== pkg.version);

if (mismatches.length > 0) {
  console.error(`Release metadata must match package.json version ${pkg.version}:`);
  for (const [source, version] of mismatches) {
    console.error(`- ${source}: ${version ?? '<missing>'}`);
  }
  process.exit(1);
}

console.log(`Release metadata agrees at ${pkg.version}.`);
