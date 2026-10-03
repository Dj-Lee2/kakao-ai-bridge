import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const load=rel=>import(pathToFileURL(path.join(root,rel)));
const {configFrom,validId}=await load('src/config.mjs');
const {StateStore}=await load('src/store.mjs');
const {askAi}=await load('src/ai.mjs');

test('parent: exact ID format rejects newline, Unicode and coercion',()=>{
 for(const value of ['1\n','1\r','1 ',' 1','１','١',1,null,undefined,'+1','0x10','9007199254740993e0'])assert.equal(validId(value),false,JSON.stringify(value));
 assert.equal(validId('9223372036854775807'),true);
});
test('parent: plaintext non-loopback and URL credential tricks fail closed',()=>{
 for(const u of ['http://127.0.0.1.evil.invalid/v1','http://localhost.evil.invalid/v1','http://10.0.0.1/v1','https://name:password@example.com/v1','https://example.com/v1#fragment'])assert.throws(()=>configFrom({AI_BASE_URL:u,AI_MODEL:'fixture'}),u);
});
test('parent: store refuses symlinked root, preserves outside data',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-parent-store-'));
 try {const real=path.join(temp,'real');fs.mkdirSync(real,{mode:0o700});fs.writeFileSync(path.join(real,'marker'),'keep',{mode:0o600});fs.symlinkSync(real,path.join(temp,'alias'));assert.throws(()=>new StateStore(path.join(temp,'alias')).init());assert.equal(fs.readFileSync(path.join(real,'marker'),'utf8'),'keep');}finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('parent: HTTP redirect does not contact destination or leak bearer',async t=>{
 let hits=0;const target=http.createServer((_q,r)=>{hits++;r.end('{}');});await new Promise(r=>target.listen(0,'127.0.0.1',r));
 const redirect=http.createServer((_q,r)=>{r.writeHead(307,{location:`http://127.0.0.1:${target.address().port}/steal`});r.end();});await new Promise(r=>redirect.listen(0,'127.0.0.1',r));
 t.after(()=>{redirect.closeAllConnections();redirect.close();target.closeAllConnections();target.close();});
 await assert.rejects(askAi(configFrom({AI_BASE_URL:`http://127.0.0.1:${redirect.address().port}/v1`,AI_API_KEY:'parent-fixture-no-real-secret',AI_MODEL:'fixture'}),'hello'));
 assert.equal(hits,0);
});

const {Bridge}=await load('src/bridge.mjs');
const {EventEmitter}=await import('node:events');
async function fixture(t,{ai,receipt='100'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-parent-engine-'));const store=new StateStore(path.join(dir,'state')).init();
 let clock=1800000000000, members=['201','202'],sent=[];
 const listener=new EventEmitter();listener.start=async()=>{};listener.stop=()=>{};
 const client={isConnected:()=>true,close(){},getProfile:async()=>({user_id:'201'}),
 getChat:async id=>({chat_id:id,type:'DirectChat',active_members:2}),
 getMemberSnapshot:async id=>({chat_id:id,complete:true,active_members:2,members:members.map(user_id=>({user_id}))}),
 acquireSession:async()=>({sendMessage:async(_id,text)=>{sent.push(text);return {statusCode:0,body:{status:0,logId:receipt}};}}),
 getMessagePage:async()=>({messages:[{log_id:'100',author_id:201,message:sent.at(-1)}]})};
 const cfg=configFrom({AI_BASE_URL:'http://127.0.0.1:1/v1',AI_MODEL:'fixture',KAKAO_ALLOWED_ROOMS:'101'});
 const events=[];let calls=0;
 const bridge=new Bridge({cfg,store,client,listener,Long:{fromString:x=>x},selfId:'201',now:()=>clock,ai:async(...a)=>{calls++;return ai?ai(...a):'fixture reply'},onEvent:x=>events.push(x)});
 await bridge.start();clock+=1000;
 t.after(()=>{bridge.stop();fs.rmSync(dir,{recursive:true,force:true});});
 return {bridge,sent,events,store,listener,get calls(){return calls},setMembers:x=>{members=x},message:(author=202,id='1')=>({chat_id:'101',log_id:id,author_id:author,message_type:1,sent_at:clock/1000,message:'!ai fixture'}),advance:n=>{clock+=n}};
}
test('parent: outsider author cannot reach AI or send despite valid room',async t=>{
 const f=await fixture(t);assert.equal(f.bridge.accept(f.message(999)),false);await f.bridge.idle();assert.equal(f.calls,0);assert.equal(f.sent.length,0);
});
test('parent: durable intake prevents replay after a verified single send',async t=>{
 const f=await fixture(t);assert.equal(f.bridge.accept(f.message()),true);await f.bridge.idle();assert.equal(f.sent.length,1);assert.equal(f.events.includes('reply_verified'),true);
 assert.equal(f.store.read('ledger.json').rooms['101'].cursor,'1');assert.equal(f.bridge.accept(f.message()),false);await f.bridge.idle();assert.equal(f.calls,1);assert.equal(f.sent.length,1);
});
test('parent: changed membership during AI call prevents outbound reply',async t=>{
 let release,entered;const started=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
 const f=await fixture(t,{ai:async()=>{entered();await gate;return 'fixture'}});f.bridge.accept(f.message());await started;f.setMembers(['201','203']);release();await f.bridge.idle();assert.equal(f.sent.length,0);assert.equal(f.bridge.closed,true);
});

test('parent: malformed receipt components cannot wrap to verified log ID',async t=>{
 const f=await fixture(t,{receipt:{low:4294967396,high:0}});f.bridge.accept(f.message());await f.bridge.idle();assert.equal(f.sent.length,1);assert.equal(f.events.includes('reply_verified'),false);assert.equal(f.bridge.closed,true);
});
