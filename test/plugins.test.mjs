import { replyBody } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { pluginTemplate } from '../src/plugins/service.mjs';
import { launchWorkspace } from '../scripts/launch.mjs';
import { app, config, temp, cleanup, request, incoming, waitFor } from './helpers.mjs';

const definition = (extra = {}) => ({ ...structuredClone(pluginTemplate), scope: { ...pluginTemplate.scope, private_users: ['10001'] }, ...extra });
async function install(bot, extra = {}) {
  const row = await bot.plugins.save({ plugin: definition(extra) });
  return bot.plugins.toggle({ id: row.id, revision: row.revision, enabled: true });
}
const event = (id, text = '/ping', extra = {}) => ({ post_type: 'message', self_id: 10000, user_id: 10001,
  message_id: id, message_type: 'private', message: [{ type: 'text', data: { text } }], ...extra });

test('plugin admin APIs isolate credentials and enforce validation, revisions, default disable and deletion', async t => {
  const bot = await app(t);
  assert.equal((await request(bot, '/admin/plugins', undefined, 'onebot')).code, 401);
  assert.equal((await request(bot, '/admin/plugins', undefined, false)).code, 401);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition() }, 'onebot')).code, 401);
  const created = await request(bot, '/admin/plugins/save', { plugin: definition() });
  assert.equal(created.code, 200); assert.equal(created.data.enabled, false);
  const { id, revision } = created.data;
  assert.equal((await request(bot, '/admin/plugins/detail?id=' + id)).data.source, definition().source);
  const list = (await request(bot, '/admin/plugins')).data;
  assert.equal(list.plugins.length, 1); assert.equal(list.plugins[0].source, undefined); assert.equal(list.plugins[0].config, undefined);
  assert.equal((await request(bot, '/admin/plugins/toggle', { id, revision, enabled: true })).code, 200);
  assert.equal((await request(bot, '/admin/plugins/save', { id, revision, plugin: definition() })).code, 409);
  assert.equal((await request(bot, '/admin/plugins/delete', { id, revision })).code, 409);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition({ source: 'export default (' }) })).code, 400);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition({ source: 'export default 1' }) })).code, 400);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition({ priority: 101 }) })).code, 400);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition({ scope: { private_users: ['../x'] } }) })).code, 400);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition({ config: [] }) })).code, 400);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition({ timeout_ms: 1 }) })).code, 400);
  assert.equal((await request(bot, '/admin/plugins/save', { plugin: definition({ source: ' '.repeat(49153) }) })).code, 400);
  assert.equal((await request(bot, '/admin/plugins/no-such-operation', {})).code, 404);
  const row = bot.plugins.get(id);
  assert.equal((await request(bot, '/admin/plugins/delete', { id, revision: row.revision })).code, 200);
  assert.equal((await request(bot, '/admin/plugins/detail?id=' + id)).code, 404);
});

test('plugins cannot be enabled with an empty scope and simulation previews drafts without QQ sends', async t => {
  const bot = await app(t); let sends = 0;
  bot.adapter.on('outgoing', () => sends++);
  const saved = await bot.plugins.save({ plugin: pluginTemplate });
  await assert.rejects(bot.plugins.toggle({ id: saved.id, revision: saved.revision, enabled: true }), /好友或群聊/);
  const preview = await bot.plugins.test({ plugin: pluginTemplate, text: '/ping' });
  assert.equal(preview.simulated, true); assert.equal(preview.scope_matches, false);
  assert.equal(preview.reply, pluginTemplate.config.response); assert.equal(preview.handled, true);
  assert.equal(sends, 0); assert.equal(bot.plugins.get(saved.id).runs, 0);
  assert.equal((await bot.plugins.test({ plugin: definition(), text: 'unmatched' })).handled, false);
});

