import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const sdkPackage = require.resolve('@kakao-ai-bridge/kakao-sdk/package.json');
const sdkRequire = createRequire(sdkPackage);
const sdkRoot = path.dirname(sdkPackage);
const sdkImport = relative => import(pathToFileURL(path.join(sdkRoot, 'dist/src', relative)));
const publicSdk = () => import('@kakao-ai-bridge/kakao-sdk');

// Exercise the installed, unmodified Kakao modules with real BSON/Zod. Never
// permit an accidental lazy session, HTTP login, or upload to reach a network.
const networkAttempts = [];
let fixtureRoot;
let originalConfigDir;
before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-subset-regression-'));
  fs.chmodSync(fixtureRoot, 0o700);
  originalConfigDir = process.env.AGENT_MESSENGER_CONFIG_DIR;
  process.env.AGENT_MESSENGER_CONFIG_DIR = path.join(fixtureRoot, 'default-config');
  fs.mkdirSync(process.env.AGENT_MESSENGER_CONFIG_DIR, { mode: 0o700 });
  for (const [object, name, label] of [
    [globalThis, 'fetch', 'fetch'], [net, 'connect', 'net.connect'],
    [net, 'createConnection', 'net.createConnection'],
    [net.Socket.prototype, 'connect', 'socket.connect'], [tls, 'connect', 'tls.connect'],
  ]) {
    mock.method(object, name, () => {
      networkAttempts.push(label);
      throw new Error(`Network forbidden in Kakao dependency tests: ${label}`);
    });
  }
  syncBuiltinESMExports();
});
after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  if (originalConfigDir === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR;
  else process.env.AGENT_MESSENGER_CONFIG_DIR = originalConfigDir;
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  assert.deepEqual(networkAttempts, [], 'even handled network attempts must fail the suite');
});
function privateDir(t) {
  const dir = fs.mkdtempSync(path.join(fixtureRoot, 'case-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function account(accountId, userId) {
  return {
    account_id: accountId, user_id: userId, oauth_token: `fixture-token-${accountId}`,
    refresh_token: `fixture-refresh-${accountId}`, device_uuid: 'a'.repeat(64),
    device_type: 'tablet', auth_method: 'login',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
}
function dependencyVersion(name) {
  // BSON deliberately does not export package.json. Resolve from the SDK, then
  // read that resolved package's manifest rather than a root/hoisted lookalike.
  let dir = path.dirname(sdkRequire.resolve(name));
  while (true) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === name) return pkg.version;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `manifest missing for resolved ${name}`);
    dir = parent;
  }
}

test('installed Kakao public entry exposes the genuine classes and pinned runtime dependencies', async () => {
  const sdk = await publicSdk();
  const client = await sdkImport('platforms/kakaotalk/client.js');
  const credentials = await sdkImport('platforms/kakaotalk/credential-manager.js');
  const pkg = JSON.parse(fs.readFileSync(sdkPackage, 'utf8'));
  assert.equal(pkg.name, '@kakao-ai-bridge/kakao-sdk');
  assert.deepEqual(pkg.dependencies, { bson: '6.10.4', zod: '4.6.5' });
  assert.equal(dependencyVersion('bson'), '6.10.4');
  assert.equal(dependencyVersion('zod'), '4.6.5');
  assert.equal(sdk.KakaoTalkClient, client.KakaoTalkClient);
  assert.equal(sdk.KakaoTalkError, client.KakaoTalkError);
  assert.equal(sdk.KakaoCredentialManager, credentials.KakaoCredentialManager);
  assert.equal(sdk.CredentialManager, sdk.KakaoCredentialManager);
  for (const name of ['KakaoTalkListener', 'loginFlow', 'refreshKakaoOAuthToken',
    'classifyKakaoChat', 'planAttachments', 'detectImageDimensions', 'sha1Hex']) {
    assert.equal(typeof sdk[name], 'function', name);
  }
});

