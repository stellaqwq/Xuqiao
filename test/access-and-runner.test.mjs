import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import WebSocket from 'ws';
import { initializeEnv } from '../scripts/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { app, config, temp, cleanup, request, waitFor, wsClient, withTestTimeout } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function environment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
function childProcess(args, env = environment()) {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = ''; child.errors = '';
  child.stdout.on('data', chunk => { child.output += chunk; }); child.stderr.on('data', chunk => { child.errors += chunk; });
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  return child;
}
async function execute(args, env) {
  const child = childProcess(args, env);
  try { const code = await withTestTimeout(() => child.done, 5000); return { code, output: child.output, errors: child.errors }; }
  finally { if (child.exitCode === null && !child.signalCode) child.kill(); }
}

test('configuration requires an independent administrator credential', () => {
  assert.throws(() => config('unused', { ADMIN_ACCESS_TOKEN: '' }), /ADMIN_ACCESS_TOKEN/);
  assert.throws(() => config('unused', { ADMIN_ACCESS_TOKEN: 'short' }), /ADMIN_ACCESS_TOKEN/);
  const same = 'a'.repeat(32);
  assert.throws(() => config('unused', { ADMIN_ACCESS_TOKEN: same, ONEBOT_ACCESS_TOKEN: same }), /must differ/);
  assert.throws(() => config('unused', { ADMIN_ACCESS_TOKEN: same, REVERSE_WS_TOKEN: same }), /REVERSE_WS_TOKEN/);
  const cfg = config('unused'); assert.notEqual(cfg.adminToken, cfg.token); assert.equal(cfg.reverseToken, cfg.token);
});

test('OneBot credentials cannot read admin state, change login, resolve jobs or inject messages', async t => {
  const bot = await app(t); let loginCalls = 0;
  t.mock.method(bot.adapter, 'login', async command => { loginCalls++; return { command }; });
  const event = { self_id: 10000, user_id: 10001, post_type: 'message', message_type: 'private', message_id: 900, message: 'synthetic input' };
  const { id } = bot.store.ingest(event, 'synthetic input', 10); bot.store.update(id, 'uncertain', { reply: 'synthetic reply' });
  const cases = [
    ['/admin/status'], ['/admin/jobs'], ['/admin/login/start', {}], ['/admin/login/poll', { handle: 'test' }],
    ['/admin/login/logout', {}], [`/admin/jobs/${id}/resolve`, { outcome: 'sent' }],
    ['/admin/demo/inject', { id: 901, user_id: 10001, message: 'blocked' }]
  ];
  for (const [path, body] of cases) assert.equal((await request(bot, path, body, 'onebot')).code, 401, path);
  assert.equal(loginCalls, 0); assert.equal(bot.store.get(id).status, 'uncertain'); assert.equal(bot.store.list().length, 1);
  assert.equal((await request(bot, '/admin/status')).code, 200);
  assert.equal((await request(bot, '/admin/login/logout', {})).data.data.command, 'logout'); assert.equal(loginCalls, 1);
  assert.equal((await request(bot, `/admin/jobs/${id}/resolve`, { outcome: 'sent' })).data.retcode, 0);
  assert.equal(bot.store.get(id).status, 'done');
  assert.equal((await request(bot, '/get_status', undefined, 'onebot')).code, 200);
  assert.equal((await request(bot, '/get_status', undefined, 'admin')).code, 401);
});

test('admin authorization requires a header while public OneBot query tokens remain supported', async t => {
  const bot = await app(t);
  assert.equal((await request(bot, `/admin/status?access_token=${bot.config.adminToken}`, undefined, false)).code, 401);
  assert.equal((await request(bot, `/admin/status?access_token=${bot.config.adminToken}`, undefined, 'onebot')).code, 401);
  assert.equal((await request(bot, `/get_status?access_token=${bot.config.token}`, undefined, false)).code, 200);
  assert.equal((await request(bot, '/admin/login/logout/', {}, 'onebot')).code, 401);
  assert.equal((await request(bot, '/healthz', undefined, false)).code, 200);
});

