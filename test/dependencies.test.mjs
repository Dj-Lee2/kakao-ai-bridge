import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const sdkPackage = require.resolve('agent-messenger/package.json');
const sdkRequire = createRequire(sdkPackage);
const sdkRoot = path.dirname(sdkPackage);
const sdkImport = relative => import(pathToFileURL(path.join(sdkRoot, 'dist/src', relative)));
const thrift = sdkRequire('thrift');
const jose = sdkRequire('node-jose');
const joseRequire = createRequire(sdkRequire.resolve('node-jose'));
const uuid = joseRequire('uuid');

// Overrides are deliberately scoped: node-kms still requires uuid's removed
// callable default export. A blanket uuid upgrade silently breaks that SDK path.
test('dependency graph uses the tested upstream fixes without a blanket uuid override', () => {
  assert.equal(sdkRequire('thrift/package.json').version, '0.25.0');
  assert.equal(joseRequire('uuid/package.json').version, '11.1.1');
  assert.equal(require('agent-messenger/package.json').version, '2.38.1');
  const webexRequire = createRequire(sdkRequire.resolve('webex-message-handler'));
  const kms = webexRequire('node-kms');
  const id = new kms.Context().requestId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('node-jose resolved UUID rejects undersized and offset-overflow buffers before writing', () => {
  for (const name of ['v3', 'v5']) {
    for (const [length, offset] of [[8, 4], [16, 1], [16, -1]]) {
      const target = new Uint8Array(length).fill(0xaa);
      assert.throws(() => uuid[name]('fixture', uuid[name].DNS, target, offset), RangeError, `${name}: ${length}/${offset}`);
      assert.deepEqual(target, new Uint8Array(length).fill(0xaa));
    }
    const target = new Uint8Array(20).fill(0xaa);
    assert.equal(uuid[name]('fixture', uuid[name].DNS, target, 4), target);
    assert.equal(uuid.stringify(target, 4), uuid[name]('fixture', uuid[name].DNS));
    assert.deepEqual(target.slice(0, 4), new Uint8Array(4).fill(0xaa));
  }
});

test('node-jose CommonJS UUID v4 caller and JOSE signing still work', async () => {
  const ids = Array.from({ length: 32 }, () => uuid.v4());
  assert.equal(new Set(ids).size, ids.length);
  assert(ids.every(id => uuid.validate(id) && uuid.version(id) === 4));
  const key = await jose.JWK.createKeyStore().generate('oct', 256);
  const token = await jose.JWS.createSign({ format: 'compact', fields: { alg: 'HS256' } }, key)
    .update('offline dependency fixture', 'utf8').final();
  const verified = await jose.JWS.createVerify(key).verify(token);
  assert.equal(verified.payload.toString(), 'offline dependency fixture');
});

const wireFixtures = {
  TBinaryProtocol: '80010001000000076669787475726500000000080001fffffff90b00020000000eed9a8ceab78020666978747572650a0003000000000001e240020004010f0005080000000200000002000000030c00060b0001000000066e6573746564000000',
  TCompactProtocol: '8221000766697874757265150d180eed9a8ceab78020666978747572651680890f11192504061c18066e6573746564000000',
};
for (const [name, expectedHex] of Object.entries(wireFixtures)) {
  test(`real SDK LINE Thrift ${name} keeps the pre-upgrade wire format`, async () => {
    const { writeThrift } = await sdkImport('vendor/linejs/base/thrift/readwrite/write.js');
    const { readThrift } = await sdkImport('vendor/linejs/base/thrift/readwrite/read.js');
    const value = [[8, 1, -7], [11, 2, '회귀 fixture'], [10, 3, 123456], [2, 4, true], [15, 5, [8, [2, 3]]], [12, 6, [[11, 1, 'nested']]]];
    const encoded = writeThrift(value, 'fixture', thrift[name]);
    // Recorded from unmodified agent-messenger@2.38.1 + thrift@0.20.0.
    assert.equal(Buffer.from(encoded).toString('hex'), expectedHex);
    assert.deepEqual(readThrift(Buffer.from(expectedHex, 'hex'), thrift[name]), {
      data: { 1: -7, 2: '회귀 fixture', 3: 123456, 4: true, 5: [2, 3], 6: { 1: 'nested' } },
      _info: { fname: 'fixture', mtype: 1, rseqid: 0 },
    });
  });

  test(`Thrift ${name} rejects excessive skip recursion with a protocol error`, () => {
    const chunks = [];
    const transport = new thrift.TBufferedTransport(undefined, bytes => chunks.push(bytes));
    const writer = new thrift[name](transport);
    writer.writeStructBegin('root');
    for (let i = 0; i < 70; i++) {
      writer.writeFieldBegin('child', thrift.Thrift.Type.STRUCT, 1);
      writer.writeStructBegin('child');
    }
    writer.writeFieldStop();
    writer.writeStructEnd();
    for (let i = 0; i < 70; i++) {
      writer.writeFieldEnd();
      writer.writeFieldStop();
      writer.writeStructEnd();
    }
    transport.flush();
    const reader = new thrift[name](new thrift.TFramedTransport(Buffer.concat(chunks)));
    assert.throws(() => reader.skip(thrift.Thrift.Type.STRUCT), error => {
      assert.equal(error.name, 'TProtocolException');
      assert.match(error.message, /Maximum (skip|recursion) depth exceeded/);
      return true;
    });
  });
}

function get(server, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: requestPath }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts).toString() }));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('fixture timeout')));
  });
}

