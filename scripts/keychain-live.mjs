import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createKeychain, CredentialStoreError } from '../dist/auth/keychain.js';

const keychain = createKeychain();
const account = `example-ci-${randomUUID()}`;
const session = {
  publicationUrl: 'https://example-ci.substack.com',
  sessionToken: `example-ci-token-${randomUUID()}`,
  userId: '1',
};

async function check(name, run) {
  try {
    await run();
    console.log(`${name}: PASS`);
  } catch {
    console.log(`${name}: FAIL`);
    process.exitCode = 1;
    throw new Error('Keychain check failed');
  }
}

try {
  await check('read absent', async () => assert.equal(await keychain.read(account), null));
  await check('write force', () => keychain.write(account, session, true));
  await check('read matches', async () => {
    const stored = await keychain.read(account);
    assert.ok(stored);
    assert.equal(stored.publicationUrl, session.publicationUrl);
    assert.equal(stored.sessionToken, session.sessionToken);
    assert.equal(stored.userId, session.userId);
  });
  await check('write without force rejects existing', () => assert.rejects(
    keychain.write(account, session, false),
    error => error instanceof CredentialStoreError && error.code === 'profile_exists',
  ));
  await check('availability probe', async () => assert.equal(await keychain.available(), true));
} catch {
  // The step already reported failure without revealing credential values.
} finally {
  try {
    await check('delete', () => keychain.delete(account));
    await check('read after delete', async () => assert.equal(await keychain.read(account), null));
  } catch {
    // Cleanup and post-delete checks also report failures without credential values.
  }
}
