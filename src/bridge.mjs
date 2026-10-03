import { validId, requireRunnable } from './config.mjs';
import { fail, deadline, safeCode } from './errors.mjs';
import { askAi } from './ai.mjs';

export function loadLedger(store, selfId, rooms) {
  const prior=store.read('ledger.json', {version:1,selfId,rooms:{}});
  if(prior?.version!==1 || prior.selfId!==selfId || !prior.rooms || typeof prior.rooms!=='object' || Array.isArray(prior.rooms))fail('invalid_ledger');
  const selected={};
  for(const id of rooms){
    const r=prior.rooms[id] ?? {cursor:'0',hour:0,count:0,lastAt:0};
    if(!(r.cursor==='0'||validId(r.cursor)) || ![r.hour,r.count,r.lastAt].every(n=>Number.isSafeInteger(n)&&n>=0))fail('invalid_ledger');
    selected[id]={...r};
  }
  return {version:1,selfId,rooms:selected};
}
export function eventText(event, cfg, selfId, startedAt, now) {
  if(!cfg.rooms.includes(event?.chat_id) || !validId(event.log_id) || !Number.isSafeInteger(event.author_id) || event.author_id<=0 || String(event.author_id)===selfId || event.message_type!==1)return null;
  if(!Number.isSafeInteger(event.sent_at) || event.sent_at*1000<startedAt || now-event.sent_at*1000>cfg.maxAgeMs || event.sent_at*1000>now+5000)return null;
  if(typeof event.message!=='string' || event.message.length>cfg.maxInput*2+64 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(event.message))return null;
  if(!event.message.startsWith(cfg.prefix) || !/^\s/.test(event.message.slice(cfg.prefix.length)))return null;
  const text=event.message.slice(cfg.prefix.length).trim();
  if(!text || !text.replace(/[\s\u200b-\u200f\ufeff]/g,'') || Array.from(text).length>cfg.maxInput)return null;
  return text;
}
function receiptLog(result){
  if(result?.statusCode!==0 || !result.body || (result.body.status!==undefined&&result.body.status!==0))fail('send_rejected');
  let id=result.body.logId;
  if(id && typeof id==='object'){
    const signed32=n=>Number.isInteger(n)&&n>=-2147483648&&n<=2147483647;
    if(!signed32(id.low)||!signed32(id.high))fail('invalid_send_receipt');
    id=((BigInt(id.high>>>0)<<32n)|BigInt(id.low>>>0)).toString();
  }
  if(Number.isSafeInteger(id))id=String(id);
  if(!validId(id))fail('invalid_send_receipt');return id;
}

