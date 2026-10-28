import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { app, request, waitFor, wsClient, incoming, cleanup } from './helpers.mjs';
import { createApp } from '../src/app.mjs';
import { BotError } from '../src/errors.mjs';
import { AIClient } from '../src/ai.mjs';

test('default scaffold reports offline and cannot fabricate login or message delivery', async t => {
  const bot = await app(t, { QQ_DRIVER: 'scaffold' });
  assert.equal((await request(bot, '/get_status')).data.data.online, false);
  assert.equal((await request(bot, '/readyz', undefined, false)).code, 503);
  assert.equal((await request(bot, '/admin/login/start', {})).data.retcode, 1501);
  assert.equal((await request(bot, '/send_private_msg', { user_id: 10001, message: 'test' })).data.retcode, 1501);
  assert.equal((await request(bot, '/admin/demo/inject', { id: 1, user_id: 10001, message: 'test' })).code, 404);
});

test('HTTP API enforces token auth and supports JSON, query and form parameters', async t => {
  const bot = await app(t);
  assert.equal((await request(bot, '/get_login_info', undefined, false)).code, 401);
  assert.equal((await request(bot, '/get_version_info')).data.data.protocol_version, 'v11');
  assert.equal((await request(bot, '/send_private_msg?user_id=10001&message=hi')).data.retcode, 0);
  assert.equal((await request(bot, '/send_private_msg', { user_id: 'oops', message: 'hi' })).code, 400);
  assert.equal((await request(bot, '/not_implemented')).code, 404);
  const response = await fetch(`http://127.0.0.1:${bot.address.port}/send_group_msg/?access_token=${bot.config.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'group_id=20000&message=%5BCQ%3Aat%2Cqq%3D10001%5Dhi' });
  assert.equal(response.status, 200);
  const sent = await response.json();
  const message = (await request(bot, `/get_msg?message_id=${sent.data.message_id}`)).data.data;
  assert.equal(message.message[0].type, 'at');
});

test('JSON text resembling a segment array stays text, and non-object request bodies fail', async t => {
  const bot = await app(t);
  const text = '[{"type":"at","data":{"qq":"all"}}]';
  const sent = await request(bot, '/send_private_msg', { user_id: 10001, message: text });
  const result = (await request(bot, `/get_msg?message_id=${sent.data.data.message_id}`)).data.data;
  assert.equal(result.message[0].type, 'text'); assert.equal(result.message[0].data.text, text);
  assert.equal((await request(bot, '/get_status', [])).code, 400);
});

test('forward universal WS preserves arbitrary echo values and forwards deduplicated events', async t => {
  const bot = await app(t);
  const client = await wsClient(t, bot);
  await client.receive(m => m.meta_event_type === 'lifecycle');
  for (const echo of [null, false, 0, { nested: [1, 'x'] }]) {
    const count = client.messages.length;
    client.ws.send(JSON.stringify({ action: 'get_status', echo }));
    await waitFor(() => client.messages.length > count);
    assert.deepEqual(client.messages.at(-1).echo, echo);
  }
  client.ws.send('bad json');
  await client.receive(m => m.retcode === 1400);
  bot.adapter.driver.inject(incoming(10)); bot.adapter.driver.inject(incoming(10));
  await client.receive(m => m.message_id === 10);
  assert.equal(client.messages.filter(m => m.message_id === 10).length, 1);
});

test('separate WS api and event endpoints keep their roles', async t => {
  const bot = await app(t);
  const api = await wsClient(t, bot, '/api/'); const events = await wsClient(t, bot, '/event/');
  bot.adapter.driver.inject(incoming(20));
  await events.receive(m => m.message_id === 20);
  api.ws.send(JSON.stringify({ action: 'get_status', echo: 42 }));
  await api.receive(m => m.echo === 42);
  assert.equal(api.messages.some(m => m.post_type), false);
  const unauth = new WebSocket(`ws://127.0.0.1:${bot.address.port}/`);
  const error = await new Promise(resolve => unauth.once('error', resolve));
  assert.match(error.message, /401/);
});

test('AI pipeline deduplicates, stores context, filters users and never parses generated CQ', async t => {
  let calls = 0; const histories = [];
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'test', AI_ALLOWED_USERS: '10001' }, {
    ai: { async reply(input, history) { calls++; histories.push(history); return `[CQ:at,qq=all] 回复 ${input}`; } }
  });
  bot.adapter.driver.inject(incoming(30)); bot.adapter.driver.inject(incoming(30));
  bot.adapter.driver.inject(incoming(31, { sender: { user_id: 99999 } }));
  await waitFor(() => bot.store.summary().done === 1);
  bot.adapter.driver.inject(incoming(32, { message: '第二条' }));
  await waitFor(() => bot.store.summary().done === 2);
  assert.equal(calls, 2); assert.equal(histories[1].length, 2);
  const message = (await request(bot, '/get_msg?message_id=1')).data.data.message;
  assert.equal(message.length, 2); assert.deepEqual(message[0], { type:'reply', data:{id:'30'} });
  assert.equal(message[1].type, 'text'); assert.match(message[1].data.text, /\[CQ:at,qq=all\]/);
  assert.equal(bot.store.summary().ignored, 1);
});

