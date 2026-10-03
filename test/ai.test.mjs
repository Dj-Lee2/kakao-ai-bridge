import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { askAi } from '../src/ai.mjs';
import { configFrom } from '../src/config.mjs';
async function server(t,fn){const s=http.createServer(fn); await new Promise(r=>s.listen(0,'127.0.0.1',r)); t.after(()=>{s.closeAllConnections();s.close();}); return `http://127.0.0.1:${s.address().port}/v1`;}
test('actual HTTP: no IDs/history, bounded plain completion',async t=>{
 const url=await server(t,(req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{const d=JSON.parse(b);assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer fixture-key');assert.equal(d.messages.length,2);assert.equal(d.messages[1].content,'hello');assert.equal(d.user.startsWith('kakao-'),true);res.end(JSON.stringify({choices:[{message:{content:'답변'}}]}));});});
 const c=configFrom({AI_BASE_URL:url,AI_MODEL:'mock',AI_API_KEY:'fixture-key'});assert.equal(await askAi(c,'hello'),'답변');
});
test('HTTP timeout and caller abort stop requests without raw errors',async t=>{
 const url=await server(t,()=>{});
 const cfg=configFrom({AI_BASE_URL:url,AI_MODEL:'mock',AI_TIMEOUT_MS:'100'});
 await assert.rejects(askAi(cfg,'x'),/ai_request_failed/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(askAi(cfg,'x',controller.signal),/stopped/);
});
test('redirects, tool calls, oversized bodies, bad HTTP rejected',async t=>{
 for(const mode of ['redirect','tools','huge','error']){
 const url=await server(t,(_req,res)=>{if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/steal'});res.end();} else if(mode==='error'){res.writeHead(401);res.end('secret-body');} else if(mode==='huge')res.end('x'.repeat(262145));else res.end(JSON.stringify({choices:[{message:{content:'x',tool_calls:[{}]}}]}));});
 await assert.rejects(askAi(configFrom({AI_BASE_URL:url,AI_MODEL:'mock'}),'x'));
 }
});
