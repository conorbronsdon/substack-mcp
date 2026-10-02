import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { CalendarSync } from '../worker';
import { describe, it, expect, vi } from 'vitest';
import worker from '../worker';
import { adminToken } from './fixtures';

const state = () => ({ version: 1, publication_url: 'https://example.substack.com', organizer_email: 'host@example.org', contacts: {}, attempts: {}, seen_ids: [] });
const accessToken = 'example-access-token';
const expectSanitized = (value: unknown) => {
  const serialized = JSON.stringify(value);
  for (const secret of ['host@example.org', accessToken, JSON.parse(env.GOOGLE_CREDENTIALS).refresh_token]) expect(serialized).not.toContain(secret);
};
describe('cloud scheduling and durable state', () => {
  it('denies unauthenticated administration', async () => {
    const response = await worker.fetch(new Request('https://test/status'), env);
    expect(response.status).toBe(401);
  });
  it('requires explicit initialization and refuses an overwritten ledger', async () => {
    const stub = env.SYNC.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: CalendarSync) => { await expect(instance.enable(true)).rejects.toThrow(); });
    expect(await stub.initialize(state())).toMatchObject({ initialized: true, enabled: false });
    await runInDurableObject(stub, async (instance: CalendarSync) => { await expect(instance.initialize(state())).rejects.toThrow('Already initialized'); });
    expect(await stub.enable(true)).toEqual({ enabled: true });
    expect((await stub.status()).enabled).toBe(true);
  });
  it('rejects imported state for a different publication', async () => {
    const stub = env.SYNC.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: CalendarSync) => { await expect(instance.initialize({ ...state(), publication_url: 'https://other.substack.com' })).rejects.toThrow('mismatch'); });
  });
  it('will not execute live work while paused', async () => {
    const stub = env.SYNC.getByName(crypto.randomUUID());
    await stub.initialize(state());
    await runInDurableObject(stub, async (instance: CalendarSync) => { await expect(instance.run(false)).rejects.toThrow('paused'); });
    expect((await stub.status()).runs).toHaveLength(0);
  });
  it('records authentication failure instead of reporting a healthy run', async () => {
    const stub = env.SYNC.getByName(crypto.randomUUID());
    await stub.initialize(state());
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance: CalendarSync, ctx) => {
        await expect(instance.run(true)).rejects.toThrow('stage google_token');
        const runs = [...(await ctx.storage.list({ prefix: 'run:' })).values()];
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: 'failed', dry_run: true, failure_stage: 'google_token' });
        expectSanitized(runs);
      });
      expect((await stub.status()).runs[0]).toMatchObject({ status: 'failed', dry_run: true, failure_stage: 'google_token' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'calendar_sync', failure_stage: 'google_token' });
      expectSanitized(log.mock.calls);
    } finally { mock.mockRestore(); log.mockRestore(); }
  });
  it.each(['gmail_scan', 'gmail_profile', 'substack_auth'] as const)('records sanitized failure at %s', async failureStage => {
    const stub = env.SYNC.getByName(crypto.randomUUID());
    await stub.initialize(state());
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: accessToken });
      if (url.endsWith('/profile')) return Response.json({ emailAddress: failureStage === 'gmail_profile' ? 'other@example.org' : 'host@example.org' });
      const privateBody = JSON.stringify({ error: `host@example.org ${accessToken} ${JSON.parse(env.GOOGLE_CREDENTIALS).refresh_token}` });
      if (url.includes('gmail.googleapis.com') && url.includes('/messages?')) return failureStage === 'gmail_scan' ? new Response(privateBody, { status: 500 }) : Response.json({ resultSizeEstimate: 0 });
      if (url === 'https://example.substack.com/api/v1/subscriber-stats') return new Response(privateBody, { status: 401 });
      throw new Error('Unexpected outbound request');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance: CalendarSync, ctx) => {
        await expect(instance.run(true)).rejects.toThrow(`stage ${failureStage}`);
        const runs = [...(await ctx.storage.list({ prefix: 'run:' })).values()];
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: 'failed', dry_run: true, failure_stage: failureStage });
        expectSanitized(runs);
      });
      expect((await stub.status()).runs[0]).toMatchObject({ failure_stage: failureStage });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'calendar_sync', status: 'failed', failure_stage: failureStage });
      expectSanitized(log.mock.calls);
    } finally { mock.mockRestore(); log.mockRestore(); }
  });
  it('gives the deadline precedence over the scan stage', async () => {
    const stub = env.SYNC.getByName(crypto.randomUUID());
    await stub.initialize(state());
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).includes('oauth2.googleapis.com')) return Response.json({ access_token: accessToken });
      if (String(input).endsWith('/profile')) { time.mockReturnValue(now + 7 * 60000 + 1); return Response.json({ emailAddress: 'host@example.org' }); }
      throw new Error('Unexpected outbound request');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance: CalendarSync) => { await expect(instance.run(true)).rejects.toThrow('stage deadline'); });
      expect((await stub.status()).runs[0]).toMatchObject({ status: 'failed', failure_stage: 'deadline' });
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ failure_stage: 'deadline' });
      expectSanitized(log.mock.calls);
    } finally { mock.mockRestore(); log.mockRestore(); time.mockRestore(); }
  });
});

