import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { listRooms } from '../src/rooms.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-rooms-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new StateStore(path.join(dir,'state')).init();const uuid='a'.repeat(64);store.write('session.json',{version:1,userId:'11',oauthToken:'fixture',refreshToken:'',deviceUuid:uuid,deviceType:'tablet'});return {store,file:path.join(store.root,'sdk',`kakaotalk-sync-state-${uuid}.json`)};}
test('repeat rooms recovers only scoped version2 sync candidate IDs with readback',async t=>{
 const {store,file}=fixture(t);const state={version:2,revision:1,chatIds:[{low:101,high:0},{low:4000000000,high:0}],maxIds:[{low:1,high:0},{low:1,high:0}],lastTokenId:{low:0,high:0},lbk:0};
 fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});const before=fs.readFileSync(file);const calls=[];
 const client={getChats:async()=>[],getChat:async id=>{calls.push(id);return {chat_id:id,type:'DirectChat',display_name:'fixture name',last_message:{message:'must not expose'}};}};
 const r=await listRooms(client,store);assert.deepEqual(calls,['101','4000000000']);assert.equal(r.source,'private_sync_state');assert.equal(r.incomplete,false);assert.equal(r.rooms.length,2);assert.equal(JSON.stringify(r).includes('must not expose'),false);assert.deepEqual(fs.readFileSync(file),before);
});
test('empty, stale and malformed sync snapshots are not reported as no rooms',async t=>{
 const {store,file}=fixture(t);const client={getChats:async()=>[],getChat:async()=>{throw Error('unavailable');}};
 assert.equal((await listRooms(client,store)).incomplete,true);
 fs.writeFileSync(file,JSON.stringify({version:2,chatIds:[{low:101,high:0}],maxIds:[{}]}),{mode:0o600});
 const r=await listRooms(client,store);assert.equal(r.failedCount,1);assert.equal(r.incomplete,true);
 fs.writeFileSync(file,JSON.stringify({version:2,chatIds:[{low:4294967396,high:0}],maxIds:[{}]}));
 await assert.rejects(listRooms(client,store),/invalid_sdk_sync_state/);
});
test('nonempty SDK room list bypasses sync recovery and omits message contents',async t=>{
 const {store}=fixture(t);let reads=0;
 const result=await listRooms({getChats:async()=>[{chat_id:'101',type:'DirectChat',display_name:'fixture',last_message:{message:'private'}}],getChat:async()=>{reads++;}},store);
 assert.equal(reads,0);assert.equal(result.source,'sdk');assert.equal(JSON.stringify(result).includes('private'),false);
});