test('matching commands reply once before AI, preserve plain text and deduplicate events', async t => {
  let aiCalls = 0;
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'test', AI_ALLOWED_USERS: '10001' },
    { ai: { reply: async () => { aiCalls++; return 'AI fallback'; } } });
  const sent = []; bot.adapter.on('outgoing', e => sent.push(e));
  await install(bot, { config: { command: '/ping', response: '[CQ:at,qq=all] literal' } });
  bot.adapter.driver.inject(incoming(101, { message: '/ping' }));
  bot.adapter.driver.inject(incoming(101, { message: '/ping' }));
  await waitFor(() => bot.store.list().find(j => j.reason === 'plugin_handled'));
  assert.equal(sent.length, 1); assert.equal(aiCalls, 0);
  assert.equal(replyBody(sent[0].message)[0].type, 'text'); assert.equal(replyBody(sent[0].message)[0].data.text, '[CQ:at,qq=all] literal');
  bot.adapter.driver.inject(incoming(102, { message: '/other' }));
  await waitFor(() => bot.store.list().find(j => j.status === 'done'));
  assert.equal(aiCalls, 1); assert.equal(sent.length, 2);
  assert.equal(JSON.parse(bot.store.get(bot.store.list().find(j => j.reason === 'plugin_handled').id).event).content_retained, false);
});

test('plugin priority stops later handlers and scopes filter users, groups, mentions and self messages', async t => {
  const bot = await app(t), sent = []; bot.adapter.on('outgoing', e => sent.push(e));
  await install(bot, { priority: -1, config: { command: '/ping', response: 'low' } });
  await install(bot, { priority: 1, config: { command: '/ping', response: 'high' } });
  bot.adapter.driver.inject(incoming(201, { message: '/ping' }));
  await waitFor(() => bot.plugins.tasks.size === 0);
  assert.equal(replyBody(sent[0].message)[0].data.text, 'high'); assert.equal(sent.length, 1);
  assert.equal(bot.plugins.enqueue(event(202, '/ping', { user_id: 10002 }), () => {}), null);
  assert.equal(bot.plugins.enqueue(event(203, '/ping', { user_id: 10000 }), () => {}), null);
  await install(bot, { scope: { ...pluginTemplate.scope, groups: ['20001'] }, priority: 2 });
  const group = { message_type: 'group', group_id: 20001 };
  assert.equal(bot.plugins.enqueue(event(204, '/ping', group), () => {}), null);
  const mentioned = event(205, '/ping', { ...group, message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '/ping' } }] });
  let handled;
  bot.plugins.enqueue(mentioned, value => { handled = value; });
  await waitFor(() => handled !== undefined); assert.equal(handled, true); assert.equal(sent.length, 2);
  assert.equal(bot.plugins.enqueue(mentioned, () => {} ).inserted, false);
});

test('exceptions, invalid outputs and infinite loops are bounded and do not leak code or config to logs', async t => {
  const bot = await app(t);
  for (const source of ["export default () => { throw Error('fixture-private-message') }", 'export default () => 42', 'export default () => ({reply:"x".repeat(2001)})']) {
    await assert.rejects(bot.plugins.test({ plugin: definition({ source }) }));
  }
  const before = Date.now();
  await assert.rejects(bot.plugins.test({ plugin: definition({ source: 'export default () => { while(true){} }', timeout_ms: 150 }) }), /超时/);
  assert.ok(Date.now() - before < 3000);
  await assert.rejects(bot.plugins.save({ plugin: definition({ source: 'while(true){}; export default () => null', timeout_ms: 150 }) }), /超时/);
  const row = await install(bot, { source: "export default () => { throw Error('fixture-private-message') }" });
  bot.adapter.driver.inject(incoming(301, { message: '/ping' }));
  await waitFor(() => bot.plugins.get(row.id).failures === 1);
  await waitFor(() => bot.store.list().length === 1);
  assert.equal(bot.store.list()[0].reason, 'ai_disabled');
  const logs = JSON.stringify(bot.telemetry.read().entries.filter(e => e.kind === 'log'));
  assert.ok(!logs.includes('fixture-private-message')); assert.ok(!logs.includes(pluginTemplate.config.response));
});