export class Bridge {
  constructor({cfg,store,client,listener,Long,selfId,ai=askAi,now=Date.now,onEvent=()=>{}}){
    requireRunnable(cfg);
    this.cfg=cfg;this.store=store;this.client=client;this.listener=listener;this.Long=Long;this.selfId=selfId;
    this.ai=ai;this.now=now;this.onEvent=onEvent;this.ready=false;this.closed=false;this.queue=[];this.busy=false;
    this.ledger=loadLedger(store,selfId,cfg.rooms);this.members=new Map();this.memberIds=new Map();this.abort=new AbortController();
    this.stopped=new Promise(resolve=>{this.resolveStopped=resolve;});
  }
  assertOpen(){if(this.closed || !this.client.isConnected())fail('connection_not_ready');}
  async verifyRoom(id){
    if(!this.cfg.rooms.includes(id))fail('room_not_allowed');
    this.assertOpen();
    const room=await deadline(this.client.getChat(id));this.assertOpen();
    const snap=await deadline(this.client.getMemberSnapshot(id));this.assertOpen();
    if(room?.chat_id!==id || !['DirectChat','MultiChat'].includes(room.type) || !Number.isSafeInteger(room.active_members) || room.active_members<2 || room.active_members>100 ||
       snap?.chat_id!==id || snap.complete!==true || snap.active_members!==room.active_members || !Array.isArray(snap.members) || snap.members.length!==room.active_members)fail('room_boundary');
    if(room.type==='DirectChat'&&room.active_members!==2)fail('room_boundary');
    const ids=snap.members.map(m=>m.user_id);
    if(ids.some(x=>!validId(x))||new Set(ids).size!==ids.length||!ids.includes(this.selfId))fail('member_boundary');
    const fingerprint=JSON.stringify([room.type,[...ids].sort()]);
    if(this.members.has(id)&&this.members.get(id)!==fingerprint)fail('membership_changed');
    this.members.set(id,fingerprint);this.memberIds.set(id,new Set(ids));
  }
  async start(){
    this.listener.on('error',()=>this.stop('kakao_connection_failure'));
    this.listener.on('disconnected',()=>this.stop('kakao_disconnected'));
    for(const kind of ['member_joined','member_left'])this.listener.on(kind,e=>{if(this.cfg.rooms.includes(e?.chat_id))this.stop('membership_changed');});
    this.listener.on('message',e=>{try{this.accept(e);}catch(error){this.stop(safeCode(error));}});
    try {
      await deadline(this.listener.start());this.assertOpen();
      for(const id of this.cfg.rooms)await this.verifyRoom(id);
      this.assertOpen();this.startedAt=this.now();this.ready=true;this.onEvent('ready');return this;
    }catch(error){this.stop(safeCode(error));throw error;}
  }
  accept(event){
    if(!this.ready || this.closed)return false;
    const now=this.now(); const text=eventText(event,this.cfg,this.selfId,this.startedAt,now);
    if(text===null || !this.memberIds.get(event.chat_id)?.has(String(event.author_id)))return false;
    const r=this.ledger.rooms[event.chat_id];
    if(BigInt(event.log_id)<=BigInt(r.cursor))return false;
    // Persist before any AI call or send. Drops on crash are preferable to duplicates.
    r.cursor=event.log_id;
    const hour=Math.floor(now/3600000);
    if(hour>r.hour){r.hour=hour;r.count=0;}
    const permitted=hour===r.hour && now-r.lastAt>=this.cfg.cooldown && r.count<this.cfg.perHour && this.queue.length<this.cfg.maxQueue;
    if(permitted){r.lastAt=now;r.count++;}
    this.store.write('ledger.json',this.ledger);
    if(!permitted){this.onEvent('rate_or_queue_drop');return false;}
    this.queue.push({room:event.chat_id,author:String(event.author_id),text,receivedAt:now});
    void this.drain();return true;
  }
  async drain(){
    if(this.busy || this.closed)return;this.busy=true;
    try{while(this.queue.length&&!this.closed){
      const item=this.queue.shift();
      if(this.now()-item.receivedAt>this.cfg.maxAgeMs)continue;
      await this.verifyRoom(item.room);this.assertOpen();
      if(!this.memberIds.get(item.room)?.has(item.author))fail('author_not_member');
      let text;
      try{text=await this.ai(this.cfg,item.text,this.abort.signal);}
      catch(error){if(this.closed)break;this.onEvent(safeCode(error));continue;}
      this.assertOpen();await this.verifyRoom(item.room);this.assertOpen();
      if(!this.memberIds.get(item.room)?.has(item.author))fail('author_not_member');
      const self=await deadline(this.client.getProfile());this.assertOpen();
      if(self?.user_id!==this.selfId)fail('account_mismatch');
      const session=await deadline(this.client.acquireSession());this.assertOpen();
      // Never call the SDK high-level sendMessage: its reconnect wrapper can retry WRITE.
      const result=await deadline(session.sendMessage(this.Long.fromString(item.room),text));
      this.assertOpen();const id=receiptLog(result);
      const page=await deadline(this.client.getMessagePage(item.room,{count:1,from:(BigInt(id)-1n).toString()}));
      this.assertOpen();
      if(!page?.messages?.some(m=>m.log_id===id&&Number.isSafeInteger(m.author_id)&&String(m.author_id)===this.selfId&&m.message===text))fail('send_unverified');
      this.onEvent('reply_verified');
    }}catch(error){this.stop(safeCode(error));}
    finally{this.busy=false;}
  }
  stop(reason='stopped'){
    if(this.closed)return;this.closed=true;this.ready=false;this.queue=[];this.abort.abort();
    try{this.listener.stop();}catch{}try{this.client.close();}catch{}
    this.onEvent(reason);this.resolveStopped(reason);
  }
  async idle(){while(this.busy)await new Promise(resolve=>setTimeout(resolve,5));}
}