it("sends an aggregate report once and retains its delivery claim", async () => {
  const stub=env.SYNC.getByName(crypto.randomUUID());
  await stub.initialize(state());
  let sent=0, message="";
  const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init)=>{
    const url=String(input);
    if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'test'});
    if(url.endsWith('/profile'))return Response.json({emailAddress:'host@example.org'});
    if(url.endsWith('/messages/send')) { sent++;message=Buffer.from(JSON.parse(String(init?.body)).raw,'base64url').toString();return Response.json({id:'test-report'}); }
    throw new Error('Unexpected outbound request');
  });
  try {
    expect(await stub.report(true)).toMatchObject({sent:true,needs_attention:true});
    expect(await stub.report(true)).toMatchObject({skipped:true});
    expect(sent).toBe(1);
    expect(message).toContain('Successful runs: 0');
    expect(message).toContain('New additions verified this week: 0');
    expect(message).not.toContain('refresh_token');
    await runInDurableObject(stub, async (_instance,ctx)=>{expect(await ctx.storage.get('report_status')).toBe('sent');});
  } finally {mock.mockRestore();}
});
it("does not repeat a report whose send outcome is uncertain", async()=>{
  const stub=env.SYNC.getByName(crypto.randomUUID());await stub.initialize(state());
  let sent=0;
  const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
    if(String(input).includes('oauth2.googleapis.com'))return Response.json({access_token:'test'});
    if(String(input).endsWith('/profile'))return Response.json({emailAddress:'host@example.org'});
    sent++;throw new Error('Network lost after send');
  });
  try {
    await runInDurableObject(stub,async(instance:CalendarSync)=>{await expect(instance.report(true)).rejects.toThrow('uncertain');});
    expect(await stub.report(true)).toMatchObject({skipped:true});expect(sent).toBe(1);
  } finally {mock.mockRestore();}
});