test('disabling an in-flight plugin prevents its reply and releases the original message', async t => {
  const bot = await app(t); let sent = 0; bot.adapter.on('outgoing', () => sent++);
  const row = await install(bot, { source: 'export default async () => { await new Promise(r=>setTimeout(r,1000)); return {reply:"late"}; }' });
  bot.adapter.driver.inject(incoming(401, { message: '/ping' }));
  await waitFor(() => bot.plugins.workers.size === 1);
  await bot.plugins.toggle({ id: row.id, revision: row.revision, enabled: false });
  await waitFor(() => bot.store.list().length === 1);
  assert.equal(sent, 0); assert.equal(bot.store.list()[0].reason, 'ai_disabled');
});

test('send uncertainty is visible, never retried and never falls through to an AI duplicate', async t => {
  const bot = await app(t); let sends = 0;
  const row = await install(bot);
  const original = bot.adapter.action.bind(bot.adapter);
  bot.adapter.action = (action, ...args) => {
    if (action.startsWith('send_')) { sends++; throw Object.assign(new Error(), { uncertain: true, code: 1502 }); }
    return original(action, ...args);
  };
  bot.adapter.driver.inject(incoming(501, { message: '/ping' }));
  await waitFor(() => bot.store.list().find(j => j.reason === 'plugin_handled'));
  bot.adapter.driver.inject(incoming(501, { message: '/ping' }));
  assert.equal(sends, 1); assert.match(bot.plugins.get(row.id).last_error, /结果未知/);
});

test('saved plugins and event receipts survive a restart and enabled edits take effect', async t => {
  const c = config(await temp(t)); let bot = await createApp(c, { log: () => {} });
  cleanup(t, () => bot.close());
  const row = await install(bot);
  bot.adapter.driver.inject(incoming(601, { message: '/ping' }));
  await waitFor(() => bot.plugins.tasks.size === 0);
  await bot.close(); bot = await createApp(c, { log: () => {} });
  assert.equal(bot.plugins.get(row.id).enabled, true);
  let sends = 0; bot.adapter.on('outgoing', () => sends++);
  bot.adapter.driver.inject(incoming(601, { message: '/ping' })); assert.equal(sends, 0);
  const updated = await bot.plugins.save({ id: row.id, revision: row.revision, plugin: definition({ config: { command: '/ping', response: 'updated' } }) });
  assert.equal(updated.enabled, true); assert.equal(updated.revision, row.revision + 1);
  bot.adapter.driver.inject(incoming(602, { message: '/ping' }));
  await waitFor(() => sends === 1);
});

test('workspace proxies plugin operations with origin checks and never embeds admin tokens', async t => {
  const workspace = await launchWorkspace(config(await temp(t))); cleanup(t, () => workspace.close());
  const origin = new URL(workspace.url).origin;
  const post = (route, data, from = origin) => fetch(workspace.url + route, { method: 'POST',
    headers: { Origin: from, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post('/plugins/save', { plugin: definition() }, 'https://example.com')).status, 403);
  const response = await post('/plugins/save', { plugin: definition() }); assert.equal(response.status, 200);
  const row = await response.json();
  assert.equal((await fetch(workspace.url + '/plugins/detail?id=' + row.id)).status, 200);
  assert.equal((await fetch(workspace.url + '/plugins/detail?id=../file')).status, 400);
  const html = await (await fetch(workspace.url)).text();
  assert.ok(html.includes('view-plugins')); assert.ok(!html.includes(workspace.app.config.adminToken));
  assert.equal((await post('/plugins/test', { plugin: definition() })).status, 200);
});

test('an interrupted claim still suppresses replay after its plugin is disabled', async t => {
  const c = config(await temp(t)); let bot = await createApp(c, { log: () => {} });
  cleanup(t, () => bot.close());
  const row = await install(bot, { source: 'export default async () => { await new Promise(r=>setTimeout(r,1000)); return {reply:"late"}; }' });
  bot.adapter.driver.inject(incoming(701, { message: '/ping' }));
  await waitFor(() => bot.plugins.workers.size === 1);
  await bot.close(); bot = await createApp(c, { log: () => {} });
  await bot.plugins.toggle({ id: row.id, revision: row.revision, enabled: false });
  assert.equal(bot.store.list().length, 0);
  bot.adapter.driver.inject(incoming(701, { message: '/ping' }));
  assert.equal(bot.store.list().length, 0);
});
