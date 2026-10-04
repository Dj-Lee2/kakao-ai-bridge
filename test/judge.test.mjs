import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configFrom } from '../src/config.mjs';
import { askJudge, askAi, JUDGE } from '../src/ai.mjs';

async function server(t, reply) {
  const seen = [];
  const srv = http.createServer((req, res) => {let body = ''; req.on('data', x => body += x); req.on('end', () => {
    seen.push(JSON.parse(body)); res.end(JSON.stringify({choices:[{message:{content:reply()}}]}));
  });});
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); t.after(() => {srv.closeAllConnections(); srv.close();});
  return {seen, cfg:configFrom({AI_BASE_URL:`http://127.0.0.1:${srv.address().port}/v1`, AI_MODEL:'mock', KAKAO_ALLOWED_ROOMS:'101'})};
}
test('judge reads only a leading YES/예 and sends names plus recent context', async t => {
  let answer = 'YES';
  const {seen, cfg} = await server(t, () => answer);
  const context = [{who:'철수', text:'점심 뭐 먹지'}];
  for (const [reply, expected] of [['YES', true], ['예.', true], ['**yes**', true], ['NO', false], ['아니요', false], ['yesterday', false], ['네, 아니요 NO', false]]) {
    answer = reply; assert.equal(await askJudge(cfg, '코덱스야 추천해줘', undefined, context, ['코덱스']), expected, reply);
  }
  assert.equal(seen[0].messages[0].content, JUDGE);
  assert.match(seen[0].messages[1].content, /AI 도우미 이름: 코덱스\n최근 대화:\n철수: 점심 뭐 먹지\n\n마지막 메시지: 코덱스야 추천해줘/);
  assert.equal(seen[0].max_tokens, 64);
});
test('group answers carry context while 1:1 answers stay a single question', async t => {
  const {seen, cfg} = await server(t, () => '답변');
  await askAi(cfg, '질문');
  await askAi(cfg, '질문', undefined, [{who:'영희', text:'앞선 말'}], ['봇']);
  assert.equal(seen[0].messages[1].content, '질문');
  assert.match(seen[1].messages[1].content, /영희: 앞선 말[\s\S]*마지막 메시지: 질문/);
});
test('reply mode and bot names are validated', () => {
  const base = {AI_BASE_URL:'http://127.0.0.1:1/v1', AI_MODEL:'m', KAKAO_ALLOWED_ROOMS:'101'};
  assert.equal(configFrom(base).replyMode, 'auto');
  assert.deepEqual(configFrom({...base, KAKAO_BOT_NAMES:'코덱스, 봇'}).botNames, ['코덱스', '봇']);
  for (const env of [{KAKAO_REPLY_MODE:'always'}, {KAKAO_BOT_NAMES:'a,,b'}, {KAKAO_BOT_NAMES:'x'.repeat(21)}, {BRIDGE_MAX_JUDGES_PER_HOUR:'0'}])
    assert.throws(() => configFrom({...base, ...env}), /invalid_/, JSON.stringify(env));
});
