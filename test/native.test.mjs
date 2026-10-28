import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cat, uint, sized, tlvs, Reader } from '../src/qq/native/binary.mjs';
import { encrypt, decrypt } from '../src/qq/native/tea.mjs';
import { encode, decode, number, text, nested } from '../src/qq/native/protobuf.mjs';
import { HttpSigner, QQTransport, unpackResponse, MAX_PACKET } from '../src/qq/native/transport.mjs';
import { linuxProfile } from '../src/qq/native/profile.mjs';
import { decodeSendAck, decodePush } from '../src/qq/native/messages.mjs';
import { createApp } from '../src/app.mjs';
import { LoginCodec } from '../src/qq/native/login.mjs';
import { fetchFriends, fetchGroups } from '../src/qq/native/contacts.mjs';
import { app, request, temp, config, cleanup, waitFor, wsClient } from './helpers.mjs';

// Synthetic protocol peer. This checks our on-wire integration, not QQ account
// compatibility. No QQ account, public signer or Tencent gateway is contacted.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a91cAAAAASUVORK5CYII=', 'base64');
function responseFrame(sequence, command, body, { key = Buffer.alloc(16), code = 0, compression = 0 } = {}) {
  const codeBytes = Buffer.alloc(4); codeBytes.writeInt32BE(code);
  const header = cat(uint(sequence), codeBytes, sized(''), sized(command), sized(''), uint(compression));
  if (compression === 1) body = deflateSync(body);
  return sized(cat(uint(12), Buffer.from([key.equals(Buffer.alloc(16)) ? 2 : 1, 0]), sized('10000'), encrypt(cat(sized(header), sized(body)), key)));
}
function loginReply(codec, body, account = 10000) {
  const packet = cat(Buffer.from([2]), uint(0, 2), uint(8001, 2), uint(2066, 2), uint(1, 2), uint(account),
    Buffer.from([3, 0, 0]), encrypt(body, codec.key), Buffer.from([3]));
  packet.writeUInt16BE(packet.length, 1); return packet;
}
function readRequest(frame, key = Buffer.alloc(16)) {
  const service = new Reader(frame);
  assert.equal(service.u(), 12);
  const method = service.u(1); service.sized(); service.skip(1);
  const account = Number(service.sized().toString());
  const packet = new Reader(decrypt(service.rest(), method === 1 ? key : Buffer.alloc(16)));
  const header = new Reader(packet.sized()), sequence = header.u();
  header.skip(20); header.sized(); const command = header.sized().toString();
  return { sequence, command, body: packet.sized(), account };
}
async function peer(t, handler, key) {
  const sockets = new Set();
  const server = tcpServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = cat(pending, chunk);
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE()) {
        const length = pending.readUInt32BE();
        const frame = pending.subarray(4, length); pending = pending.subarray(length);
        const packet = readRequest(frame, key);
        handler(packet, socket);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup(t, () => { for (const socket of sockets) socket.destroy(); return new Promise(done => server.close(done)); });
  return server.address().port;
}

test('native binary/protobuf parsing checks lengths and preserves large integers', () => {
  assert.equal(encode({ 1: 150, 2: '测试', 3: [1, 2] }).toString('hex'), '0896011206e6b58be8af9518011802');
  const message = decode(encode({ 1: 18446744073709551615n, 2: { 3: 'nested' } }));
  assert.equal(message.get(1)[0], 18446744073709551615n);
  assert.equal(text(nested(message, 2), 3), 'nested');
  assert.throws(() => number(message, 1), /number/);
  assert.throws(() => decode(Buffer.from('0a7f00', 'hex')), /length/);
  assert.throws(() => decode(Buffer.from('088080808080808080808002', 'hex')), /varint/);
  assert.throws(() => new Reader(Buffer.from([0, 0, 0, 3])).sized(), /length/);
  assert.throws(() => new Reader(tlvs([[1, Buffer.from('a')], [1, Buffer.from('b')]])).tlvs(), /Duplicate/);
});

