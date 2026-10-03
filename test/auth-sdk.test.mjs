import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { loadSdk } from '../src/sdk.mjs';
import { login, validateSession, connectClient } from '../src/auth.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-auth-'));const store=new StateStore(path.join(dir,'state')).init();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return store;}
test('real pinned SDK registration sequence with mocked HTTP, isolated session, no password saved', async t=>{
 const store=fixture(t);process.env.AGENT_MESSENGER_CONFIG_DIR='/must-not-use-global';
 const sdk=await loadSdk(store);assert.equal(process.env.AGENT_MESSENGER_CONFIG_DIR,path.join(store.root,'sdk'));
 const original=globalThis.fetch;const requests=[];const display=[];
 globalThis.fetch=async(url,options)=>{requests.push({url,options});const i=requests.length;
  const data=i===1?{status:-100}:i===2?{passcode:'123456'}:i===3?{status:0}:{status:0,access_token:'fixture-access',refresh_token:'fixture-refresh',userId:11};
  return new Response(JSON.stringify(data),{status:200});};
 t.after(()=>{globalThis.fetch=original;});
 const answers=['test@example.invalid','fixture-password'];
 await login({sdk,store,prompt:async()=>answers.shift(),displayPasscode:c=>display.push(c)});
 assert.equal(requests.length,4);assert.match(requests[1].url,/passcodeLogin\/generate$/);assert.match(requests[2].url,/passcodeLogin\/registerDevice$/);
 for(const i of [0,3])assert.equal(new URLSearchParams(requests[i].options.body).get('forced'),'false');
 const uuid=new URLSearchParams(requests[0].options.body).get('device_uuid');
 assert.equal(JSON.parse(requests[1].options.body).device.uuid,uuid);assert.equal(new URLSearchParams(requests[3].options.body).get('device_uuid'),uuid);
 assert.deepEqual(display,['123456']);const session=store.read('session.json');assert.equal(validateSession(session).userId,'11');
 const saved=fs.readFileSync(store.file('session.json'),'utf8');assert.equal(saved.includes('fixture-password'),false);assert.equal(saved.includes('test@example.invalid'),false);
 assert.equal(fs.statSync(store.file('session.json')).mode&0o777,0o600);
 const client=new sdk.KakaoTalkClient();await client.login({oauthToken:session.oauthToken,userId:session.userId,deviceUuid:session.deviceUuid,deviceType:session.deviceType});
 assert.equal(client.getCredentials().userId,'11');assert.equal(client.isConnected(),false);client.close();
});
test('occupied slot never forces or saves raw failure, UUID path traversal rejected',async t=>{
 const store=fixture(t);let calls=0;
 await assert.rejects(login({sdk:{loginFlow:async o=>{calls++;assert.equal(o.force,false);assert.equal(o.debugLog,undefined);return {next_action:'choose_device',credentials:{access_token:'do-not-log'}};}},store,prompt:async()=> 'fixture',displayPasscode:()=>{}}),/tablet_slot_occupied/);
 assert.equal(calls,1);assert.equal(store.read('session.json'),undefined);
 const good={version:1,userId:'11',oauthToken:'test',refreshToken:'',deviceUuid:'a'.repeat(64),deviceType:'tablet'};
 for(const uuid of ['../x','a'.repeat(64)+'\n'])assert.throws(()=>validateSession({...good,deviceUuid:uuid}));
 assert.throws(()=>validateSession({...good,userId:'11\n'}));
});
test('explicit credentials and self account readback, failure closes client',async t=>{
 const store=fixture(t);store.write('session.json',{version:1,userId:'11',oauthToken:'test',refreshToken:'',deviceUuid:'a'.repeat(64),deviceType:'tablet'});
 let closed=false;class Client{async login(arg){assert.equal(arg.userId,'11');assert.equal(arg.oauthToken,'test');}async getProfile(){return {user_id:'12'};}close(){closed=true;}}
 await assert.rejects(connectClient({KakaoTalkClient:Client},store),/account_mismatch/);assert.equal(closed,true);
});