test('WebSockets accept only OneBot credentials and cannot invoke administrator actions', async t => {
  const bot = await app(t); let calls = 0;
  t.mock.method(bot.adapter, 'login', async () => { calls++; return {}; });
  const rejected = new WebSocket(`ws://127.0.0.1:${bot.address.port}/`, { headers: { Authorization: `Bearer ${bot.config.adminToken}` } });
  cleanup(t, () => rejected.terminate());
  assert.match((await new Promise(resolve => rejected.once('error', resolve))).message, /401/);
  const client = await wsClient(t, bot);
  client.ws.send(JSON.stringify({ action: 'admin/login/logout', echo: 'blocked-admin' }));
  assert.equal((await client.receive(value => value.echo === 'blocked-admin')).retcode, 1404); assert.equal(calls, 0);
  client.ws.send(JSON.stringify({ action: 'get_status', echo: 'public-status' }));
  assert.equal((await client.receive(value => value.echo === 'public-status')).retcode, 0);
});

test('CLI commands select admin or OneBot credentials without a fallback between them', async t => {
  const bot = await app(t);
  const env = environment({ PORT: String(bot.address.port), ADMIN_ACCESS_TOKEN: bot.config.adminToken, ONEBOT_ACCESS_TOKEN: bot.config.token });
  const adminOnly = { ...env }; delete adminOnly.ONEBOT_ACCESS_TOKEN;
  assert.equal((await execute(['scripts/cli.mjs', 'status'], adminOnly)).code, 0);
  const publicOnly = { ...env }; delete publicOnly.ADMIN_ACCESS_TOKEN;
  assert.equal((await execute(['scripts/cli.mjs', 'friends'], publicOnly)).code, 0);
  assert.equal((await execute(['scripts/cli.mjs', 'status'], { ...env, ADMIN_ACCESS_TOKEN: bot.config.token })).code, 1);
  assert.equal((await execute(['scripts/cli.mjs', 'friends'], { ...env, ONEBOT_ACCESS_TOKEN: bot.config.adminToken })).code, 1);
});

test('the login page uses the admin credential on the server and never embeds it in HTML', async t => {
  const bot = await app(t); let operations = 0;
  t.mock.method(bot.adapter, 'login', async command => { operations++; return { state: 'waiting_scan', handle: 'synthetic', command }; });
  const env = environment({ PORT: String(bot.address.port), ADMIN_ACCESS_TOKEN: bot.config.adminToken }); delete env.ONEBOT_ACCESS_TOKEN;
  const child = childProcess(['scripts/login-page.mjs'], env);
  cleanup(t, async () => { if (child.exitCode === null && !child.signalCode) child.kill(); await child.done; });
  await waitFor(() => child.output.includes('\n'));
  const page = new URL(child.output.trim()), html = await (await fetch(page)).text();
  assert.equal(html.includes(bot.config.adminToken), false); assert.equal(html.includes(bot.config.token), false);
  const response = await fetch(page + '/qr', { method: 'POST', headers: { Origin: page.origin } });
  assert.equal(response.status, 200); assert.equal((await response.json()).command, 'start'); assert.equal(operations, 1);
  assert.equal((await fetch(page + '/qr', { method: 'POST', headers: { Origin: 'http://untrusted.invalid' } })).status, 403);
  assert.equal(operations, 1);
});

test('fresh initialization creates independent secrets and is idempotent', async t => {
  const directory = await temp(t);
  assert.equal(initializeEnv(directory).created, true);
  const content = await readFile(join(directory, '.env'), 'utf8'), env = parseEnv(content);
  assert.match(env.ADMIN_ACCESS_TOKEN, /^[a-f0-9]{64}$/); assert.notEqual(env.ADMIN_ACCESS_TOKEN, env.ONEBOT_ACCESS_TOKEN);
  assert.doesNotThrow(() => loadConfig(env));
  assert.deepEqual(initializeEnv(directory), { created: false, adminUpdated: false });
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), content);
});

