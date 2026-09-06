import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { CalendarSync } from '../worker';
import { describe, it, expect, vi } from 'vitest';
import worker from '../worker';

const state = () => ({ version: 1, publication_url: 'https://example.substack.com', organizer_email: 'host@example.org', contacts: {}, attempts: {}, seen_ids: [] });
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
    try {
      await runInDurableObject(stub, async (instance: CalendarSync) => { await expect(instance.run(true)).rejects.toThrow(); });
      expect((await stub.status()).runs[0]).toMatchObject({ status: 'failed', dry_run: true });
    } finally { mock.mockRestore(); }
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