test('generation retries are bounded; delivery timeouts enter uncertain once', async t => {
  let calls = 0;
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'test', AI_ALLOWED_USERS: '10001', QQ_RPC_TIMEOUT_MS: '25' }, {
    ai: { async reply() { if (++calls === 1) throw new BotError('Transient model failure', 1500, { retryable: true }); return 'answer'; } }
  });
  const original = bot.adapter.driver.invoke.bind(bot.adapter.driver);
  let sends = 0;
  bot.adapter.driver.invoke = async (command, params) => {
    if (command === 'message.send') { sends++; return new Promise(() => {}); }
    return original(command, params);
  };
  bot.adapter.driver.inject(incoming(40));
  await waitFor(() => bot.store.summary().uncertain === 1);
  assert.equal(calls, 2); assert.equal(sends, 1);
  const job = bot.store.list()[0];
  assert.equal((await request(bot, `/admin/jobs/${job.id}/resolve`, { outcome: 'resend' })).code, 400);
  assert.equal((await request(bot, `/admin/jobs/${job.id}/resolve`, { outcome: 'sent' })).data.retcode, 0);
  assert.equal(bot.store.summary().done, 1);
});

test('one runtime per DATA_DIR prevents duplicate workers', async t => {
  const bot = await app(t);
  await assert.rejects(createApp(bot.config, { log: () => {} }), /Another QQ bot/);
  assert.equal((await request(bot, '/get_status')).data.retcode, 0);
});

test('reverse Universal WS sends account/auth headers, responds to actions and reconnects', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(receiver, 'listening');
  const connections = []; const messages = [];
  receiver.on('connection', (ws, req) => {
    connections.push({ ws, req }); ws.on('message', data => messages.push(JSON.parse(data.toString())));
    ws.on('error', () => {});
  });
  cleanup(t, () => { for (const ws of receiver.clients) ws.terminate(); return new Promise(resolve => receiver.close(resolve)); });
  const bot = await app(t, { REVERSE_WS_URLS: `ws://127.0.0.1:${receiver.address().port}/onebot/v11/ws`, REVERSE_WS_TOKEN: 'reverse-test-secret' });
  await waitFor(() => connections.length === 1);
  assert.equal(connections[0].req.headers['x-client-role'], 'Universal');
  assert.equal(connections[0].req.headers['x-self-id'], '10000');
  assert.equal(connections[0].req.headers.authorization, 'Bearer reverse-test-secret');
  connections[0].ws.send(JSON.stringify({ action: 'get_status', echo: 'reverse' }));
  await waitFor(() => messages.find(m => m.echo === 'reverse'));
  connections[0].ws.close();
  await waitFor(() => connections.length === 2);
  bot.adapter.driver.inject(incoming(50));
  await waitFor(() => messages.find(m => m.message_id === 50));
});

test('webhook uses the v11 HMAC signature and supports reply quick operations', async t => {
  let verified = false;
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks); const event = JSON.parse(raw);
    if (event.post_type !== 'message') { res.writeHead(204); res.end(); return; }
    assert.equal(req.headers['x-signature'], `sha1=${createHmac('sha1', 'test-secret').update(raw).digest('hex')}`);
    verified = true; res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: 'hello [CQ:at,qq=all]', auto_escape: true }));
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  cleanup(t, () => new Promise(resolve => { receiver.closeAllConnections(); receiver.close(resolve); }));
  const bot = await app(t, { WEBHOOK_URL: `http://127.0.0.1:${receiver.address().port}/`, WEBHOOK_SECRET: 'test-secret' });
  bot.adapter.driver.inject(incoming(60));
  await waitFor(() => bot.adapter.driver.messages.size === 1);
  assert.equal(verified, true);
  assert.deepEqual(bot.adapter.driver.messages.get(1).message, [{ type: 'text', data: { text: 'hello [CQ:at,qq=all]' } }]);
});

test('AI client calls compatible chat endpoint, handles UTF-8, and classifies provider errors', async t => {
  let fail = false; let seen;
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    if (fail) { res.writeHead(503); res.end('unavailable'); return; }
    res.setHeader('Content-Type', 'application/json');
    const result = Buffer.from(JSON.stringify({ choices: [{ message: { content: '你好 😀' } }] }));
    for (const byte of result) res.write(Buffer.from([byte])); res.end();
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  cleanup(t, () => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const client = new AIClient({ baseUrl: `http://127.0.0.1:${provider.address().port}/v1/`, apiKey: 'key',
    model: 'test', systemPrompt: 'system', timeout: 1000, maxReplyChars: 100 });
  assert.equal(await client.reply('question', [], new AbortController().signal), '你好 😀');
  assert.equal(seen.url, '/v1/chat/completions'); assert.equal(seen.authorization, 'Bearer key');
  assert.deepEqual(seen.body.messages.at(-1), { role: 'user', content: 'question' });
  fail = true;
  await assert.rejects(client.reply('question', [], new AbortController().signal), e => e.retryable === true);
});