test('real Kakao Zod schemas preserve record payloads and distinguish history from push events', async () => {
  const sdk = await publicSdk();
  const message = {
    log_id: '9007199254740993', type: 1, author_id: 11, author_name: null,
    message: '한글 offline fixture', attachment: { extra: { flags: [1, true, null] } }, sent_at: 1700000000,
  };
  const page = { messages: [message], next_cursor: message.log_id, complete: false };
  assert.deepEqual(sdk.KakaoMessagePageSchema.parse(page), page);
  assert.equal(sdk.KakaoMessagePageSchema.safeParse({ ...page, messages: [{ ...message, log_id: 123 }] }).success, false);
  const push = {
    type: 'MSG', chat_id: '9007199254740995', log_id: message.log_id,
    author_id: message.author_id, author_name: null, message: message.message,
    message_type: message.type, attachment: message.attachment, sent_at: message.sent_at,
  };
  assert.deepEqual(sdk.KakaoTalkPushMessageEventSchema.parse(push), push);
  const { message_type: omitted, ...withoutMessageType } = push;
  assert.equal(omitted, 1);
  assert.equal(sdk.KakaoTalkPushMessageEventSchema.safeParse(withoutMessageType).success, false);
  assert.equal(sdk.KakaoMessageSchema.safeParse(push).success, false);
  const saved = account('fixture-primary', '11');
  const config = { current_account: saved.account_id, accounts: { [saved.account_id]: saved } };
  assert.deepEqual(sdk.KakaoConfigSchema.parse(config), config);
  assert.equal(sdk.KakaoAccountCredentialsSchema.safeParse({ ...saved, device_type: 'phone' }).success, false);
  const snapshot = { chat_id: '42', active_members: 0, members: [], complete: true,
    consistency_basis: 'stable_double_read_chatinfo_getmem' };
  assert.deepEqual(sdk.KakaoMemberSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(sdk.KakaoMemberSnapshotSchema.safeParse({ ...snapshot, complete: false }).success, false);
});

test('real Kakao credentials round-trip privately with account switching and removal', async t => {
  const { CredentialManager, KakaoConfigSchema } = await publicSdk();
  const dir = privateDir(t);
  const manager = new CredentialManager(dir);
  assert.deepEqual(await manager.load(), { current_account: null, accounts: {} });
  const primary = account('fixture-primary', '11');
  const secondary = account('fixture-secondary', '12');
  await manager.setAccount(primary);
  await manager.setAccount(secondary);
  assert.deepEqual(await manager.getAccount(), primary);
  await manager.setCurrentAccount(secondary.account_id);
  const reopened = new CredentialManager(dir);
  assert.deepEqual(await reopened.getAccount(), secondary);
  assert.deepEqual(await reopened.getAccount(primary.account_id), primary);
  assert.equal(await reopened.getAccount('fixture-missing'), null);
  assert.deepEqual((await reopened.listAccounts()).map(({ account_id, is_current }) => [account_id, is_current]),
    [[primary.account_id, false], [secondary.account_id, true]]);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'kakaotalk-credentials.json'), 'utf8'));
  assert.deepEqual(KakaoConfigSchema.parse(stored), await reopened.load());
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'kakaotalk-credentials.json')).mode & 0o777, 0o600);
  await reopened.removeAccount(secondary.account_id);
  assert.deepEqual(await manager.getAccount(), primary);
  await reopened.removeAccount(primary.account_id);
  assert.deepEqual(await manager.load(), { current_account: null, accounts: {} });
});