test('QQ TEA chaining round-trips boundary sizes and rejects malformed padding', () => {
  for (let length = 0; length <= 80; length++) {
    const key = randomBytes(16), plain = randomBytes(length), cipher = encrypt(plain, key);
    assert.equal(cipher.length % 8, 0); assert.deepEqual(decrypt(cipher, key), plain);
    const corrupt = Buffer.from(cipher); corrupt[corrupt.length - 1] ^= 0xff;
    assert.throws(() => decrypt(corrupt, key), /padding/);
  }
  assert.throws(() => decrypt(Buffer.alloc(17), Buffer.alloc(16)), /length/);
});

test('QQ TEA decrypts independently published interoperability vectors', () => {
  // Public test data, not generated by this implementation:
  // https://github.com/fumiama/gofastTEA/blob/main/tea_test.go
  const vectors = [
    ['MiraiGO Here', 'b7b2e52af7f5b1fbf37fc3d5546ac7569aecd01bbacf09bf'],
    ['s', '528e8b5c48300b548e94262736ebb8b7'],
    ['long long long long long long long', '95715fab6efbd0fd4b76dbc80bd633ebe805849dbc242053b06557f87e748effd9f613f782749fb9fdfa3f45c0c26161']
  ];
  for (const [plain, cipher] of vectors) assert.equal(decrypt(Buffer.from(cipher, 'hex'), Buffer.from('0123456789ABCDEF')).toString(), plain);
});

test('native signer fails closed, uses selected profile, never follows redirects', async () => {
  const profile = linuxProfile, session = { account: 10000, guid: '1'.repeat(32) };
  await assert.rejects(new HttpSigner({ profile }).sign('wtlogin.login', 1, Buffer.alloc(0), session), /QQ_SIGN_URL/);
  let request;
  const signer = new HttpSigner({ profile, signUrl: 'http://127.0.0.1/sign', signToken: 'test-secret' }, async (_url, init) => {
    request = init;
    return new Response(JSON.stringify({ code: 0, value: { sign: 'aa', token: 'bb', extra: '' } }));
  });
  assert.deepEqual(await signer.sign('wtlogin.login', 7, Buffer.from('abc'), session), { 1: Buffer.from('aa', 'hex'), 2: Buffer.from('bb', 'hex'), 3: Buffer.alloc(0) });
  assert.equal(request.redirect, 'error'); assert.equal(request.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(request.body), { command: 'wtlogin.login', seq: 7, body: '616263', uin: 10000, guid: session.guid, qua: profile.package_sign });
  assert.equal(await signer.sign('unknown.read', 1, Buffer.alloc(0), session), undefined);
});

test('TCP framing handles fragmented compressed replies, command matching and cancellation after write', async t => {
  const port = await peer(t, (packet, socket) => {
    if (packet.command === 'query') {
      const frame = responseFrame(packet.sequence, packet.command, Buffer.from('reply'), { compression: 1 });
      socket.write(frame.subarray(0, 3)); setTimeout(() => socket.write(frame.subarray(3)), 10);
    }
  });
  const transport = new QQTransport({ host: '127.0.0.1', port, profile: linuxProfile,
    session: { account: 10000, guid: '0'.repeat(32) }, signer: { sign: async () => undefined }, timeout: 80 });
  cleanup(t, () => transport.close()); await transport.open();
  assert.equal((await transport.request('query', Buffer.alloc(0))).toString(), 'reply');
  await assert.rejects(transport.request('send', Buffer.from('message'), { mutation: true }), error => error.uncertain && !error.retryable);
  assert.equal(transport.pending.size, 0);
  const controller = new AbortController(); controller.abort();
  const count = transport.stats.sent;
  await assert.rejects(transport.request('send', Buffer.alloc(0), { signal: controller.signal, mutation: true }), error => !error.uncertain);
  assert.equal(transport.stats.sent, count);
  assert.throws(() => unpackResponse(responseFrame(1, 'x', Buffer.alloc(0), { code: -10003 }).subarray(4)), error => error.authExpired);
});

