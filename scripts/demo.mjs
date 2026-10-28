import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'qq-ai-demo-'));
const config = loadConfig({ ONEBOT_ACCESS_TOKEN: randomBytes(32).toString('hex'),
  ADMIN_ACCESS_TOKEN: randomBytes(32).toString('hex'),
  SESSION_KEY: randomBytes(32).toString('hex'), DATA_DIR: directory, PORT: '0', QQ_DRIVER: 'demo',
  AI_ENABLED: 'true', AI_MODEL: 'DEMO', AI_ALLOWED_USERS: '10001', SEND_INTERVAL_MS: '0', SESSION_INTERVAL_MS: '0' });
let app;
try {
  app = await createApp(config, { ai: { async reply(input) { return `DEMO AI 回复：${input}`; } }, log: () => {} });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${path.startsWith('/admin/') ? config.adminToken : config.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return response.json();
  };
  await request('/admin/demo/inject', { id: 1, user_id: 10001, message: '你好，测试消息' });
  const end = Date.now() + 5000;
  while (!app.store.summary().done && Date.now() < end) await delay(50);
  if (app.store.summary().done !== 1) throw new Error('Demo pipeline did not finish');
  process.stdout.write(`${JSON.stringify({ simulated: true, real_qq: false,
    status: await request('/admin/status'), reply: await request('/get_msg?message_id=1') }, null, 2)}\n`);
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