test('legacy initialization upgrades only the admin credential and preserves quoted settings and other secrets', async t => {
  for (const oldAdmin of [undefined, '', 'short', 'a'.repeat(32), 'c'.repeat(32)]) {
    const directory = await temp(t), path = join(directory, '.env');
    const content = `# Custom settings\r\nONEBOT_ACCESS_TOKEN=${'a'.repeat(32)}\r\nSESSION_KEY=${'b'.repeat(64)}\r\nREVERSE_WS_TOKEN=${'c'.repeat(32)}\r\nQQ_DRIVER=demo\r\nAI_SYSTEM_PROMPT="first line\nADMIN_ACCESS_TOKEN=inside quoted prompt\nlast line"\r\n` +
      (oldAdmin === undefined ? '' : `ADMIN_ACCESS_TOKEN=${oldAdmin}\r\n`);
    const before = parseEnv(content); await writeFile(path, content);
    assert.equal(initializeEnv(directory).adminUpdated, true);
    const updated = await readFile(path, 'utf8'), after = parseEnv(updated);
    assert.ok(updated.startsWith(content)); assert.notEqual(after.ADMIN_ACCESS_TOKEN, after.ONEBOT_ACCESS_TOKEN);
    assert.notEqual(after.ADMIN_ACCESS_TOKEN, after.REVERSE_WS_TOKEN);
    assert.ok(after.ADMIN_ACCESS_TOKEN.length >= 24);
    for (const [key, value] of Object.entries(before)) if (key !== 'ADMIN_ACCESS_TOKEN') assert.equal(after[key], value, key);
    assert.equal(initializeEnv(directory).adminUpdated, false);
  }
});

test('the test watchdog turns a hung operation into a failure instead of losing the event loop', async () => {
  await assert.rejects(withTestTimeout(() => new Promise(() => {}), 20), /did not complete/);
});

test('strict test results count cancellation as failure and reject skipped or empty runs', async t => {
  const directory = await temp(t), fixture = join(directory, 'fixture.test.mjs'), reportPath = join(directory, 'report.json');
  for (const [kind, source] of [
    ['cancelled', "test('cancelled',{timeout:20},async t=>{const timer=setInterval(()=>{},1000);t.after(()=>clearInterval(timer));await new Promise(()=>{});});"],
    ['skipped', "test.skip('not executed',()=>{});"],
    ['passed', "test('executed',()=>{});"]
  ]) {
    await writeFile(fixture, "import test from 'node:test';\n" + source + '\n');
    const result = await execute(['scripts/test.mjs', '--report', reportPath, fixture]);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(result.code, kind === 'passed' ? 0 : 1, result.errors);
    assert.equal(report.success, kind === 'passed'); assert.equal(report.fail, kind === 'passed' ? 0 : 1);
    if (kind === 'cancelled') { assert.equal(report.cancelled, 1); assert.equal(report.assertionFailures, 0); }
    if (kind === 'skipped') assert.equal(report.skipped, 1);
  }
  const empty = await execute(['scripts/test.mjs', '--report', reportPath, '--test-name-pattern=does-not-exist', fixture]);
  assert.equal(empty.code, 1); assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).success, false);
});

test('the AI body-timeout regression passes alone in a fresh test process', async t => {
  const directory = await temp(t), reportPath = join(directory, 'isolated.json');
  const result = await execute(['scripts/test.mjs', '--report', reportPath, '--test-name-pattern=AI body timeouts', 'test/review-fixes.test.mjs']);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(result.code, 0, result.errors); assert.equal(report.tests, 1); assert.equal(report.pass, 1);
  assert.equal(report.cancelled, 0); assert.equal(report.fail, 0);
});