it("runs the registered MCP add with durable state and never repeats its welcome request", async()=>{
  const stub=env.SYNC.getByName(crypto.randomUUID());
  const {contactKey}=await import('../../src/calendar-consent');
  const email='reader@example.org', key=contactKey(email), initial=state();
  const imported={...initial,contacts:{[key]:{email,answer:'Yes',decision:'yes',message_id:'test-booking',received_at:Date.now()}}};
  await stub.initialize(imported);await stub.enable(true);
  let adds=0;
  let inspectAttempt: () => Promise<string | undefined> = async()=>undefined;
  const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const url=String(input);
    if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'test'});
    if(url.endsWith('/profile'))return Response.json({emailAddress:'host@example.org'});
    if(url.includes('gmail.googleapis.com')&&url.includes('/messages?'))return Response.json({resultSizeEstimate:0});
    if(url.endsWith('/subscriber-stats'))return Response.json(adds?{count:1,subscribers:[{user_email_address:email,subscription_id:123,subscription_interval:'free'}]}:{count:0,subscribers:[]});
    if(url.endsWith('/subscriber/add')) {
      expect(JSON.parse(String(init?.body))).toEqual({email,subscription:false,sendEmail:true});
      expect(await inspectAttempt()).toBe('attempting');
      adds++;return Response.json({});
    }
    throw new Error('Unexpected request');
  });
  try {
    await runInDurableObject(stub,async(instance:CalendarSync,ctx)=>{
      inspectAttempt=async()=>{const saved=await ctx.storage.get<{attempts:Record<string,{status:string}>}>('state');return saved?.attempts[key].status;};
      expect((await instance.run(false)).summary?.verified).toBe(1);
    });
    expect((await stub.run(false)).summary?.submitted).toBe(0);
    expect(adds).toBe(1);
  } finally {mock.mockRestore();}
});

describe('ledger export', () => {
  const populated = () => ({ ...state(), seen_ids: ['m1', 'm2'],
    contacts: { a: { email: 'reader@example.org', answer: 'Yes', decision: 'yes' as const, message_id: 'm1', received_at: 1 }, b: { email: 'other@example.org', answer: 'Maybe', decision: 'review' as const, message_id: 'm2', received_at: 2 } },
    attempts: { a: { status: 'verified' as const, message_id: 'm1', attempted_at: '2026-09-01T00:00:00.000Z', welcome_email_requested: true }, c: { status: 'blocked' as const, message_id: 'm0', attempted_at: '2026-08-01T00:00:00.000Z' },
      d: { status: 'attempting' as const, message_id: 'm3', attempted_at: '2026-09-02T00:00:00.000Z', welcome_email_requested: false }, e: { status: 'unverified' as const, message_id: 'm4', attempted_at: '2026-09-03T00:00:00.000Z' } } });
  const call = (path: string, init: RequestInit = {}, token = adminToken) => worker.fetch(new Request(`https://test${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } }), env);
  it('round-trips the imported ledger through the admin routes and refuses unsafe exports', async () => {
    expect((await call('/export', {}, 'x'.repeat(40))).status).toBe(401);
    expect((await call('/export')).status).toBe(500); // Not initialized.
    const imported = populated();
    expect((await call('/initialize', { method: 'POST', body: JSON.stringify(imported) })).status).toBe(200);
    expect((await call('/export', { method: 'POST', body: '{}' })).status).toBe(404);
    const exported = await call('/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    expect(await exported.json()).toEqual(imported);
    expect((await call('/activate', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await call('/export')).status).toBe(500); // Live job must be paused first.
    expect((await call('/pause', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(await (await call('/export')).json()).toEqual(imported);
  });
  it('exports a ledger that a fresh object accepts unchanged', async () => {
    const source = env.SYNC.getByName(crypto.randomUUID()), target = env.SYNC.getByName(crypto.randomUUID());
    await source.initialize(populated());
    const exported = await source.export();
    await target.initialize(exported);
    expect(await target.export()).toEqual(exported);
    expect(exported).toEqual(populated());
  });
  it('refuses to export while a job holds the ledger', async () => {
    const stub = env.SYNC.getByName(crypto.randomUUID());
    await stub.initialize(populated());
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    let entered: () => void = () => {};
    const started = new Promise<void>(r => { entered = r; });
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { entered(); await gate; return new Response('{}', { status: 401 }); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance: CalendarSync) => {
        const run = instance.run(true);
        await started;
        await expect(instance.export()).rejects.toThrow('already running');
        release();
        await expect(run).rejects.toThrow('stage google_token');
        expect(await instance.export()).toEqual(populated());
      });
    } finally { mock.mockRestore(); log.mockRestore(); }
  });
});
