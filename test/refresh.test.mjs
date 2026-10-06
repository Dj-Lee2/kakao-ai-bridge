import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { loadSdk } from '../src/sdk.mjs';
import { refreshSession, connectClient, validateSession } from '../src/auth.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-refresh-'));const store=new StateStore(path.join(dir,'state')).init();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return store;}
const SESSION={version:1,userId:'11',oauthToken:'old-access',refreshToken:'old-refresh',deviceUuid:'a'.repeat(64),deviceType:'tablet',createdAt:'2026-01-01T00:00:00.000Z'};

test('refreshSession (real pinned SDK, mocked HTTP) rotates tokens, preserves identity, persists 0600', async t=>{
  const store=fixture(t);store.write('session.json',SESSION);
  const sdk=await loadSdk(store);
  const original=globalThis.fetch;const reqs=[];
  globalThis.fetch=async(url,options)=>{reqs.push({url,options});return new Response(JSON.stringify({status:0,access_token:'new-access',refresh_token:'new-refresh',expires_in:86400,token_type:'bearer'}),{status:200});};
  t.after(()=>{globalThis.fetch=original;});
  const next=await refreshSession(sdk,store,validateSession(store.read('session.json')));
  assert.equal(next.oauthToken,'new-access');assert.equal(next.refreshToken,'new-refresh');
  assert.equal(next.userId,'11');assert.equal(next.deviceUuid,'a'.repeat(64));assert.equal(next.deviceType,'tablet');
  assert.equal(next.createdAt,'2026-01-01T00:00:00.000Z');assert.equal(typeof next.refreshedAt,'string');
  assert.equal(store.read('session.json').oauthToken,'new-access');
  assert.equal(fs.statSync(store.file('session.json')).mode&0o777,0o600);
  assert.match(reqs[0].url,/oauth2_token\.json$/);
  const raw=fs.readFileSync(store.file('session.json'),'utf8');assert.equal(raw.includes('old-access'),false);
});

test('refreshSession keeps the old refresh token when the server omits a new one', async t=>{
  const store=fixture(t);store.write('session.json',SESSION);
  const sdk=await loadSdk(store);const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({status:0,access_token:'new-access'}),{status:200});
  t.after(()=>{globalThis.fetch=original;});
  const next=await refreshSession(sdk,store,validateSession(store.read('session.json')));
  assert.equal(next.oauthToken,'new-access');assert.equal(next.refreshToken,'old-refresh');
});

test('refreshSession rejects a missing refresh token or unavailable SDK method', async t=>{
  const store=fixture(t);
  await assert.rejects(refreshSession({refreshKakaoOAuthToken:async()=>({accessToken:'x'})},store,{...SESSION,refreshToken:''}),/refresh_token_missing/);
  await assert.rejects(refreshSession({},store,SESSION),/sdk_refresh_unavailable/);
});

test('connectClient refreshes once on a stale token and retries successfully', async t=>{
  const store=fixture(t);store.write('session.json',SESSION);
  let logins=0,refreshed=0;
  const sdk={
    refreshKakaoOAuthToken:async(input)=>{refreshed++;assert.equal(input.refreshToken,'old-refresh');return {accessToken:'fresh-access',refreshToken:'fresh-refresh'};},
    KakaoTalkClient:class{
      async login(arg){logins++;if(arg.oauthToken==='old-access')throw Object.assign(new Error('stale'),{code:'invalid_access_token'});}
      async getProfile(){return {user_id:'11'};}
      close(){}
    },
  };
  const {selfId}=await connectClient(sdk,store);
  assert.equal(selfId,'11');assert.equal(refreshed,1);assert.equal(logins,2);
  assert.equal(store.read('session.json').oauthToken,'fresh-access');
});

test('connectClient does NOT refresh on account_mismatch (token is valid, wrong account)', async t=>{
  const store=fixture(t);store.write('session.json',SESSION);
  let refreshed=0;
  const sdk={
    refreshKakaoOAuthToken:async()=>{refreshed++;return {accessToken:'x'};},
    KakaoTalkClient:class{async login(){}async getProfile(){return {user_id:'99'};}close(){}},
  };
  await assert.rejects(connectClient(sdk,store),/account_mismatch/);
  assert.equal(refreshed,0);
});

test('connectClient surfaces the original error when the refresh itself fails', async t=>{
  const store=fixture(t);store.write('session.json',SESSION);
  const sdk={
    refreshKakaoOAuthToken:async()=>{throw new Error('refresh boom');},
    KakaoTalkClient:class{async login(){throw Object.assign(new Error('stale_token'),{code:'invalid_access_token'});}async getProfile(){}close(){}},
  };
  await assert.rejects(connectClient(sdk,store),/stale_token/);
  assert.equal(store.read('session.json').oauthToken,'old-access'); // unchanged
});