test('oversized TCP frames fail closed and reject pending mutations as uncertain', async t => {
  const port = await peer(t, (_packet, socket) => socket.write(uint(MAX_PACKET + 1)));
  const transport = new QQTransport({ host: '127.0.0.1', port, profile: linuxProfile,
    session: { account: 10000, guid: '0'.repeat(32) }, signer: { sign: async () => undefined }, timeout: 300 });
  cleanup(t, () => transport.close());
  let fault; transport.on('fault', error => { fault = error; }); await transport.open();
  await assert.rejects(transport.request('send', Buffer.alloc(0), { mutation: true }), error => error.uncertain);
  assert.match(fault.message, /frame size/); assert.equal(transport.stats.connected, false);
});

test('native mode is offline until authenticated and missing signer is actionable', async t => {
  const application = await app(t, { QQ_DRIVER: 'native' });
  const status = (await request(application, '/admin/status')).data;
  assert.equal(status.online, false); assert.equal(status.simulated, false);
  assert.equal(status.native.signer_configured, false);
  const result = (await request(application, '/admin/login/start', {})).data;
  assert.equal(result.retcode, 1501); assert.match(result.message, /QQ_SIGN_URL/);
  assert.equal(application.adapter.driver.transport.stats.sent, 0);
});

function pushed({ sender = 10001, target = 10000, sequence = 76, groupId, mention, unsupported = false } = {}) {
  const time = Math.floor(Date.now() / 1000);
  return encode({ 1: {
    1: { 1: sender, 2: `u_${sender}`, 5: target, 6: `u_${target}`, 7: { 6: 'sender' },
      8: groupId ? { 1: groupId, 4: 'group member' } : undefined },
    2: { 1: groupId ? 82 : 166, 5: sequence, 6: time },
    3: { 1: { 2: [
      ...(mention ? [{ 1: { 1: '@bot', 12: encode({ 3: 2, 9: `u_${mention}` }) } }] : []),
      { 1: { 1: '来自协议测试端的中文消息' } }, ...(unsupported ? [{ 8: { 1: 'image' } }] : [])
    ] } }
  } });
}