test('Thrift static server does not expose a prefix-matching sibling directory', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-thrift-regression-'));
  const publicDir = path.join(dir, 'public');
  const sibling = path.join(dir, 'public-private');
  fs.mkdirSync(publicDir); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(publicDir, 'ok.txt'), 'public fixture');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'private fixture');
  const server = thrift.createWebServer({ files: publicDir, services: {}, headers: {} });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  assert.deepEqual(await get(server, '/ok.txt'), { status: 200, body: 'public fixture' });
  for (const requestPath of ['/../public-private/secret.txt', '/%2e%2e/public-private/secret.txt']) {
    const response = await get(server, requestPath);
    assert([400, 404].includes(response.status), `${requestPath}: ${response.status}`);
    assert(!response.body.includes('private fixture'));
  }
});

test('actual pinned Kakao LOCO BSON, RSA-OAEP and AES-GCM retain their contracts', async () => {
  const { Long } = sdkRequire('bson');
  const { encodePacket, decodePacket } = await sdkImport('platforms/kakaotalk/protocol/packet.js');
  const { LocoCrypto } = await sdkImport('platforms/kakaotalk/protocol/crypto.js');
  const { LOCO_BODY_TYPE_BSON } = await sdkImport('platforms/kakaotalk/protocol/types.js');
  const packet = { packetId: 42, statusCode: 0, method: 'WRITE', bodyType: LOCO_BODY_TYPE_BSON,
    body: { chatId: Long.fromString('9007199254740993'), msg: '한글 offline fixture', type: 1, noSeen: false } };
  const wire = encodePacket(packet);
  assert.equal(decodePacket(wire.subarray(0, wire.length - 1)), null);
  const decoded = decodePacket(wire);
  assert.equal(decoded.bytesConsumed, wire.length);
  assert.equal(decoded.packet.body.chatId.toString(), '9007199254740993');
  assert.equal(decoded.packet.body.msg, packet.body.msg);
  assert.equal(decoded.packet.method, 'WRITE');
  const crypto = new LocoCrypto(Buffer.alloc(16, 0x37));
  const handshake = crypto.buildHandshakePacket();
  assert.equal(handshake.length, 268);
  assert.equal(handshake.readUInt32LE(0), 256);
  const encrypted = crypto.encrypt(wire);
  assert.equal(encrypted.readUInt32LE(0), encrypted.length - 4);
  assert.deepEqual(crypto.decrypt(encrypted.subarray(4)), wire);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => crypto.decrypt(encrypted.subarray(4)));
});

test('actual Kakao low-level send uses BSON Long and never retries an uncertain write', async () => {
  const { Long } = sdkRequire('bson');
  const { LocoSession } = await sdkImport('platforms/kakaotalk/protocol/session.js');
  const session = new LocoSession();
  const calls = [];
  session.connection = { sendPacket: async (...args) => { calls.push(args); throw new Error('fixture uncertain delivery'); } };
  await assert.rejects(session.sendMessage(Long.fromString('9007199254740993'), 'offline fixture'), /fixture uncertain delivery/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'WRITE');
  assert.equal(calls[0][1].chatId.toString(), '9007199254740993');
  assert.deepEqual({ ...calls[0][1], chatId: '9007199254740993' }, {
    chatId: '9007199254740993', msg: 'offline fixture', type: 1, noSeen: false,
  });
});
