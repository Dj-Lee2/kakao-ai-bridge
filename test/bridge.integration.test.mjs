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
async function fixture(t,extra={},env={}){
 const store=storeFor(t);const client=new FakeClient(store);const listener=new FakeListener();
 const cfg=configFrom({AI_BASE_URL:'http://127.0.0.1:1234/v1',AI_MODEL:'mock',KAKAO_ALLOWED_ROOMS:'101,102',...env});
 const bridge=new Bridge({cfg,store,client,listener,Long:{fromString:s=>s},selfId:'11',now:()=>clock,ai:async()=> '답변',...extra});
 t.after(()=>bridge.stop());await bridge.start();return {store,client,listener,cfg,bridge};
}
for (const provider of ['openai-compatible','openclaw']) test(`real listener + local HTTP (${provider}): whitelist, durable dedupe, one verified WRITE`,async t=>{
 const store=storeFor(t);const sdk=await loadSdk(store);let calls=0;
 const server=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{
   calls++;const parsed=JSON.parse(body);assert.equal(parsed.messages[1].content,'hello');
   assert.equal(req.url,'/v1/chat/completions');
   assert.equal(parsed.model,provider==='openclaw'?'openclaw/kakao-bridge':'mock');
   if(provider==='openclaw')assert.equal(req.headers.authorization,'Bearer fixture-gateway');
   assert.equal(store.read('ledger.json').rooms['101'].cursor,'1001');res.end(JSON.stringify({choices:[{message:{content:'테스트 답변'}}]}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}/v1`;
 const cfg=configFrom({AI_PROVIDER:provider,AI_BASE_URL:base,AI_MODEL:'mock',KAKAO_ALLOWED_ROOMS:'101',
   OPENCLAW_BASE_URL:base,OPENCLAW_GATEWAY_TOKEN:'fixture-gateway',OPENCLAW_AGENT_ID:'kakao-bridge'});
 const client=new FakeClient(store);const listener=new sdk.KakaoTalkListener(client);
 const bridge=new Bridge({cfg,store,client,listener,Long:sdk.Long,selfId:'11',now:()=>clock});await bridge.start();t.after(()=>bridge.stop());
 const push=(chat,author,log)=>client.push({method:'MSG',body:{chatId:sdk.Long.fromString(chat),chatLog:{authorId:author,logId:sdk.Long.fromString(log),type:1,message:'!ai hello',sendAt:clock/1000}}});
 push('999',22,'999');push('101',11,'1000');push('101',22,'1001');push('101',22,'1001');
 await bridge.idle();assert.equal(calls,1);assert.deepEqual(client.sent,[{room:'101',text:'테스트 답변'}]);
 bridge.stop();const next=new Bridge({cfg,store,client:new FakeClient(store),listener:new FakeListener(),Long:sdk.Long,selfId:'11',now:()=>clock,ai:async()=>{throw Error('must not replay');}});
 await next.start();assert.equal(next.accept(event()),false);next.stop();
});
test('prefix mode: event boundary rejects malformed IDs, self, outsiders, stale, future, prefix tricks and attachments',async t=>{
 const {bridge,cfg,client}=await fixture(t,{},{KAKAO_REPLY_MODE:'prefix'});
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

test('auto mode: 1:1 room answers plain text and strips an optional prefix',async t=>{
 const {cfg}=await fixture(t);
 assert.equal(cfg.replyMode,'auto');
 assert.equal(eventText(event({message:'hello'}),cfg,'11',clock,clock),'hello');
 assert.equal(eventText(event(),cfg,'11',clock,clock),'hello');
 assert.equal(eventText(event({message_type:26,message:'reply text',attachment:{src_userId:11}}),cfg,'11',clock,clock),'reply text');
 for(const patch of [{message_type:2},{message:' '},{message:'\u200b'},{author_id:11},{chat_id:'999'}])assert.equal(eventText(event(patch),cfg,'11',clock,clock),null,JSON.stringify(patch));
 const dm=await fixture(t);let asked;dm.bridge.ai=async(_c,text,_s,context)=>{asked={text,context};return '답변';};
 assert.equal(dm.bridge.accept(event({message:'오늘 날씨 어때?'})),true);await dm.bridge.idle();
 assert.deepEqual(asked,{text:'오늘 날씨 어때?',context:[]});assert.equal(dm.client.sent.length,1);
});
async function groupFixture(t,{judge=async()=>true,env={}}={}){
 const calls={judge:[],ai:[]};let clockNow=clock;
 const store=storeFor(t);const client=new FakeClient(store);const listener=new FakeListener();
 client.memberList=['11','22','33'];
 client.getChat=async id=>({chat_id:id,type:'MultiChat',active_members:3});
 client.getMemberSnapshot=async id=>({chat_id:id,complete:true,active_members:3,members:[{user_id:'11',nickname:'코덱스'},{user_id:'22',nickname:'철수'},{user_id:'33',nickname:'영희'}]});
 client.getProfile=async()=>({user_id:'11',nickname:'코덱스'});
 let readback=9000;client.acquireSession=async()=>({sendMessage:async(room,text)=>{client.sent.push({room:room.toString(),text});readback++;return {statusCode:0,body:{status:0,logId:String(readback)}};}});
 client.getMessagePage=async()=>({messages:[{log_id:String(readback),author_id:11,message:client.sent.at(-1).text}]});
 const cfg=configFrom({AI_BASE_URL:'http://127.0.0.1:1234/v1',AI_MODEL:'mock',KAKAO_ALLOWED_ROOMS:'101',BRIDGE_COOLDOWN_MS:'1000',KAKAO_BOT_NAMES:'봇',...env});
 const events=[];
 const bridge=new Bridge({cfg,store,client,listener,Long:{fromString:s=>s},selfId:'11',now:()=>clockNow,onEvent:e=>events.push(e),
   judge:async(_c,text,_s,context,names)=>{calls.judge.push({text,context:context.map(c=>c.who+':'+c.text),names});return judge(text);},
   ai:async(_c,text,_s,context)=>{calls.ai.push({text,context:context.map(c=>c.who+':'+c.text)});return '답:'+text;}});
 t.after(()=>bridge.stop());await bridge.start();
 let log=2000;const say=(author,message,extra={})=>{clockNow+=2000;log++;return bridge.accept({chat_id:'101',log_id:String(log),author_id:author,message_type:1,message,sent_at:Math.floor(clockNow/1000),...extra});};
 return {bridge,client,calls,events,store,say,advance:ms=>{clockNow+=ms;}};
}
test('group: chatter that never calls the bot reaches neither judge nor AI',async t=>{
 const g=await groupFixture(t);
 assert.equal(g.say(22,'점심 뭐 먹을까?'),false);assert.equal(g.say(33,'김치찌개 어때'),false);await g.bridge.idle();
 assert.equal(g.calls.judge.length,0);assert.equal(g.calls.ai.length,0);assert.equal(g.client.sent.length,0);
});
test('group: name call is judged with recent context; NO stays silent, YES answers once',async t=>{
 const g=await groupFixture(t,{judge:async text=>!text.includes('얘기')});
 g.say(22,'점심 뭐 먹을까?');
 assert.equal(g.say(33,'코덱스 얘기 들었어?'),true);await g.bridge.idle();
 assert.equal(g.calls.judge.length,1);assert.equal(g.calls.ai.length,0);assert.equal(g.events.at(-1),'not_addressed');
 assert.equal(g.say(22,'코덱스야 근처 맛집 추천해줘'),true);await g.bridge.idle();
 assert.deepEqual(g.calls.judge[1].context,['철수:점심 뭐 먹을까?','영희:코덱스 얘기 들었어?']);
 assert.deepEqual(g.calls.judge[1].names,['봇','코덱스']);
 assert.equal(g.calls.ai.length,1);assert.deepEqual(g.client.sent.map(x=>x.text),['답:코덱스야 근처 맛집 추천해줘']);
 assert.equal(g.store.read('ledger.json').rooms['101'].judges,2);assert.equal(g.store.read('ledger.json').rooms['101'].count,1);
});
test('group: @mention, reply-to-bot and explicit prefix skip the judge',async t=>{
 const g=await groupFixture(t,{judge:async()=>{throw Error('judge must not run');}});
 g.say(22,'이거 알려줘',{attachment:{mentions:[{user_id:11,at:[1],len:3}]}});await g.bridge.idle();
 g.say(33,'더 자세히',{message_type:26,attachment:{src_userId:11,src_logId:9001}});await g.bridge.idle();
 g.say(22,'!ai 요약해줘');await g.bridge.idle();
 assert.equal(g.calls.judge.length,0);assert.deepEqual(g.client.sent.map(x=>x.text),['답:이거 알려줘','답:더 자세히','답:요약해줘']);
 assert.equal(g.say(33,'다른 사람 답장',{message_type:26,attachment:{src_userId:22}}),true,'follow-up window still judges');
});
test('group: follow-up after a bot reply is judged only inside the window',async t=>{
 const g=await groupFixture(t,{env:{BRIDGE_GROUP_FOLLOWUP_MS:'60000'}});
 g.say(22,'봇아 오늘 할 일 정리해줘');await g.bridge.idle();assert.equal(g.client.sent.length,1);
 assert.equal(g.say(22,'고마워 하나 더 물어볼게'),true);await g.bridge.idle();assert.equal(g.calls.judge.length,2);
 assert.ok(g.calls.ai[1].context.includes('AI:답:봇아 오늘 할 일 정리해줘'));
 g.advance(120000);assert.equal(g.say(33,'그럼 내일 보자'),false);await g.bridge.idle();assert.equal(g.calls.judge.length,2);
});
test('group: judge budget is separate and bounded per hour',async t=>{
 const g=await groupFixture(t,{judge:async()=>false,env:{BRIDGE_MAX_JUDGES_PER_HOUR:'2'}});
 assert.equal(g.say(22,'봇 얘기 1'),true);await g.bridge.idle();
 assert.equal(g.say(22,'봇 얘기 2'),true);await g.bridge.idle();
 assert.equal(g.say(22,'봇 얘기 3'),false);assert.equal(g.events.at(-1),'rate_or_queue_drop');
 assert.equal(g.calls.ai.length,0);assert.equal(g.store.read('ledger.json').rooms['101'].count,0);
});
