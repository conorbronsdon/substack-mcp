import { setTimeout as delay } from 'node:timers/promises';

export async function waitForHealth(url, headers, { fetchImpl = fetch, totalBudgetMs = 30_000, attemptTimeoutMs = 1_000, retryDelayMs = 250 } = {}) {
  const started = performance.now();
  let attempts = 0;
  let lastError = new Error('No health response');
  while (performance.now() - started < totalBudgetMs) {
    const remaining = totalBudgetMs - (performance.now() - started);
    const controller = new AbortController();
    // A regular timer keeps Node alive while fetch is pending; AbortSignal.timeout does not.
    const timeout = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remaining));
    attempts++;
    try {
      const response = await fetchImpl(new URL('/health', url), { headers, signal: controller.signal });
      await response.arrayBuffer();
      if (response.status === 200) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
    const wait = totalBudgetMs - (performance.now() - started);
    if (wait <= 0) break;
    await delay(Math.min(retryDelayMs, wait));
  }
  throw new Error(`HTTP container did not become ready after ${attempts} attempts in ${Math.round(performance.now() - started)} ms: ${lastError.message}`);
}
