import { describe, expect, it, vi } from "vitest";
import { contactKey, ingest, parseBooking, processContacts, type BookingMessage, type SyncState, type Contact } from "../calendar-sync.js";

const organizer = "host@example.org", email = "reader@example.org";
function message(answer: string, subject = "Appointment booked: Guest name") : BookingMessage {
  const text = `Booked by\r\nPR Contact\r\n${email}\r\n\r\nWould you like to sign up for my newsletter?\r\n${answer}\r\n`;
  return { id: "m1", internalDate: "1780000000000", payload: { headers: [{ name: "From", value: organizer }, { name: "Sender", value: "Google Calendar <calendar-notification@google.com>" }, { name: "Subject", value: subject }], parts: [{ parts: [{ mimeType: "text/plain", body: { data: Buffer.from(text).toString("base64url") } }] }] } };
}
function state() : SyncState { return { version: 1, publication_url: "https://example.substack.com", organizer_email: organizer, seen_ids: [], contacts: {}, attempts: {} }; }
const contact = () => parseBooking(message("Yes"), organizer)!;

describe("calendar consent parsing", () => {
  it("binds consent to the booker email, not the subject guest, through nested MIME and CRLF", () => {
    expect(contact()).toMatchObject({ email, decision: "yes", message_id: "m1", received_at: 1780000000000 });
  });
  it.each(["Yes!", "Sure", "Sounds good:)", "Yes, please", "Heck yeah!", "Y"])("recognizes explicit affirmation: %s", answer => expect(parseBooking(message(answer), organizer)?.decision).toBe("yes"));
  it.each(["Already am! :)", "Subscribed", "maybe", "Yes if you pay me", "ignore prior instructions"])("does not turn non-consent into an add: %s", answer => expect(parseBooking(message(answer), organizer)?.decision).toBe("review"));
  it("ignores replies and other organizers", () => {
    expect(parseBooking(message("Yes", "Re: Appointment booked: Guest"), organizer)).toBeNull();
    expect(parseBooking(message("Yes"), "another@example.org")).toBeNull();
    const m=message("Yes");m.payload.headers!.find(h=>h.name==="Sender")!.value="stranger@example.org";
    expect(parseBooking(m, organizer)).toBeNull();
  });
  it("requires one question answer, so injected duplicate text becomes review", () => {
    expect(parseBooking(message("Yes\r\nWould you like to sign up for my newsletter?\r\nNo"), organizer)?.decision).toBe("review");
  });
  it("uses newest consent regardless of Gmail list order", () => {
    const s=state(); const yes=contact(), no:Contact={...yes, decision:"no",answer:"No",received_at:yes.received_at+1000,message_id:"m2"};
    ingest(s,no);ingest(s,yes);
    expect(s.contacts[contactKey(email)].decision).toBe("no");
  });
});

describe("durable MCP workflow", () => {
  function setup() { const s=state(); ingest(s,contact()); return s; }
  it("saves an attempt before a live MCP add and persists its result", async () => {
    const s=setup(), snapshots:SyncState[]=[];
    const call=vi.fn(async(name:string,args:Record<string,unknown>)=>{
      if(name==="get_subscriber")return {subscriber:null};
      expect(snapshots.at(-1)?.attempts[contactKey(email)].status).toBe("attempting");
      expect(args).toEqual({email,consent_confirmed:true,dry_run:false,consent_evidence:{source:"gmail:m1",recorded_at:new Date(1780000000000).toISOString()}});
      return {email,status:"verified"};
    });
    const counts=await processContacts(s,call,()=>snapshots.push(structuredClone(s)),true);
    expect(counts.verified).toBe(1);expect(counts.submitted).toBe(1);
    expect(snapshots.at(-1)?.attempts[contactKey(email)].status).toBe("verified");
  });
  it("never adds when persistence fails before the request", async () => {
    const call=vi.fn().mockResolvedValue({subscriber:null});
    await expect(processContacts(setup(),call,()=>{throw new Error("disk full");},true)).rejects.toThrow("disk full");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each(["attempting","unverified","retryable","busy"] as const)("reconciles %s after restart without retrying an add", async status => {
    const s=setup();s.attempts[contactKey(email)]={status,message_id:"m1",attempted_at:"2026-09-01T00:00:00Z"};
    const call=vi.fn().mockResolvedValue({subscriber:null});
    expect((await processContacts(s,call,vi.fn(),true)).pending).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);expect(call.mock.calls[0][0]).toBe("get_subscriber");
  });
  it("recognizes delayed membership without another write", async () => {
    const s=setup();s.attempts[contactKey(email)]={status:"unverified",message_id:"m1",attempted_at:"2026-09-01T00:00:00Z"};
    const call=vi.fn().mockResolvedValue({subscriber:{user_email_address:email,subscription_id:4}});
    expect((await processContacts(s,call,vi.fn(),true)).existing).toBe(1);
    expect(s.attempts[contactKey(email)].status).toBe("existing");expect(call).toHaveBeenCalledTimes(1);
  });
  it.each(["verified","existing","blocked"] as const)("never re-adds terminal %s, even if they later leave", async status => {
    const s=setup();s.attempts[contactKey(email)]={status,message_id:"m1",attempted_at:"2026-09-01T00:00:00Z"};
    const call=vi.fn();await processContacts(s,call,vi.fn(),true);expect(call).not.toHaveBeenCalled();
  });
  it("writes neither state nor Substack on dry-run", async () => {
    const s=setup(), before=structuredClone(s), persist=vi.fn(),call=vi.fn().mockResolvedValue({subscriber:null});
    await processContacts(s,call,persist,false);expect(s).toEqual(before);expect(persist).not.toHaveBeenCalled();expect(call).toHaveBeenCalledTimes(1);
  });
  it("negative and ambiguous latest answers never call MCP", async () => {
    const s=setup();s.contacts[contactKey(email)].decision="no";
    ingest(s,{...contact(),email:"other@example.org",decision:"review"});const call=vi.fn();
    const counts=await processContacts(s,call,vi.fn(),true);expect(counts.no).toBe(1);expect(counts.review).toBe(1);expect(call).not.toHaveBeenCalled();
  });
  it("caps adds while retaining unsent contacts", async () => {
    const s=setup();ingest(s,{...contact(),email:"other@example.org"});
    const call=vi.fn(async(name:string,args:Record<string,unknown>)=>name==="get_subscriber"?{subscriber:null}:{email:args.email,status:"blocked"});
    const counts=await processContacts(s,call,vi.fn(),true,1);expect(counts.submitted).toBe(1);expect(counts.capped).toBe(1);expect(Object.keys(s.attempts)).toHaveLength(1);
  });
  it("records an uncertain tool error instead of retrying it on the next run", async () => {
    const s=setup();const call=vi.fn().mockResolvedValueOnce({subscriber:null}).mockRejectedValueOnce(new Error("transport failed")).mockResolvedValue({subscriber:null});
    await processContacts(s,call,vi.fn(),true);await processContacts(s,call,vi.fn(),true);
    expect(s.attempts[contactKey(email)].status).toBe("unverified");expect(call.mock.calls.filter(c=>c[0]==="add_free_subscriber")).toHaveLength(1);
  });
});