test('native QR login, encrypted registration, text send/receive, stable IDs and session restore traverse actual TCP + HTTP', async t => {
  const d2key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), qrKey = randomBytes(16);
  let driver, onlineSocket, sends = 0, qrRequests = 0, registrations = 0;
  const commands = [];
  const gateway = await peer(t, (packet, socket) => {
    commands.push(packet.command);
    const reply = body => socket.write(responseFrame(packet.sequence, packet.command, body,
      { key: packet.command === 'wtlogin.trans_emp' || packet.command === 'wtlogin.login' ? Buffer.alloc(16) : d2key }));
    if (packet.command === 'wtlogin.trans_emp') {
      const envelope = new Reader(packet.body).skip(50);
      assert.equal(envelope.sized(2, false).length, 65);
      const plain = decrypt(envelope.take(envelope.remaining - 1), driver.codec.key);
      const subcommand = plain.readUInt16BE(21);
      if (subcommand === 0x31) {
        qrRequests++; reply(loginReply(driver.codec, cat(Buffer.alloc(54), Buffer.from([0]), sized('qr-signature', 2, false), tlvs([[0x17, png]]))));
      } else {
        assert.equal(subcommand, 0x12);
        reply(loginReply(driver.codec, cat(Buffer.alloc(54), Buffer.from([0]), Buffer.alloc(4), uint(10000), Buffer.alloc(4),
          tlvs([[0x18, Buffer.from('credential')], [0x19, Buffer.from('noPic')], [0x1e, qrKey]]))));
      }
    } else if (packet.command === 'wtlogin.login') {
      const credential = tlvs([[0x143, Buffer.from('test-d2')], [0x305, d2key], [0x10a, Buffer.from('test-tgt')],
        [0x11a, cat(Buffer.alloc(4), sized('测试机器人', 1, false))], [0x543, encode({ 9: { 11: { 1: 'u_10000' } } })]]);
      reply(loginReply(driver.codec, cat(uint(9, 2), Buffer.from([0]), tlvs([[0x119, encrypt(credential, qrKey)]]))));
    } else if (packet.command.endsWith('.Register')) {
      registrations++; assert.equal(packet.account, 10000); onlineSocket = socket;
      reply(encode({ 2: 'register success' }));
    } else if (packet.command === 'MessageSvc.PbSendMsg') {
      sends++;
      const message = decode(packet.body);
      assert.equal(text(nested(nested(message, 1), 1), 2), 'u_10001');
      reply(encode({ 1: 0, 3: Math.floor(Date.now() / 1000), 14: 77 }));
    } else throw new Error(`Unexpected synthetic peer command ${packet.command}`);
  }, d2key);
  const signed = [];
  const signer = httpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    signed.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, value: { sec_sign: 'aa', sec_token: 'bb', sec_extra: '' } }));
  });
  signer.listen(0, '127.0.0.1'); await once(signer, 'listening');
  cleanup(t, () => new Promise(done => signer.close(done)));
  const directory = await temp(t);
  const cfg = config(directory, { QQ_DRIVER: 'native', QQ_ACCOUNT: '10000', QQ_SERVER_HOST: '127.0.0.1', QQ_SERVER_PORT: String(gateway),
    QQ_SIGN_URL: `http://127.0.0.1:${signer.address().port}/sign` });
  let application = await createApp(cfg, { log: () => {} }); cleanup(t, () => application.close());
  driver = application.adapter.driver;
  const ws = await wsClient(t, application, '/event');
  const login = (await request(application, '/admin/login/start', {})).data;
  assert.equal(login.status, 'ok'); assert.equal(login.data.state, 'waiting_scan');
  assert.equal(login.data.qrcode, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(login.data.expires_at, null);
  assert.equal((await request(application, '/admin/login/start', {})).data.data.handle, login.data.handle);
  assert.equal(qrRequests, 1);
  assert.equal((await request(application, '/admin/login/poll', { handle: 'bad' })).data.retcode, 1400);
  const polled = (await request(application, '/admin/login/poll', { handle: login.data.handle })).data;
  assert.equal(polled.data.state, 'online'); assert.equal(polled.data.online, true);
  assert.equal((await request(application, '/get_login_info')).data.data.nickname, '测试机器人');
  const saved = join(directory, 'sessions', '10000.session');
  assert.equal(existsSync(saved), true); assert.equal(readFileSync(saved, 'utf8').includes('test-d2'), false);
  onlineSocket.write(responseFrame(0, 'trpc.msg.olpush.OlPushService.MsgPush', pushed(), { key: d2key }));
  const incoming = await ws.receive(event => event.post_type === 'message');
  assert.equal(incoming.user_id, 10001); assert.match(incoming.raw_message, /中文/);
  onlineSocket.write(responseFrame(0, 'trpc.msg.olpush.OlPushService.MsgPush', pushed(), { key: d2key }));
  await waitFor(() => driver.transport.stats.received >= 6);
  const sent = (await request(application, '/send_private_msg', { user_id: 10001, message: '真实链路形态的合成测试', auto_escape: true })).data;
  assert.equal(sent.status, 'ok'); assert.equal(sends, 1);
  onlineSocket.write(responseFrame(0, 'trpc.msg.olpush.OlPushService.MsgPush', pushed({ sender: 10000, target: 10001, sequence: 77 }), { key: d2key }));
  const self = await ws.receive(event => event.post_type === 'message_sent');
  assert.equal(self.message_id, sent.data.message_id);
  assert.equal((await request(application, '/get_msg', { message_id: incoming.message_id })).data.data.user_id, 10001);
  assert.equal(signed.filter(entry => entry.command === 'MessageSvc.PbSendMsg').length, 1);
  onlineSocket.destroy();
  await waitFor(() => !driver.online);
  await waitFor(() => driver.online);
  assert.equal(registrations, 2); assert.equal(qrRequests, 1);
  await application.close();
  application = await createApp(cfg, { log: () => {} }); driver = application.adapter.driver;
  assert.equal(driver.online, true); assert.equal(registrations, 3); assert.equal(qrRequests, 1);
  assert.equal((await request(application, '/get_msg', { message_id: incoming.message_id })).data.status, 'ok');
  const logout = (await request(application, '/admin/login/logout', {})).data.data;
  assert.deepEqual(logout, { disconnected: true, credentials_removed: true, remote_revocation: false });
  assert.equal(existsSync(saved), false); assert.equal(driver.online, false);
});

