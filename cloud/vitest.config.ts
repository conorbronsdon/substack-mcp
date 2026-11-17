import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { adminToken, googleCredentials, substackSessionToken } from './test/fixtures';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './cloud/wrangler.jsonc' }, miniflare: { bindings: {
    ADMIN_TOKEN: adminToken,
    GOOGLE_CREDENTIALS: googleCredentials,
    SUBSTACK_SESSION_TOKEN: substackSessionToken, SUBSTACK_USER_ID: '1',
  } } })],
  test: { include: ['cloud/test/**/*.test.ts'] },
});
