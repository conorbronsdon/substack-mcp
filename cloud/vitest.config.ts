import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { adminToken } from './test/fixtures';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './cloud/wrangler.jsonc' }, miniflare: { bindings: {
    ADMIN_TOKEN: adminToken,
    GOOGLE_CREDENTIALS: JSON.stringify({ client_id: 'test', client_secret: 'test', refresh_token: 'test' }),
    SUBSTACK_SESSION_TOKEN: 'test', SUBSTACK_USER_ID: '1',
  } } })],
  test: { include: ['cloud/test/**/*.test.ts'] },
});
