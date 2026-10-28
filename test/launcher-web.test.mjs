import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { launchWorkspace } from '../scripts/launch.mjs';
import { createLoginServer } from '../src/web/login-server.mjs';
import { createApp } from '../src/app.mjs';
import { app, temp, config, cleanup, request } from './helpers.mjs';

test('launcher owns and closes its backend, releases the data lock, and keeps credentials out of the page', async t => {
  const settings = config(await temp(t));
  const workspace = await launchWorkspace(settings);
  cleanup(t, () => workspace.close());
  assert.equal(workspace.reused, false);
  const response = await fetch(workspace.url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  for (const secret of [settings.token, settings.adminToken, settings.sessionKey]) assert.ok(!html.includes(secret));
  const snapshot = await (await fetch(workspace.url + '/state')).json();
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.simulated, true);
  assert.equal(snapshot.ai_enabled, false);
  assert.ok(!JSON.stringify(snapshot).includes(settings.adminToken));
  await workspace.close();
  await workspace.close();
  await assert.rejects(fetch(workspace.url));
  const restarted = await createApp(settings, { log: () => {} });
  cleanup(t, () => restarted.close());
  assert.equal((await request(restarted, '/healthz')).code, 200);
});

test('launcher reuses an authenticated service and leaves it running when the page closes', async t => {
  const bot = await app(t);
  const workspace = await launchWorkspace({ ...bot.config, port: bot.address.port });
  cleanup(t, () => workspace.close());
  assert.equal(workspace.reused, true);
  assert.equal(workspace.app, undefined);
  await workspace.close();
  assert.equal((await request(bot, '/admin/status')).code, 200);
});

test('launcher refuses a service with another administrator credential', async t => {
  const bot = await app(t);
  await assert.rejects(launchWorkspace({ ...bot.config, port: bot.address.port, adminToken: 'different-admin-token-for-this-test' }), /凭据/);
  assert.equal((await request(bot, '/healthz')).code, 200);
});

test('launcher refuses an unrelated listener instead of replacing it', async t => {
  const server = createServer((req, res) => { res.end('unrelated application'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(launchWorkspace(config(await temp(t), { PORT: String(server.address().port) })), /端口已被占用/);
});

test('workspace observes an existing connection and subsequent disconnect without starting a login', async t => {
  const bot = await app(t);
  let online = true, logins = 0;
  t.mock.method(bot.adapter, 'status', () => ({ online, driver: 'demo', simulated: true }));
  t.mock.method(bot.adapter, 'login', async () => { logins++; });
  const page = await createLoginServer({ backend: `http://127.0.0.1:${bot.address.port}`, token: bot.config.adminToken });
  cleanup(t, () => page.close());
  assert.equal((await (await fetch(page.url + '/state')).json()).online, true);
  online = false;
  assert.equal((await (await fetch(page.url + '/state')).json()).online, false);
  assert.equal(logins, 0);
  assert.equal((await fetch(page.url.replace(/login\/.+/, 'login/wrong'))).status, 404);
  assert.equal((await fetch(page.url + '/qr', { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal(logins, 0);
});

test('concurrent QR requests share one login operation and polling advances the state', async t => {
  const bot = await app(t);
  let starts = 0;
  t.mock.method(bot.adapter, 'status', () => ({ online: false, driver: 'kernel', kernel: { login_state: 'waiting_scan' } }));
  t.mock.method(bot.adapter, 'login', async command => {
    if (command === 'start') { starts++; await delay(60); return { state: 'waiting_scan', handle: 'synthetic', expires_at: Date.now() + 60000 }; }
    return { state: 'waiting_confirm', handle: 'synthetic' };
  });
  const page = await createLoginServer({ backend: `http://127.0.0.1:${bot.address.port}`, token: bot.config.adminToken });
  cleanup(t, () => page.close());
  const results = await Promise.all(Array.from({ length: 4 }, () => fetch(page.url + '/qr', { method: 'POST', headers: { Origin: new URL(page.url).origin } }).then(r => r.json())));
  assert.equal(starts, 1);
  assert.ok(results.every(result => result.handle === 'synthetic'));
  const snapshot = await (await fetch(page.url + '/state')).json();
  assert.equal(snapshot.state, 'waiting_confirm');
  assert.ok(snapshot.expires_at > Date.now());
});
