import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { DemoDriver } from '../src/qq/demo-driver.mjs';
import { Settings } from '../src/settings.mjs';
import { app, config, temp, request, wsClient, cleanup, waitFor } from './helpers.mjs';

const cookie = 'p_uin=o00123456; skey=fixture-skey; p_skey=fixture-pskey; pt4_token=not-exported';
async function cookieApp(t, env = {}) {
  const bot = await app(t, { QQ_DRIVER:'qzone-fixture', QZONE_ALLOW_COOKIE_EXPORT:'true', ...env }, { driver:new DemoDriver({ account:123456 }) });
  bot.qzone.saveSession({ cookie });
  return bot;
}

test('Qzone cookie export is disabled by default and has an actionable error', async t => {
  const bot = await cookieApp(t, { QZONE_ALLOW_COOKIE_EXPORT:'false' });
  const denied = await request(bot, '/get_cookies', { domain:'user.qzone.qq.com' });
  assert.equal(denied.data.retcode, 1403);
  assert.match(denied.data.message, /允许 AstrBot 获取空间 Cookie/);
  assert.ok(!JSON.stringify(denied).includes('fixture-pskey'));
  assert.throws(() => config('unused', { QZONE_ALLOW_COOKIE_EXPORT:'invalid' }), /true or false/);
});

test('get_cookies returns the fields expected by the installed AstrBot QzoneSession', async t => {
  const bot = await cookieApp(t);
  for (const domain of ['user.qzone.qq.com', 'qzone.qq.com']) {
    const result = await request(bot, '/get_cookies', { domain });
    assert.equal(result.data.status, 'ok');
    assert.equal(result.data.data.cookies, 'uin=o123456; skey=fixture-skey; p_skey=fixture-pskey');
  }
  const publicStatus = (await request(bot, '/admin/qzone/status')).data;
  assert.equal(publicStatus.cookie_export_enabled, true);
  for (const value of [publicStatus, bot.qzone.list(), bot.telemetry.read()]) assert.ok(!JSON.stringify(value).includes('fixture-pskey'));
});

test('cookie export enforces OneBot auth, exact domains, and matching account identity', async t => {
  const bot = await cookieApp(t);
  for (const authorized of [false, 'admin']) {
    assert.equal((await request(bot, '/get_cookies', { domain:'user.qzone.qq.com' }, authorized)).code, 401);
  }
  for (const domain of [undefined, '', 'qq.com', 'qun.qq.com', 'user.qzone.qq.com.evil.test', 'https://user.qzone.qq.com', ['user.qzone.qq.com']]) {
    const result = await request(bot, '/get_cookies', { domain });
    assert.equal(result.data.retcode, 1400); assert.ok(!JSON.stringify(result).includes('fixture-pskey'));
  }
  bot.adapter.driver.account = 999999;
  const mismatch = await request(bot, '/get_cookies', { domain:'user.qzone.qq.com' });
  assert.equal(mismatch.data.retcode, 1400); assert.match(mismatch.data.message, /账号不一致/);
  bot.adapter.driver.account = 123456; bot.qzone.clearSession();
  assert.match((await request(bot, '/get_cookies', { domain:'user.qzone.qq.com' })).data.message, /保存 QQ 空间 Cookie/);
});

test('forward WebSocket get_cookies preserves AstrBot echo and does not expose admin operations', async t => {
  const bot = await cookieApp(t), client = await wsClient(t, bot, '/api');
  client.ws.send(JSON.stringify({ action:'get_cookies', params:{ domain:'user.qzone.qq.com' }, echo:{ seq:43 } }));
  const result = await client.receive(packet => packet.echo?.seq === 43);
  assert.equal(result.status, 'ok'); assert.match(result.data.cookies, /p_skey=fixture-pskey/);
  client.ws.send(JSON.stringify({ action:'admin/qzone/session', params:{ cookie }, echo:44 }));
  assert.equal((await client.receive(packet => packet.echo === 44)).retcode, 1404);
});

test('reverse WebSocket serves AstrBot get_cookies over the authenticated plugin connection', async t => {
  const receiver = new WebSocketServer({ port:0, host:'127.0.0.1' });
  await once(receiver, 'listening');
  cleanup(t, () => { for (const socket of receiver.clients) socket.terminate(); return new Promise(resolve => receiver.close(resolve)); });
  const connected = once(receiver, 'connection');
  const bot = await cookieApp(t, { REVERSE_WS_URLS:`ws://127.0.0.1:${receiver.address().port}` });
  const [socket, headers] = await connected;
  assert.equal(headers.headers.authorization, 'Bearer ' + bot.config.reverseToken);
  const replies = []; socket.on('message', bytes => replies.push(JSON.parse(bytes.toString())));
  socket.send(JSON.stringify({ action:'get_cookies', params:{ domain:'user.qzone.qq.com' }, echo:{ seq:43 } }));
  const result = await waitFor(() => replies.find(packet => packet.echo?.seq === 43));
  assert.equal(result.status, 'ok'); assert.match(result.data.cookies, /uin=o123456/);
});

test('demo mode never exports real credentials and the permission can be managed through settings', async t => {
  const bot = await app(t, { QZONE_ALLOW_COOKIE_EXPORT:'true' });
  assert.equal((await request(bot, '/get_cookies', { domain:'user.qzone.qq.com' })).data.retcode, 1404);
  const settings = new Settings(config(await temp(t)));
  const before = await settings.snapshot();
  assert.equal(before.values.QZONE_ALLOW_COOKIE_EXPORT, 'false');
  const after = await settings.save({ QZONE_ALLOW_COOKIE_EXPORT:'true' }, before.revision);
  assert.equal(after.values.QZONE_ALLOW_COOKIE_EXPORT, 'true');
  assert.ok(after.pending.includes('QZONE_ALLOW_COOKIE_EXPORT'));
});
