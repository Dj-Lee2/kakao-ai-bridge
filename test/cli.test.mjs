import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli=fileURLToPath(new URL('../bin/bridge.mjs',import.meta.url));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function run(cwd,command,env={}){return spawnSync(process.execPath,[cli,command],{cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:cwd,AGENT_MESSENGER_CONFIG_DIR:path.join(cwd,'do-not-use'),...env},timeout:10000});}
test('setup no-overwrite, doctor offline not ready, default start closed',t=>{
 const cwd=fixture(t);const setup=run(cwd,'setup');assert.equal(setup.status,0,setup.stderr);
 const file=path.join(cwd,'.env');assert.equal(fs.statSync(file).mode&0o777,0o600);
 const text=fs.readFileSync(file,'utf8');assert.equal(run(cwd,'setup').status,0);assert.equal(fs.readFileSync(file,'utf8'),text);
 const doctor=run(cwd,'doctor');assert.equal(doctor.status,1);assert.equal(JSON.parse(doctor.stdout).networkChecked,false);
 const start=run(cwd,'start');assert.equal(start.status,1);assert.match(start.stderr,/room_allowlist_empty/);
 assert.equal(fs.existsSync(path.join(cwd,'do-not-use')),false);assert.equal(fs.existsSync(path.join(cwd,'.state')),false);
});
test('login/rooms refuse pipes, unknown arguments and errors never print secrets',t=>{
 const cwd=fixture(t);
 for(const cmd of ['login','rooms']){const r=run(cwd,cmd,{AI_API_KEY:'fixture-secret-never-print'});assert.equal(r.status,1);assert.match(r.stderr,/interactive_terminal_required/);assert.equal((r.stdout+r.stderr).includes('fixture-secret-never-print'),false);}
 const result=spawnSync(process.execPath,[cli,'login','--force'],{cwd,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/unexpected_arguments/);
});
test('unsafe env is refused; fresh offline doctor ready uses only synthetic session',t=>{
 const cwd=fixture(t);fs.writeFileSync(path.join(cwd,'.env'),'AI_API_KEY=fixture-only',{mode:0o644});assert.equal(run(cwd,'doctor').status,1);
 fs.chmodSync(path.join(cwd,'.env'),0o600);fs.mkdirSync(path.join(cwd,'.state'),{mode:0o700});
 fs.writeFileSync(path.join(cwd,'.state','session.json'),JSON.stringify({version:1,userId:'11',oauthToken:'fixture',refreshToken:'',deviceUuid:'a'.repeat(64),deviceType:'tablet'}),{mode:0o600});
 const ready=run(cwd,'doctor',{AI_MODEL:'fixture',KAKAO_ALLOWED_ROOMS:'101'});assert.equal(ready.status,0,ready.stdout+ready.stderr);
 assert.equal(JSON.parse(ready.stdout).checks.every(x=>x.ok),true);assert.equal(ready.stdout.includes('oauthToken'),false);
});
