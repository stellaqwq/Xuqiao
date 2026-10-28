import { replyBody } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app, config, request, incoming, waitFor } from './helpers.mjs';

async function install(bot, kind = 'script', extra = {}) {
  const row = kind === 'script' ? await bot.plugins.save({ plugin: { name: '测试指令', source: 'export default ({text}) => text==="/ping"?{reply:"pong"}:null',
    scope: { all_private: true, all_groups: true, require_at: true }, ...extra } }) : await bot.plugins.install({ kind });
  const saved = kind === 'script' ? row : await bot.plugins.save({ id: row.id, revision: row.revision, plugin: { ...row, scope: { ...row.scope, all_private: true } } });
  return bot.plugins.toggle({ id: saved.id, revision: saved.revision, enabled: true });
}
const event = (id, input, user = 10002) => ({ post_type: 'message', self_id: 10000, user_id: user, message_id: id, message_type: 'private', message: [{ type: 'text', data: { text: input } }] });

test('chat admin IDs default closed, validate QQ identities and can be saved through settings', async t => {
  assert.equal(config('unused', { BOT_ADMIN_IDS: '' }).adminIds.size, 0);
  assert.deepEqual([...config('unused', { BOT_ADMIN_IDS: '10001,10002,10001' }).adminIds], ['10001', '10002']);
  for (const value of ['admin', '0', '-1', '9007199254740992', '10001 10002']) assert.throws(() => config('unused', { BOT_ADMIN_IDS: value }), /BOT_ADMIN_IDS/);
  const bot = await app(t), first = (await request(bot, '/admin/settings')).data;
  const field = first.fields.find(f => f.key === 'BOT_ADMIN_IDS'); assert.equal(field.type, 'ids'); assert.equal(field.group, 'access');
  assert.match(field.help, /留空禁用/);
  assert.equal((await request(bot, '/admin/settings', { values: { BOT_ADMIN_IDS: 'invalid' }, revision: first.revision })).code, 400);
  const saved = await request(bot, '/admin/settings', { values: { BOT_ADMIN_IDS: '10001,10002' }, revision: first.revision });
  assert.equal(saved.code, 200); assert.equal(saved.data.values.BOT_ADMIN_IDS, '10001,10002'); assert.ok(saved.data.pending.includes('BOT_ADMIN_IDS'));
  assert.deepEqual([...bot.config.adminIds], ['10001'], 'permission applies with the normal settings restart');
});

test('tools help is an exact admin slash command; natural capability questions and function names stay ordinary chat', async t => {
  let aiCalls = 0;
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'fixture', AI_ALLOWED_USERS: '10001' }, { ai: { reply: async () => { aiCalls++; return '普通聊天'; } } });
  await install(bot, 'voicestudio'); await install(bot, 'meme-manager');
  let queries = 0; bot.voicestudio.voices = async () => { queries++; throw Error('No implicit voice queries'); };
  const sent = []; bot.adapter.on('outgoing', v => sent.push(v));
  for (const [i, text] of ['能调用语音吗', '你现在能调用哪些工具', 'voicestudio_list_voices用这个试试', '查一下有哪些音色'].entries()) bot.adapter.driver.inject(incoming(100 + i, { message: text }));
  await waitFor(() => aiCalls === 4 && sent.length === 4);
  assert.ok(sent.every(v => replyBody(v.message)[0].data.text === '普通聊天')); assert.equal(queries, 0);
  bot.adapter.driver.inject(incoming(110, { message: '/tools' })); bot.adapter.driver.inject(incoming(110, { message: '/tools' }));
  await waitFor(() => sent.length === 5);
  assert.match(replyBody(sent.at(-1).message)[0].data.text, /\/vs_voices/); assert.match(replyBody(sent.at(-1).message)[0].data.text, /\/表情 分类/);
  assert.match(replyBody(sent.at(-1).message)[0].data.text, /\/new：/);
  bot.adapter.driver.inject(incoming(111, { message: ' /工具 ' })); await waitFor(() => sent.length === 6);
  assert.match(replyBody(sent.at(-1).message)[0].data.text, /仅管理员/); assert.equal(aiCalls, 4); assert.equal(queries, 0);
});

