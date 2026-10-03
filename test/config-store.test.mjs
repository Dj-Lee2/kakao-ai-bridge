import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFrom, validId } from '../src/config.mjs';
import { StateStore } from '../src/store.mjs';
const env = {AI_BASE_URL:'http://127.0.0.1:1234/v1', AI_MODEL:'mock', KAKAO_ALLOWED_ROOMS:'101'};
test('configuration is default closed, strict numeric IDs, HTTP loopback only', () => {
  assert.deepEqual(configFrom({}).rooms, []);
  for(const id of ['0','01','-1','1e3','9223372036854775808','*']) assert.equal(validId(id), false);
  for(const url of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?q=x','file:///tmp/x'])
    assert.throws(() => configFrom({...env,AI_BASE_URL:url}));
  assert.equal(configFrom(env).endpoint,'http://127.0.0.1:1234/v1/chat/completions');
  assert.throws(() => configFrom({...env,KAKAO_ALLOWED_ROOMS:'101,'}));
  assert.throws(() => configFrom({...env,KAKAO_ALLOWED_ROOMS:'101,101'}));
});
test('private atomic state, exclusive lock and no symlinks', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kakao-test-')); const store=new StateStore(path.join(dir,'state'));
 try {
  store.init(); store.lock(); assert.throws(()=>new StateStore(store.root).lock());
  store.write('test.json',{ok:true}); assert.deepEqual(store.read('test.json'),{ok:true});
  assert.equal(fs.statSync(path.join(store.root,'test.json')).mode & 0o777,0o600);
  const target=path.join(dir,'outside'); fs.writeFileSync(target,'keep'); fs.symlinkSync(target,path.join(store.root,'linked.json'));
  assert.throws(()=>store.write('linked.json',{})); assert.throws(()=>store.read('linked.json'));
  assert.equal(fs.readFileSync(target,'utf8'),'keep');
  store.unlock(); fs.unlinkSync(path.join(store.root,'linked.json'));
  fs.chmodSync(path.join(store.root,'test.json'),0o644); assert.throws(()=>store.init());
 } finally {store.unlock(); fs.rmSync(dir,{recursive:true,force:true});}
});
