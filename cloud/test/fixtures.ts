// Synthetic test-only binding; never use it to configure a deployed worker.
export const adminToken = 'example-test-token-with-more-than-thirty-two-characters';
// Synthetic test-only Google OAuth and Substack bindings, kept in this fixtures
// file (not the vitest config) so secret scanners treat them as test data.
export const googleCredentials = JSON.stringify({
  client_id: 'example-client-id',
  client_secret: 'example-client-secret',
  refresh_token: 'example-refresh-token',
});
export const substackSessionToken = 'example-session-token';