test('non-admin slash commands cannot execute custom, meme or voice plugins and never fall through to AI', async t => {
  let aiCalls = 0;
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'fixture', AI_ALLOWED_USERS: '10001,10002' }, { ai: { reply: async () => { aiCalls++; return 'AI'; } } });
  const script = await install(bot); await install(bot, 'voicestudio'); await install(bot, 'meme-manager');
  let audioCalls = 0; bot.voicestudio.synthesize = async () => { audioCalls++; throw Error('Must be blocked'); };
  const sent = []; bot.adapter.on('outgoing', v => sent.push(v));
  for (const [i, message] of ['/ping', '/tools', '/vs_say 你好', '/表情 分类', '/unknown'].entries()) bot.adapter.driver.inject(incoming(200 + i, { sender: { user_id: 10002, role: 'owner' }, message }));
  await waitFor(() => bot.store.list().length === 5);
  assert.ok(bot.store.list().every(j => j.status === 'ignored' && j.reason === 'command_forbidden'));
  assert.equal(aiCalls, 0); assert.equal(audioCalls, 0); assert.equal(bot.plugins.get(script.id).runs, 0);
  assert.equal(sent.length, 5); assert.ok(sent.every(v => replyBody(v.message)[0].data.text.includes('仅聊天管理员')));
  bot.adapter.driver.inject(incoming(210, { sender: { user_id: 10002 }, message: '正常聊天' }));
  await waitFor(() => aiCalls === 1); assert.equal(audioCalls, 0);
});

test('empty admin list blocks commands, and unauthorized sessions gain no response outside existing scopes', async t => {
  const bot = await app(t, { BOT_ADMIN_IDS: '' }); await install(bot);
  const sent = []; bot.adapter.on('outgoing', v => sent.push(v));
  bot.adapter.driver.inject(incoming(300, { message: '/ping' })); await waitFor(() => bot.store.list().length === 1);
  assert.equal(bot.store.list()[0].reason, 'command_forbidden'); assert.match(replyBody(sent[0].message)[0].data.text, /仅聊天管理员/);
  bot.adapter.driver.inject(incoming(301, { kind: 'group', groupId: 20001, sender: { user_id: 10002 }, message: '/ping' }));
  await waitFor(() => bot.store.list().length === 2); assert.equal(sent.length, 1, 'unmentioned groups receive no denial spam');
});

test('the worker rejects bypassed and recovered unauthorized commands before generation or delivery', async t => {
  let aiCalls = 0;
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'fixture', AI_ALLOWED_USERS: '10002' }, { ai: { reply: async () => { aiCalls++; return 'AI'; } } });
  let sends = 0; bot.adapter.on('outgoing', () => sends++);
  bot.worker.ingest(event(400, '/vs_say bypass'));
  assert.equal(bot.store.list()[0].reason, 'command_forbidden');
  const pending = bot.store.ingest(event(401, '/vs_say recovered'), '/vs_say recovered', 100);
  bot.store.update(pending.id, 'ready', { reply: 'legacy reply' });
  await waitFor(() => bot.store.get(pending.id).status === 'ignored');
  assert.equal(aiCalls, 0); assert.equal(sends, 0);
  assert.equal(bot.voicestudio.options(event(402, '/vs_say bypass'), {}).tools, undefined);
});

test('revoking an admin while a plugin runs suppresses its command response', async t => {
  const bot = await app(t);
  await install(bot, 'script', { source: 'export default async () => { await new Promise(r=>setTimeout(r,150)); return {reply:"late"}; }' });
  let sends = 0; bot.adapter.on('outgoing', () => sends++);
  bot.adapter.driver.inject(incoming(500, { message: '/ping' })); await waitFor(() => bot.plugins.workers.size === 1);
  bot.config.adminIds.clear(); await waitFor(() => bot.plugins.tasks.size === 0);
  assert.equal(sends, 0); assert.equal(bot.store.list()[0].reason, 'command_forbidden');
});