test('real client dynamically loads ensure-auth from isolated credentials without opening a session', async t => {
  const { KakaoTalkClient, KakaoTalkError, CredentialManager } = await publicSdk();
  const dir = privateDir(t);
  const previous = process.env.AGENT_MESSENGER_CONFIG_DIR;
  process.env.AGENT_MESSENGER_CONFIG_DIR = dir;
  t.after(() => { process.env.AGENT_MESSENGER_CONFIG_DIR = previous; });
  const client = new KakaoTalkClient();
  t.after(() => client.close());
  assert.throws(() => client.getCredentials(), error => error instanceof KakaoTalkError && error.code === 'not_authenticated');
  await assert.rejects(client.login(), /No KakaoTalk credentials found/);
  const manager = new CredentialManager();
  const primary = account('fixture-primary', '11');
  const secondary = account('fixture-secondary', '12');
  await manager.setAccount(primary);
  await manager.setAccount(secondary);
  assert.equal(await client.login(undefined, secondary.account_id), client);
  assert.deepEqual(client.getCredentials(), {
    oauthToken: secondary.oauth_token, userId: secondary.user_id,
    deviceUuid: secondary.device_uuid, deviceType: secondary.device_type,
  });
  assert.equal(client.isConnected(), false, 'login only installs credentials; no LOCO connection');
  await client.login();
  assert.equal(client.getCredentials().userId, primary.user_id);
  await assert.rejects(client.login(undefined, 'fixture-missing'), /No KakaoTalk credentials found/);
  await assert.rejects(client.login({ oauthToken: '', userId: '11' }),
    error => error instanceof KakaoTalkError && error.code === 'missing_token');
  assert.deepEqual(fs.readdirSync(dir), ['kakaotalk-credentials.json']);
});

test('real Kakao listener preserves BSON Long IDs and emits schema-valid message, emoticon and read events', async () => {
  const sdk = await publicSdk();
  const { Long } = sdkRequire('bson');
  const chatId = '9007199254740993';
  const logId = '9007199254740995';
  const listener = new sdk.KakaoTalkListener({
    lookupAuthorName: (id, authorId) => {
      assert.equal(id, chatId); assert.equal(authorId, 11); return 'fixture author';
    },
  });
  const messages = []; const emoticons = []; const reads = [];
  listener.on('message', value => messages.push(value));
  listener.on('emoticon', value => emoticons.push(value));
  listener.on('read', value => reads.push(value));
  const body = { chatId: Long.fromString(chatId), chatLog: {
    logId: Long.fromString(logId), authorId: 11, type: 12, message: 'sticker fixture',
    sendAt: 1700000000, attachment: JSON.stringify({ path: '12345.fixture.png', nested: { ok: true } }),
  } };
  listener.handlePush({ method: 'MSG', body });
  assert.deepEqual(sdk.KakaoTalkPushMessageEventSchema.parse(messages[0]), {
    type: 'MSG', chat_id: chatId, log_id: logId, author_id: 11, author_name: 'fixture author',
    message: 'sticker fixture', message_type: 12, attachment: { path: '12345.fixture.png', nested: { ok: true } },
    sent_at: 1700000000,
  });
  assert.deepEqual(sdk.KakaoTalkPushEmoticonEventSchema.parse(emoticons[0]), {
    type: 'EMOTICON', chat_id: chatId, log_id: logId, author_id: 11, author_name: 'fixture author',
    message_type: 12, emoticon_kind: 'sticker', pack_id: '12345', sticker_path: '12345.fixture.png', sent_at: 1700000000,
  });
  for (const attachment of ['not JSON', '[]', '{}', 'null', '']) {
    listener.handlePush({ method: 'MSG', body: { ...body, chatLog: { ...body.chatLog, type: 1, attachment } } });
    assert.equal(messages.at(-1).attachment, null);
  }
  assert.equal(messages.length, 6);
  assert.equal(emoticons.length, 1);
  listener.handlePush({ method: 'DECUNREAD', body: { chatId: body.chatId, userId: 11, watermark: body.chatLog.logId } });
  assert.deepEqual(reads.map(value => sdk.KakaoTalkPushReadEventSchema.parse(value)), [
    { type: 'DECUNREAD', chat_id: chatId, user_id: 11, watermark: logId },
  ]);
});

