import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { configFrom } from '../src/config.mjs';
import { StateStore } from '../src/store.mjs';
import { loadSdk } from '../src/sdk.mjs';
import { Bridge, eventText } from '../src/bridge.mjs';

function storeFor(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new StateStore(path.join(dir,'state')).init();}
const clock=2000000000000;
function event(overrides={}){return {chat_id:'101',log_id:'1001',author_id:22,message_type:1,message:'!ai hello',sent_at:clock/1000,...overrides};}
class FakeClient {
 constructor(store){this.store=store;this.connected=true;this.sent=[];this.self='11';this.memberList=['11','22'];}
 isConnected(){return this.connected;}
 async getChat(id){return {chat_id:id,type:'DirectChat',active_members:2};}
 async getMemberSnapshot(id){return {chat_id:id,complete:true,active_members:2,members:this.memberList.map(user_id=>({user_id}))};}
 async getProfile(){return {user_id:this.self};}
 async acquireSession(){return {sendMessage:async(room,text)=>{assert.ok(BigInt(this.store.read('ledger.json').rooms[room.toString()].cursor)>0n);this.sent.push({room:room.toString(),text});if(this.badSend)throw Error('unknown acknowledgement');return {statusCode:0,body:{status:0,logId:'9001'}};}};}
 async getMessagePage(_id,options){assert.equal(options.from,'9000');return {messages:this.badReadback?[]:[{log_id:'9001',author_id:11,message:this.sent.at(-1).text}]};}
 close(){this.connected=false;}
 onPush(cb){this.push=cb;return()=>{this.push=undefined;};}
 onSessionEvent(cb){this.sessionEvent=cb;return()=>{this.sessionEvent=undefined;};}
 getCredentials(){return {userId:'11'};}
}
class FakeListener extends EventEmitter {async start(){}stop(){this.stopped=true;}}
async function fixture(t,extra={}){
 const store=storeFor(t);const client=new FakeClient(store);const listener=new FakeListener();
 const cfg=configFrom({AI_BASE_URL:'http://127.0.0.1:1234/v1',AI_MODEL:'mock',KAKAO_ALLOWED_ROOMS:'101,102'});
 const bridge=new Bridge({cfg,store,client,listener,Long:{fromString:s=>s},selfId:'11',now:()=>clock,ai:async()=> '답변',...extra});
 t.after(()=>bridge.stop());await bridge.start();return {store,client,listener,cfg,bridge};
}
test('real listener + local HTTP: whitelist, durable dedupe, one verified WRITE',async t=>{
 const store=storeFor(t);const sdk=await loadSdk(store);let calls=0;
 const server=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{
   calls++;const parsed=JSON.parse(body);assert.equal(parsed.messages[1].content,'hello');
   assert.equal(store.read('ledger.json').rooms['101'].cursor,'1001');res.end(JSON.stringify({choices:[{message:{content:'테스트 답변'}}]}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const cfg=configFrom({AI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,AI_MODEL:'mock',KAKAO_ALLOWED_ROOMS:'101'});
 const client=new FakeClient(store);const listener=new sdk.KakaoTalkListener(client);
 const bridge=new Bridge({cfg,store,client,listener,Long:sdk.Long,selfId:'11',now:()=>clock});await bridge.start();t.after(()=>bridge.stop());
 const push=(chat,author,log)=>client.push({method:'MSG',body:{chatId:sdk.Long.fromString(chat),chatLog:{authorId:author,logId:sdk.Long.fromString(log),type:1,message:'!ai hello',sendAt:clock/1000}}});
 push('999',22,'999');push('101',11,'1000');push('101',22,'1001');push('101',22,'1001');
 await bridge.idle();assert.equal(calls,1);assert.deepEqual(client.sent,[{room:'101',text:'테스트 답변'}]);
 bridge.stop();const next=new Bridge({cfg,store,client:new FakeClient(store),listener:new FakeListener(),Long:sdk.Long,selfId:'11',now:()=>clock,ai:async()=>{throw Error('must not replay');}});
 await next.start();assert.equal(next.accept(event()),false);next.stop();
});
test('event boundary rejects malformed IDs, self, outsiders, stale, future, prefix tricks and attachments',async t=>{
 const {bridge,cfg,client}=await fixture(t);
 for(const patch of [{chat_id:'999'},{log_id:'1001\n'},{log_id:'9223372036854775808'},{author_id:11},{author_id:33},{author_id:Number.MAX_SAFE_INTEGER+1},{message_type:2},{message:'!aix hello'},{message:'!ai\u200bhello'},{message:'!ai '},{message:'!ai \u200b'},{message:'!ai '+ 'x'.repeat(5000)},{sent_at:clock/1000-1},{sent_at:clock/1000+60}])assert.equal(bridge.accept(event(patch)),false,JSON.stringify(patch));
 assert.equal(eventText(event(),cfg,'11',clock,clock),'hello');assert.equal(client.sent.length,0);
});
test('cooldown and per-room budget are durable; queue is bounded',async t=>{
 let now=clock;let release;const pending=new Promise(r=>release=r);
 const {bridge,store}=await fixture(t,{now:()=>now,ai:async()=>{await pending;return 'answer';}});
 assert.equal(bridge.accept(event()),true);
 assert.equal(bridge.accept(event({log_id:'1002'})),false);
 for(let i=0;i<30;i++){now+=5000;bridge.accept(event({log_id:String(1003+i),sent_at:Math.floor(now/1000)}));}
 assert.equal(bridge.queue.length,20);assert.ok(store.read('ledger.json').rooms['101'].count<=30);
 bridge.stop();release();await bridge.idle();
});
test('disconnect or membership change during AI cancels send',async t=>{
 for(const name of ['disconnected','member_joined','error']){
 let release;let entered;const ready=new Promise(r=>entered=r);const pending=new Promise(r=>release=r);
 const {bridge,listener,client}=await fixture(t,{ai:async()=>{entered();await pending;return 'answer';}});
 bridge.accept(event());await ready;listener.emit(name,name==='error'?Error('secret'):{chat_id:'101'});release();await bridge.idle();
 assert.equal(bridge.closed,true);assert.equal(client.sent.length,0);
 }
});
test('profile/room/member changes before send fail closed',async t=>{
 for(const field of ['self','memberList']){
 let clientRef;const f=await fixture(t,{ai:async()=>{clientRef[field]=field==='self'?'44':['11','33'];return 'answer';}});clientRef=f.client;
 f.bridge.accept(event());await f.bridge.idle();assert.equal(f.bridge.closed,true);assert.equal(f.client.sent.length,0);
 }
});
test('ambiguous send and unverified receipt never retry',async t=>{
 for(const key of ['badSend','badReadback']){
 const {bridge,client}=await fixture(t);client[key]=true;bridge.accept(event());await bridge.idle();assert.equal(client.sent.length,1);assert.equal(bridge.closed,true);assert.equal(bridge.accept(event()),false);
 }
});
test('listener startup emitting error but resolving is not ready',async t=>{
 const store=storeFor(t);const client=new FakeClient(store);const listener=new FakeListener();listener.start=async()=>listener.emit('error',Error('fixture'));
 const bridge=new Bridge({cfg:configFrom({AI_MODEL:'mock',AI_API_KEY:'fixture',KAKAO_ALLOWED_ROOMS:'101'}),store,client,listener,Long:{},selfId:'11'});
 await assert.rejects(bridge.start());assert.equal(bridge.ready,false);assert.equal(client.connected,false);
});
test('noncanonical BSON receipt components fail instead of wrapping',async t=>{
 const {bridge,client}=await fixture(t);let sends=0;let reads=0;
 client.acquireSession=async()=>({sendMessage:async()=>{sends++;return {statusCode:0,body:{logId:{low:4294967396,high:0}}};}});
 client.getMessagePage=async()=>{reads++;return {messages:[]};};
 bridge.accept(event());await bridge.idle();assert.equal(sends,1);assert.equal(reads,0);assert.equal(await bridge.stopped,'invalid_send_receipt');
});
test('persistence error blocks AI and stops listener intake',async t=>{
 let aiCalls=0;const {bridge,store,listener,client}=await fixture(t,{ai:async()=>{aiCalls++;return 'x';}});
 store.write=()=>{throw Error('disk full');};listener.emit('message',event());await bridge.idle();assert.equal(aiCalls,0);assert.equal(bridge.closed,true);assert.equal(client.sent.length,0);
});