test('message decoder preserves mentions, rejects partial media, and requires explicit send ACK identity', () => {
  const message = decodePush(pushed({ groupId: 20000, mention: 10000 }), 10000, uid => uid === 'u_10000' ? 10000 : undefined);
  assert.equal(message.message[0].type, 'at'); assert.equal(message.message[0].data.qq, '10000');
  assert.throws(() => decodePush(pushed({ unsupported: true }), 10000), /unsupported/);
  assert.throws(() => decodeSendAck(encode({ 1: 0 }), 'private'), error => error.uncertain);
  assert.throws(() => decodeSendAck(encode({ 1: 120 }), 'private'), error => !error.uncertain && !error.retryable);
  assert.throws(() => decodeSendAck(Buffer.from('0a7f', 'hex'), 'private'), error => error.uncertain);
  assert.throws(() => decodeSendAck(encode({ 1: -1 }), 'private'), error => error.message.includes('(-1)') && !error.uncertain);
});

test('QQ QR states reflect server waiting, confirmation, expiry, cancellation and unknown codes', () => {
  const codec = new LoginCodec();
  for (const [code, state] of [[48, 'waiting_scan'], [53, 'waiting_confirm'], [17, 'expired'], [54, 'cancelled'], [99, 'failed']]) {
    const result = codec.parseQrPoll(loginReply(codec, cat(Buffer.alloc(54), Buffer.from([code]))));
    assert.equal(result.state, state);
  }
  assert.throws(() => codec.parseQrPoll(loginReply(codec, cat(Buffer.alloc(54), Buffer.from([0])))), /length/);
});

test('contact queries decode paginated UIDs/properties and reject repeated page tokens', async () => {
  let page = 0;
  const transport = { async request(command, body) {
    const request = decode(body), payload = nested(request, 4);
    if (command.endsWith('0xfe5_2')) return encode({ 1: 0xfe5, 2: 2, 4: encode({ 2: [
      { 3: 20000, 4: { 3: 500, 4: 30, 5: '测试群' } }
    ] }) });
    assert.equal(number(payload, 2), 300);
    if (++page === 2) assert.equal(number(nested(payload, 5), 1), 10001);
    return encode({ 1: 0xfd4, 2: 1, 4: encode({ 2: page === 1 ? { 1: 10001 } : undefined, 101: [
      { 1: `uid-${page}`, 3: 10000 + page, 10001: [{ 1: 1, 2: { 2: [{ 1: 20002, 2: '好友昵称' }, { 1: 103, 2: '好友备注' }] } }] }
    ] }) });
  } };
  const friends = await fetchFriends(transport, {});
  assert.equal(friends.size, 2); assert.equal(friends.get(10001).uid, 'uid-1'); assert.equal(friends.get(10002).remark, '好友备注');
  assert.deepEqual(await fetchGroups(transport, {}), [{ group_id: 20000, group_name: '测试群', member_count: 30, max_member_count: 500 }]);
  await assert.rejects(fetchFriends({ request: async () => encode({ 1: 0xfd4, 2: 1, 4: encode({ 2: { 1: 10001 } }) }) }, {}), /pagination/);
});