test('real Kakao listener subscribes once and tears down on kicked or handled startup failure', async () => {
  const { KakaoTalkListener } = await publicSdk();
  let acquireCount = 0; let pushRemoved = 0; let sessionRemoved = 0; let emitSession;
  const client = {
    onPush: () => () => { pushRemoved++; },
    onSessionEvent: callback => { emitSession = callback; return () => { sessionRemoved++; }; },
    isConnected: () => true,
    acquireSession: async () => { acquireCount++; },
    getCredentials: () => ({ userId: '11' }),
  };
  const listener = new KakaoTalkListener(client);
  const connected = []; const errors = [];
  listener.on('connected', event => connected.push(event));
  listener.on('error', error => errors.push(error.message));
  await listener.start(); await listener.start();
  assert.equal(acquireCount, 1);
  assert.deepEqual(connected, [{ userId: '11' }]);
  emitSession({ type: 'kicked', reason: 'fixture revoked' });
  emitSession({ type: 'connected', userId: '12' });
  listener.stop(); listener.stop();
  assert.deepEqual(errors, ['fixture revoked']);
  assert.deepEqual(connected, [{ userId: '11' }]);
  assert.deepEqual([pushRemoved, sessionRemoved], [1, 1]);
  const failure = new Error('fixture session unavailable');
  const failing = new KakaoTalkListener({ ...client, isConnected: () => false,
    acquireSession: async () => { throw failure; } });
  const failures = [];
  failing.on('error', error => failures.push(error));
  // Upstream start() handles the error and resolves: consumers must observe the
  // error event, not treat the resolved Promise as proof of a connected session.
  assert.equal(await failing.start(), undefined);
  assert.deepEqual(failures, [failure]);
  failing.stop();
  assert.deepEqual([pushRemoved, sessionRemoved], [2, 2]);
});

test('real Kakao media helpers detect offset headers, reject truncation and route attachments without uploading', async t => {
  const { detectImageDimensions, sha1Hex, resolveAttachment, planAttachments } = await publicSdk();
  const dir = privateDir(t);
  const backing = Buffer.alloc(40, 0xaa);
  const header = backing.subarray(8, 32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
  header.writeUInt32BE(320, 16); header.writeUInt32BE(240, 20);
  assert.deepEqual(detectImageDimensions(header), { width: 320, height: 240, mimeType: 'image/png' });
  for (const length of [8, 16, 23]) assert.throws(() => detectImageDimensions(header.subarray(0, length)), /Truncated PNG/);
  assert.throws(() => detectImageDimensions(Buffer.from('not an image')), /Unsupported image format/);
  const file = path.join(dir, 'header-fixture.bin');
  fs.writeFileSync(file, header, { mode: 0o600 });
  const data = fs.readFileSync(file);
  assert.equal(await sha1Hex(data), createHash('sha1').update(data).digest('hex').toUpperCase());
  const photo = { data, filename: 'fixture.bin', mime: 'Image/PNG' };
  const secondPhoto = { data, filename: 'fixture.PNG' };
  const document = { data: Buffer.from('offline fixture'), filename: 'fixture.txt' };
  assert.deepEqual(resolveAttachment(photo), { kind: 'photo', mime: 'image/png', data, filename: photo.filename });
  assert.deepEqual(planAttachments([photo]), { kind: 'single', resolved: resolveAttachment(photo) });
  const photos = [photo, secondPhoto];
  const multi = planAttachments(photos);
  assert.equal(multi.kind, 'multiphoto');
  assert.deepEqual(multi.items, photos); assert.notEqual(multi.items, photos);
  const mixed = planAttachments([photo, document]);
  assert.equal(mixed.kind, 'sequential');
  assert.deepEqual(mixed.resolved.map(item => [item.kind, item.mime]), [['photo', 'image/png'], ['file', 'text/plain']]);
  assert.throws(() => planAttachments([]), /empty attachments array/);
});

test('real Kakao classification recognizes both OpenChat wire forms and fails closed for unknown string types', async () => {
  const { classifyKakaoChat, isOpenKakaoChatType } = await publicSdk();
  for (const type of [2, 13, 14, 15, 16, 'OM', 'OD']) {
    assert.equal(isOpenKakaoChatType(type), true);
    assert.equal(classifyKakaoChat({ type, active_members: 2 }), 'open');
  }
  for (const type of [11, 'DirectChat']) {
    assert.equal(isOpenKakaoChatType(type), false);
    assert.equal(classifyKakaoChat({ type, active_members: 2 }), 'dm');
  }
  for (const type of [10, 'MultiChat']) assert.equal(classifyKakaoChat({ type, active_members: 3 }), 'group');
  assert.equal(classifyKakaoChat({ type: 'future-protocol-type', active_members: 2 }), 'unknown');
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
