import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { SubstackClient } from '../src/api/client.js';
import { stateSchema, ingest, parseBooking, processContacts, type BookingMessage, type SyncState } from '../src/calendar-consent.js';

type Summary = Awaited<ReturnType<typeof processContacts>>;
type Run = { id: string; started_at: number; finished_at?: number; status: 'running' | 'ok' | 'failed'; scanned?: number; summary?: Summary; dry_run: boolean };
const credentialsSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1) });
const DAY = 86400000;

function authorized(request: Request, secret: string) {
  const value = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  return secret.length >= 32 && Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export class CalendarSync extends DurableObject<Env> {
  private running = false;

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error('A job is already running.');
    this.running = true;
    try { return await fn(); } finally { this.running = false; }
  }

  private async state(): Promise<SyncState> {
    const state = stateSchema.parse(await this.ctx.storage.get('state'));
    if (state.organizer_email !== this.env.ORGANIZER_EMAIL || state.publication_url !== this.env.PUBLICATION_URL) throw new Error('State configuration mismatch.');
    return state;
  }

  async initialize(value: unknown) {
    return this.exclusive(async () => {
      if (await this.ctx.storage.get('state')) throw new Error('Already initialized; refusing to overwrite the ledger.');
      const state = stateSchema.parse(value);
      if (state.organizer_email !== this.env.ORGANIZER_EMAIL || state.publication_url !== this.env.PUBLICATION_URL) throw new Error('State configuration mismatch.');
      await this.ctx.storage.put({ state, enabled: false, initialized_at: Date.now() });
      return { initialized: true, enabled: false, contacts: Object.keys(state.contacts).length, attempts: Object.keys(state.attempts).length };
    });
  }

  async enable(enabled: boolean) {
    return this.exclusive(async () => {
      await this.state();
      await this.ctx.storage.put('enabled', enabled);
      return { enabled };
    });
  }

  private async token() {
    const c = credentialsSchema.parse(JSON.parse(this.env.GOOGLE_CREDENTIALS));
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ ...c, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Google authentication failed.');
    return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
  }

  private async gmail(token: string, path: string, query?: Record<string, string>, body?: unknown) {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}${query ? '?' + new URLSearchParams(query) : ''}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Gmail operation failed.');
    return response.json();
  }

  async run(dryRun = true) {
    return this.exclusive(async () => {
      const state = await this.state();
      if (!dryRun && !await this.ctx.storage.get('enabled')) throw new Error('Live sync is paused.');
      const started = Date.now(), deadline = started + 7 * 60000;
      const run: Run = { id: crypto.randomUUID(), started_at: started, status: 'running', dry_run: dryRun };
      const runKey = `run:${String(started).padStart(16, '0')}:${run.id}`;
      await this.ctx.storage.put(runKey, run);
      let client: Client | undefined, server: ReturnType<typeof createServer> | undefined;
      try {
        const token = await this.token();
        const profile = z.object({ emailAddress: z.string() }).parse(await this.gmail(token, 'profile'));
        if (profile.emailAddress.toLowerCase() !== this.env.ORGANIZER_EMAIL.toLowerCase()) throw new Error('Wrong Gmail account.');
        const checkDeadline = () => { if (Date.now() > deadline) throw new Error('Scan deadline exceeded.'); };
        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
          checkDeadline();
          const page = z.object({ resultSizeEstimate: z.number().nonnegative(), messages: z.array(z.object({ id: z.string() })).optional(), nextPageToken: z.string().optional() }).parse(await this.gmail(token, 'messages', {
            q: `from:${this.env.ORGANIZER_EMAIL} subject:"Appointment booked" newer_than:180d`, maxResults: '100', ...(pageToken ? { pageToken } : {}),
          }));
          ids.push(...(page.messages ?? []).map(m => m.id)); pageToken = page.nextPageToken;
          if (ids.length > 500 || (pageToken && ids.length >= 500)) throw new Error('Scan cap exceeded.');
        } while (pageToken);
        const seen = new Set(state.seen_ids);
        for (const id of new Set(ids)) {
          if (seen.has(id)) continue;
          checkDeadline();
          const message = await this.gmail(token, `messages/${encodeURIComponent(id)}`, { format: 'full' }) as BookingMessage;
          if (message.id !== id) throw new Error('Mismatched message.');
          const contact = parseBooking(message, this.env.ORGANIZER_EMAIL);
          if (contact) ingest(state, contact);
          seen.add(id);
        }
        state.seen_ids = [...seen];
        if (!dryRun) await this.ctx.storage.put('state', state);
        const substack = new SubstackClient(this.env.PUBLICATION_URL, this.env.SUBSTACK_SESSION_TOKEN, this.env.SUBSTACK_USER_ID);
        await substack.subscribers.list(0, 1); // Verify subscriber API access even when the ledger is all terminal.
        server = createServer([{ key: 'default', label: 'Newsletter', client: substack }]);
        client = new Client({ name: 'cloud-calendar-sync', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);
        const active = client;
        const summary = await processContacts(state, async (name, args) => {
          checkDeadline();
          const result = await active.callTool({ name, arguments: args });
          if (result.isError) throw new Error('MCP operation failed.');
          const block = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text');
          if (!block?.text) throw new Error('Missing MCP result.');
          return JSON.parse(block.text);
        }, async () => { await this.ctx.storage.put('state', state); }, !dryRun, 5, this.env.SEND_WELCOME_EMAIL === 'true');
        Object.assign(run, { status: 'ok', scanned: ids.length, summary, finished_at: Date.now() });
        await this.ctx.storage.put(runKey, run);
        console.log(JSON.stringify({ event: 'calendar_sync', ...run }));
        return run;
      } catch {
        Object.assign(run, { status: 'failed', finished_at: Date.now() });
        await this.ctx.storage.put(runKey, run);
        console.error(JSON.stringify({ event: 'calendar_sync', ...run }));
        throw new Error('Calendar sync failed; inspect private state and credentials.');
      } finally { await client?.close(); await server?.close(); }
    });
  }

  async status() {
    const runs = [...(await this.ctx.storage.list<Run>({ prefix: 'run:', reverse: true, limit: 200 })).values()];
    const state = await this.state();
    return { enabled: await this.ctx.storage.get<boolean>('enabled') ?? false, initialized_at: await this.ctx.storage.get<number>('initialized_at') ?? null, runs,
      counts: { contacts: Object.keys(state.contacts).length, blocked: Object.values(state.attempts).filter(a => a.status === 'blocked').length,
        pending: Object.values(state.attempts).filter(a => ['attempting', 'unverified', 'retryable', 'busy'].includes(a.status)).length,
        review: Object.values(state.contacts).filter(c => c.decision === 'review').length } };
  }

  async report(force = false) {
    return this.exclusive(async () => {
      const now = Date.now();
      const local = new Intl.DateTimeFormat('en-US', { timeZone: this.env.REPORT_TIMEZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
      if (!force && (local.find(p => p.type === 'weekday')?.value !== 'Mon' || local.find(p => p.type === 'hour')?.value !== '09')) return { skipped: true };
      // A durable claim prevents repeated email sends after an ambiguous result.
      const reportKey = force ? 'report_test_attempt_at' : 'report_attempt_at';
      const last = await this.ctx.storage.get<number>(reportKey);
      if (last && now - last < 6 * DAY) return { skipped: true, reason: 'Already attempted this week.' };
      const status = await this.status();
      const runs = status.runs.filter(r => !r.dry_run && r.started_at >= now - 7 * DAY);
      const good = runs.filter(r => r.status === 'ok');
      const latest = good[0];
      const initialized = Number(status.initialized_at ?? now);
      const expected = Math.floor((now - Math.max(initialized, now - 7 * DAY)) / 3600000);
      const gaps = Math.max(0, expected - new Set(good.map(r => Math.floor(r.started_at / 3600000))).size);
      const stale = !latest || now - (latest.finished_at ?? latest.started_at) > 2 * 3600000;
      const failures = runs.filter(r => r.status !== 'ok').length;
      const needsAttention = stale || failures > 0 || gaps > 1 || status.counts.pending > 0 || !status.enabled;
      const state = await this.state();
      const newVerified = Object.values(state.attempts).filter(a => a.status === 'verified' && Date.parse(a.attempted_at) >= now - 7 * DAY).length;
      const subject = `Newsletter automation: ${needsAttention ? 'needs attention' : 'weekly check-in'}`;
      const body = [
        'Your Calendar-to-Substack automation check-in (last 7 days).', '',
        `Sync enabled: ${status.enabled}. Successful runs: ${good.length}. Failed/incomplete runs: ${failures}. Estimated missed hourly runs: ${gaps}.`,
        `Last successful run: ${latest?.finished_at ? new Date(latest.finished_at).toISOString() : 'none'}.`,
        `New additions verified this week: ${newVerified}.`,
        `Current items held for review: ${status.counts.blocked} blocked, ${status.counts.pending} uncertain, ${status.counts.review} ambiguous answers.`, '',
        'Welcome emails are requested for new additions when enabled; email delivery itself is not verified.',
        'Existing subscribers are skipped. Uncertain writes and blocked addresses are never automatically retried.',
        'This report is for the newsletter automation only, not your broader weekly review.',
      ].join('\r\n');
      const token = await this.token();
      const recipient = z.string().email().parse(this.env.ORGANIZER_EMAIL);
      const profile = z.object({ emailAddress: z.string() }).parse(await this.gmail(token, 'profile'));
      if (profile.emailAddress.toLowerCase() !== recipient.toLowerCase()) throw new Error('Wrong report account.');
      const raw = Buffer.from(`From: ${recipient}\r\nTo: ${recipient}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`).toString('base64url');
      await this.ctx.storage.put({ [reportKey]: now, report_status: 'attempting' });
      try {
        const sent = z.object({ id: z.string().min(1) }).parse(await this.gmail(token, 'messages/send', undefined, { raw }));
        await this.ctx.storage.put({ report_status: 'sent', report_message_id: sent.id });
        return { sent: true, needs_attention: needsAttention };
      } catch {
        await this.ctx.storage.put('report_status', 'unverified');
        throw new Error('Report delivery uncertain; do not automatically resend.');
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env.ADMIN_TOKEN)) return new Response('Unauthorized', { status: 401 });
    const instance = env.SYNC.getByName(env.PUBLICATION_URL);
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/status') return Response.json(await instance.status());
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      if (Number(request.headers.get('content-length') ?? 0) > 1024 * 1024) return new Response('Too large', { status: 413 });
      if (path === '/initialize') return Response.json(await instance.initialize(await request.json()));
      if (path === '/activate' || path === '/pause') return Response.json(await instance.enable(path === '/activate'));
      if (path === '/run') { const args = z.object({ dry_run: z.boolean().default(true) }).strict().parse(await request.json()); return Response.json(await instance.run(args.dry_run)); }
      if (path === '/report') return Response.json(await instance.report(true));
      return new Response('Not found', { status: 404 });
    } catch { return Response.json({ error: 'Operation failed; check private configuration and job status.' }, { status: 500 }); }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const instance = env.SYNC.getByName(env.PUBLICATION_URL);
    ctx.waitUntil(controller.cron.startsWith('20 ') ? instance.report() : instance.run(false));
  },
} satisfies ExportedHandler<Env>;
