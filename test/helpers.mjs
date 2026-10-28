import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';

const disposers = Symbol('test disposers');
export function cleanup(t, fn) {
  if (!t[disposers]) {
    t[disposers] = [];
    t.after(async () => {
      for (const dispose of t[disposers].reverse()) await dispose();
    });
  }
  t[disposers].push(fn);
}
export async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'qq-bot-test-'));
  cleanup(t, () => rm(path, { recursive: true, force: true }));
  return path;
}
export function config(dataDir, env = {}) {
  return loadConfig({ ONEBOT_ACCESS_TOKEN: randomBytes(32).toString('hex'), SESSION_KEY: randomBytes(32).toString('hex'),
    ADMIN_ACCESS_TOKEN: randomBytes(32).toString('hex'), BOT_ADMIN_IDS: '10001',
    DATA_DIR: dataDir, PORT: '0', QQ_DRIVER: 'demo', SEND_INTERVAL_MS: '0', SESSION_INTERVAL_MS: '0', ...env });
}
export async function app(t, env = {}, overrides = {}) {
  const directory = await temp(t);
  const application = await createApp(config(directory, env), { log: () => {}, ...overrides });
  cleanup(t, () => application.close());
  return application;
}
export async function request(app, path, payload, authorized = true) {
  const token = authorized === 'onebot' ? app.config.token : authorized === 'admin' ? app.config.adminToken :
    path.startsWith('/admin/') ? app.config.adminToken : app.config.token;
  const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(5000)
  });
  return { code: response.status, data: await response.json() };
}
export async function withTestTimeout(operation, milliseconds = 1000) {
  let timer;
  const expired = new Promise((_, reject) => {
    // This timer intentionally holds the event loop: AbortSignal.timeout()
    // alone cannot keep an isolated synthetic-stream test alive.
    timer = setTimeout(() => reject(new Error('Test operation did not complete before its deadline')), milliseconds);
  });
  try { return await Promise.race([expired, Promise.resolve().then(operation)]); }
  finally { clearTimeout(timer); }
}
export async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(20); }
  throw new Error('Condition did not become true before timeout');
}
export async function wsClient(t, app, path = '/') {
  const ws = new WebSocket(`ws://127.0.0.1:${app.address.port}${path}`, { headers: { Authorization: `Bearer ${app.config.token}` } });
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  ws.on('error', () => {});
  cleanup(t, () => ws.terminate());
  await once(ws, 'open');
  return { ws, messages, receive: predicate => waitFor(() => messages.find(predicate)) };
}
export const incoming = (id = 1, extra = {}) => ({ id, kind: 'private', sender: { user_id: 10001 }, message: '你好', ...extra });
export function replyBody(message) {
  const body=message.filter(segment=>!['reply','at'].includes(segment.type));
  if(message.some(segment=>segment.type==='at')&&body[0]?.type==='text'&&body[0].data.text===' ')body.shift();
  return body;
}
