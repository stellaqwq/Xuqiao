import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchWorkspace } from '../scripts/launch.mjs';
import { createLoginServer } from '../src/web/login-server.mjs';
import { app, config, temp, cleanup, request } from './helpers.mjs';

async function legacyServer(t) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/admin/status') res.end(JSON.stringify({ online: true, driver: 'kernel', capabilities: ['message.send'] }));
    else { res.statusCode = 404; res.end(JSON.stringify({ status: 'failed', retcode: 1404, message: 'OneBot action is not implemented' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, port: server.address().port, get requests() { return requests; } };
}

test('launcher rejects an authenticated pre-plugin service instead of attaching an incompatible management page', async t => {
  const legacy = await legacyServer(t);
  await assert.rejects(launchWorkspace(config(await temp(t), { PORT: String(legacy.port) })), /旧版本.*Ctrl\+C/);
  assert.equal(legacy.requests, 1);
  assert.equal((await fetch(`http://127.0.0.1:${legacy.port}/admin/status`)).status, 200);
});

test('workspace plugin proxy explains a legacy backend and returns an actionable conflict', async t => {
  const legacy = await legacyServer(t);
  const token = 'fixture-admin-token-with-24-plus-characters';
  const page = await createLoginServer({ backend: `http://127.0.0.1:${legacy.port}`, token });
  cleanup(t, () => page.close());
  const response = await fetch(page.url + '/plugins');
  assert.equal(response.status, 409);
  const value = await response.json();
  assert.match(value.message, /旧版本/); assert.match(value.message, /Ctrl\+C/);
  assert.ok(!JSON.stringify(value).includes(token));
});

test('current backend advertises plugin support and unknown admin paths never fall through to OneBot actions', async t => {
  const bot = await app(t);
  assert.equal((await request(bot, '/admin/status')).data.features.plugins, 1);
  let called = false;
  const action = bot.server.action.bind(bot.server);
  bot.server.action = (...args) => { called = true; return action(...args); };
  for (const payload of [undefined, {}]) {
    const response = await request(bot, '/admin/not-installed', payload);
    assert.equal(response.code, 404); assert.match(response.data.message, /管理员接口不存在/);
  }
  assert.equal(called, false);
  assert.equal((await request(bot, '/admin/plugins')).code, 200);
});
