import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configFrom, requireRunnable } from '../src/config.mjs';
import { askAi } from '../src/ai.mjs';

// All credentials and identities here are synthetic; never contact a real Gateway.
const env = { AI_PROVIDER:'openclaw', OPENCLAW_AGENT_ID:'kakao-bridge', OPENCLAW_GATEWAY_TOKEN:'fixture-gateway-only', KAKAO_ALLOWED_ROOMS:'101' };
const response = { choices:[{message:{role:'assistant',content:'답변'}}] };
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  t.after(()=>{s.closeAllConnections();s.close();});
  return `http://127.0.0.1:${s.address().port}/v1`;
}
function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-openclaw-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  return cwd;
}
const cli=fileURLToPath(new URL('../bin/bridge.mjs',import.meta.url));
function run(cwd,command,extra={}) {
  return spawnSync(process.execPath,[cli,command],{cwd,encoding:'utf8',timeout:10000,
    env:{PATH:process.env.PATH,HOME:cwd,AGENT_MESSENGER_CONFIG_DIR:path.join(cwd,'do-not-use'),...extra}});
}

test('provider defaults to backward-compatible API configuration',()=>{
  const cfg=configFrom({AI_BASE_URL:'http://127.0.0.1:1234/v1',AI_MODEL:'legacy',AI_API_KEY:'fixture-api'});
  assert.equal(cfg.provider,'openai-compatible');
  assert.equal(cfg.endpoint,'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(cfg.model,'legacy');assert.equal(cfg.key,'fixture-api');
});
test('OpenClaw has a dedicated endpoint, credential and exact agent target; stale API vars are ignored',()=>{
  const cfg=configFrom({...env,AI_BASE_URL:'not-a-url',AI_API_KEY:'fixture-api-never-use',AI_MODEL:'wrong-provider/model'});
  assert.equal(cfg.provider,'openclaw');assert.equal(cfg.endpoint,'http://127.0.0.1:18789/v1/chat/completions');
  assert.equal(cfg.agentId,'kakao-bridge');assert.equal(cfg.model,'openclaw/kakao-bridge');
  assert.equal(cfg.gatewayToken,env.OPENCLAW_GATEWAY_TOKEN);assert.equal(cfg.key,'');
  assert.equal(JSON.stringify(cfg).includes('fixture-api-never-use'),false);
  assert.doesNotThrow(()=>requireRunnable(cfg));
  for(const base of ['http://localhost:18789/v1/','http://[::1]:18789/v1','https://gateway.example.test/bridge/v1']) {
    assert.equal(configFrom({...env,OPENCLAW_BASE_URL:base}).endpoint,base.replace(/\/$/,'')+'/chat/completions');
  }
});
test('unknown or nonliteral providers fail instead of falling back',()=>{
  for(const provider of ['','OPENCLAW','openclaw\n','openclaw ','oauth','openai'])
    assert.throws(()=>configFrom({...env,AI_PROVIDER:provider}),/invalid_AI_PROVIDER/);
});
test('agent IDs must be exact canonical IDs, never aliases or repaired input',()=>{
  for(const id of ['default','kakao/other','agent:kakao','Kakao','../main','kakao\n',' kakao','kakao ','한글','a'.repeat(65),'a\r\nb: c','kakao%2fmain','_agent'])
    assert.throws(()=>configFrom({...env,OPENCLAW_AGENT_ID:id}),/invalid_OPENCLAW_AGENT_ID/,JSON.stringify(id));
  for(const id of ['kakao','kakao_2','kakao-2','a'.repeat(64)])
    assert.equal(configFrom({...env,OPENCLAW_AGENT_ID:id}).agentId,id);
});
test('OpenClaw requires explicit agent and gateway token even on loopback; no API-key fallback',()=>{
  assert.throws(()=>requireRunnable(configFrom({...env,OPENCLAW_AGENT_ID:''})),/OPENCLAW_AGENT_ID_required/);
  assert.throws(()=>requireRunnable(configFrom({...env,OPENCLAW_GATEWAY_TOKEN:'',AI_API_KEY:'fixture-api'})),/OPENCLAW_GATEWAY_TOKEN_required/);
  assert.throws(()=>requireRunnable(configFrom({...env,KAKAO_ALLOWED_ROOMS:'',OPENCLAW_GATEWAY_TOKEN:''})),/room_allowlist_empty/);
});
test('gateway token rejects whitespace, control and non-ASCII input without echoing it',()=>{
  for(const token of [' ','fixture token','Bearer fixture','fixture\n','fixture\r','fixture\t','비밀','fixture\x00','fixture\x7f'])
    assert.throws(()=>configFrom({...env,OPENCLAW_GATEWAY_TOKEN:token}),/invalid_OPENCLAW_GATEWAY_TOKEN/);
});
test('OpenClaw URL rejects unsafe transports, credentials, silent repairs and wrong API paths',()=>{
  for(const base of ['http://gateway.example.test/v1','http://192.168.1.5:18789/v1','https://u:p@gateway.example.test/v1','https://gateway.example.test/v1?q=token','https://gateway.example.test/v1#x','file:///v1','https://gateway.example.test','https://gateway.example.test/v1/chat/completions',' https://gateway.example.test/v1','https://gate\nway.example.test/v1','https://gateway.example.test/%76%31','https://gateway.example.test/v1/../v1'])
    assert.throws(()=>configFrom({...env,OPENCLAW_BASE_URL:base}),/(invalid|insecure)_OPENCLAW_BASE_URL/,JSON.stringify(base));
});
test('OpenClaw actual HTTP uses configured agent, gateway bearer, token budget and fresh anonymous sessions',async t=>{
  const received=[];
  const base=await server(t,(req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{
    received.push({method:req.method,url:req.url,headers:req.headers,body:JSON.parse(b)});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));
  });});
  const cfg=configFrom({...env,OPENCLAW_BASE_URL:base,AI_API_KEY:'fixture-api-never-send',AI_MODEL:'wrong',AI_MAX_OUTPUT_TOKENS:'99'});
  assert.equal(await askAi(cfg,'hello'),'답변');assert.equal(await askAi(cfg,'again'),'답변');
  assert.equal(received.length,2);
  for(const [i,r] of received.entries()) {
    assert.equal(r.method,'POST');assert.equal(r.url,'/v1/chat/completions');
    assert.equal(r.headers.authorization,'Bearer fixture-gateway-only');
    assert.equal(r.headers['content-type'],'application/json');
    for(const h of ['x-openclaw-model','x-openclaw-session-key','x-openclaw-scopes'])assert.equal(r.headers[h],undefined);
    assert.deepEqual(Object.keys(r.body).sort(),['model','stream','max_completion_tokens','user','messages'].sort());
    assert.equal(r.body.model,'openclaw/kakao-bridge');assert.equal(r.body.stream,false);assert.equal(r.body.max_completion_tokens,99);
    assert.match(r.body.user,/^kakao-[a-f0-9-]{36}$/);assert.equal(r.body.messages.length,2);
    assert.deepEqual(r.body.messages[1],{role:'user',content:i===0?'hello':'again'});
    assert.equal(JSON.stringify(r).includes('fixture-api-never-send'),false);
    assert.equal(JSON.stringify(r.body).includes('fixture-gateway-only'),false);
    assert.equal(JSON.stringify(r.body.messages).includes('101'),false);
  }
  assert.notEqual(received[0].body.user,received[1].body.user);
});
test('OpenClaw redirect never reaches destination or forwards gateway secret',async t=>{
  let hits=0;
  const dest=await server(t,(_req,res)=>{hits++;res.end(JSON.stringify(response));});
  const base=await server(t,(_req,res)=>{res.writeHead(307,{Location:dest+'/chat/completions'});res.end();});
  await assert.rejects(askAi(configFrom({...env,OPENCLAW_BASE_URL:base}),'hello'),/ai_request_failed/);
  assert.equal(hits,0);
});
test('OpenClaw HTTP auth, disabled endpoint, invalid agent and overload fail once without raw diagnostics',async t=>{
  for(const status of [400,401,403,404,429,503]) {
    let hits=0;
    const base=await server(t,(_req,res)=>{hits++;res.writeHead(status);res.end('fixture-sensitive-server-message');});
    await assert.rejects(askAi(configFrom({...env,OPENCLAW_BASE_URL:base}),'hello'),error=>{
      assert.equal(error.message,'ai_http_failed');assert.equal(error.message.includes('fixture'),false);return true;
    });
    assert.equal(hits,1);
  }
});
test('OpenClaw rejects tools, invalid JSON, huge bodies, empty text and over-budget responses',async t=>{
  for(const [body,code] of [
    [JSON.stringify({choices:[{message:{content:'x',tool_calls:[{}]}}]}),'ai_invalid_response'],
    [JSON.stringify({choices:[{message:{content:'x',function_call:{}}}]}),'ai_invalid_response'],
    ['not-json','ai_invalid_json'],['x'.repeat(262145),'ai_response_too_large'],
    [JSON.stringify({choices:[{message:{content:' '}}]}),'ai_invalid_response'],
    [JSON.stringify({...response,usage:{completion_tokens:801}}),'ai_output_budget_exceeded']
  ]) {
    const base=await server(t,(_req,res)=>res.end(body));
    await assert.rejects(askAi(configFrom({...env,OPENCLAW_BASE_URL:base}),'hello'),new RegExp(code));
  }
});
test('OpenClaw timeout and caller cancellation remain bounded and redacted',async t=>{
  const base=await server(t,()=>{});const cfg=configFrom({...env,OPENCLAW_BASE_URL:base,AI_TIMEOUT_MS:'100'});
  await assert.rejects(askAi(cfg,'x'),/ai_request_failed/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(askAi(cfg,'x',controller.signal),/stopped/);
});
test('missing OpenClaw token fails before HTTP even when askAi is called directly',async t=>{
  let hits=0;const base=await server(t,(_req,res)=>{hits++;res.end(JSON.stringify(response));});
  await assert.rejects(askAi(configFrom({...env,OPENCLAW_BASE_URL:base,OPENCLAW_GATEWAY_TOKEN:''}),'x'),/OPENCLAW_GATEWAY_TOKEN_required/);
  assert.equal(hits,0);
});
test('offline doctor identifies OpenClaw route without displaying endpoint, provider credentials or tokens',t=>{
  const cwd=fixture(t);fs.mkdirSync(path.join(cwd,'.state'),{mode:0o700});
  fs.writeFileSync(path.join(cwd,'.state','session.json'),JSON.stringify({version:1,userId:'11',oauthToken:'fixture-kakao',refreshToken:'',deviceUuid:'a'.repeat(64),deviceType:'tablet'}),{mode:0o600});
  const r=run(cwd,'doctor',{...env,OPENCLAW_BASE_URL:'https://fixture-private.example.test/v1',AI_API_KEY:'fixture-api-never-print'});
  assert.equal(r.status,0,r.stdout+r.stderr);const d=JSON.parse(r.stdout);
  assert.equal(d.offline,true);assert.equal(d.networkChecked,false);assert.equal(d.aiProvider,'openclaw');
  assert.equal(d.openclawAgentId,'kakao-bridge');assert.equal(d.aiAuth,'gateway-token');
  for(const value of ['fixture-private','fixture-api-never-print','fixture-gateway-only','fixture-kakao'])assert.equal((r.stdout+r.stderr).includes(value),false);
  assert.equal(fs.existsSync(path.join(cwd,'do-not-use')),false);
});
test('OpenClaw doctor and start reject missing token before SDK/state/network side effects',t=>{
  const cwd=fixture(t);const vars={...env,OPENCLAW_GATEWAY_TOKEN:'',AI_API_KEY:'fixture-api-do-not-use'};
  const doctor=run(cwd,'doctor',vars);assert.equal(doctor.status,1);
  assert.equal(JSON.parse(doctor.stdout).checks.find(x=>x.name==='configuration').code,'OPENCLAW_GATEWAY_TOKEN_required');
  const start=run(cwd,'start',vars);assert.equal(start.status,1);assert.match(start.stderr,/OPENCLAW_GATEWAY_TOKEN_required/);
  assert.equal(fs.existsSync(path.join(cwd,'.state')),false);assert.equal(fs.existsSync(path.join(cwd,'do-not-use')),false);
});
