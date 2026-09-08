/** Offline sample: actual MCP handlers, synthetic API fixture, no real network. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {SubstackClient} from '../dist/api/client.js';
const fixture=JSON.parse(readFileSync('src/__tests__/fixtures/markdown-rich.json','utf8'));
const pkg=JSON.parse(readFileSync('package.json','utf8'));
let draft,puts=0;
globalThis.fetch=async (url,options={})=>{
 const target=new URL(url),method=options.method??'GET';
 assert.equal(target.origin,'https://example.substack.com');
 if(method==='GET'&&target.pathname==='/api/v1/publication')return Response.json({id:7,name:'Sample publication',subdomain:'example'});
 if(method==='POST'&&target.pathname==='/api/v1/drafts'){
  assert.equal(draft,undefined);draft={...JSON.parse(options.body),id:42,publication_id:7,is_published:false,draft_subtitle:null,draft_updated_at:'2026-09-07T00:00:00Z'};return Response.json(draft);
 }
 if(method==='GET'&&target.pathname==='/api/v1/post_management/drafts')return Response.json({posts:[draft],total:1});
 if(method==='GET'&&target.pathname==='/api/v1/drafts/42')return Response.json(draft);
 if(method==='PUT'&&target.pathname==='/api/v1/drafts/42'){puts++;draft={...draft,...JSON.parse(options.body),draft_updated_at:'2026-09-07T00:01:00Z'};return Response.json(draft);}
 throw Error('Unexpected fixture request; no network fallback is permitted.');
};
const server=createServer([{key:'example',label:'Sample publication',client:new SubstackClient('https://example.substack.com','synthetic-test-only','1')}]);
const client=new Client({name:'offline-workflow-demo',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(ct),server.connect(st)]);
const frames=[];
function frame(title,command,lines){frames.push({title,command,lines});}
async function call(name,args,error=false){const r=await client.callTool({name,arguments:args});assert.equal(!!r.isError,error);const body=JSON.parse(r.content[0].text);if(r.structuredContent)assert.deepEqual(r.structuredContent,body);return body;}
try{
 await call('create_draft',{title:'Weekly signals',body:fixture.markdown});
 assert.deepEqual(JSON.parse(draft.draft_body),fixture.document);
 frame('Create a rich draft','create_draft({ title, body: markdown })',['Sample publication / draft 42','Numbered lists, nested formatting, linked image, paywall','Long-form post remains unpublished.']);
 const found=await call('search_posts',{query:'Weekly',status:'drafts'});assert.equal(found.posts[0].id,42);
 frame('Find the draft','search_posts({ query: "Weekly", status: "drafts" })',[`Found: ${found.posts[0].draft_title}`,`returned: ${found.returned}  |  has_more: ${found.has_more}`]);
 const exported=await call('export_draft',{draft_id:42});assert.equal(exported.source_prosemirror,draft.draft_body);assert.equal(exported.status,'partial');assert.ok(exported.unsupported_nodes.length);
 frame('Export with the original source','export_draft({ draft_id: 42 })',[`status: ${exported.status}`,`conversion findings: ${exported.unsupported_nodes.length}`, 'Editable Markdown + exact source + hash + editor link','Inspect losses before reusing the Markdown.']);
 const changes={draft_id:42,body:fixture.markdown+'\n\nReviewed conclusion.'};
 const plan=await call('plan_draft_update',changes);assert.deepEqual(plan.changed_fields,['body']);assert.equal(puts,0);
 frame('Review the proposed change','plan_draft_update({ draft_id: 42, body: revisedMarkdown })',[`changed_fields: ${plan.changed_fields.join(', ')}`,`preflight checks passed: ${plan.preflight.checks_passed}`,'Receipt binds current state and exact proposed changes.','Planning writes nothing.']);
 draft.draft_title='Weekly signals, revised in the editor';
 const stale=await call('update_draft',{...changes,receipt:plan.receipt},true);assert.equal(stale.code,'stale_draft');assert.equal(puts,0);
 frame('Detect an intervening edit','update_draft({ ...changes, receipt: oldReceipt })',[`code: ${stale.code}`,'An editor changed the title after planning.','No PUT was sent. Read again and make a fresh plan.']);
 const fresh=await call('plan_draft_update',changes),applied=await call('update_draft',{...changes,receipt:fresh.receipt});assert.equal(applied.status,'verified');assert.equal(puts,1);assert.equal(draft.draft_title,'Weekly signals, revised in the editor');
 frame('Apply the fresh plan','update_draft({ ...changes, receipt: freshReceipt })',[`status: ${applied.status}  |  write_attempts: ${applied.write_attempts}`,'Readback matches the requested body.','The editor\'s revised title is preserved.','Separate GET and PUT still have a race window.']);
 const preflight=await call('preflight_draft',{draft_id:42});assert.equal(preflight.checks_passed,true);assert.equal(draft.is_published,false);
 frame('Finish in Substack','preflight_draft({ draft_id: 42 })',[`checks_passed: ${preflight.checks_passed}`,`images: ${preflight.counts.images}  |  paywalls: ${preflight.counts.paywalls}`,'Review rendering, audience and access in the editor.','Only the human publishes the long-form post.']);
 const data={version:pkg.version,disclosure:'OFFLINE SAMPLE DATA / actual MCP handlers / no live API calls',frames};
 if(process.argv.includes('--write'))writeFileSync('docs/workflow-demo.json',JSON.stringify(data,null,2)+'\n');
 else assert.deepEqual(JSON.parse(readFileSync('docs/workflow-demo.json','utf8')),data);
 console.log(`Verified ${frames.length} sample workflow steps; one fixture PUT, no real network or publication.`);
}finally{await client.close();await server.close();}
