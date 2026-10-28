import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const [command = 'status', ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.PORT || 5700}`;
let path;
let payload;
switch (command) {
  case 'status': path = '/admin/status'; break;
  case 'jobs': path = '/admin/jobs'; break;
  case 'login': path = '/admin/login/start'; payload = {}; break;
  case 'poll': path = '/admin/login/poll'; payload = { handle: args[0] }; break;
  case 'logout': path = '/admin/login/logout'; payload = {}; break;
  case 'friends': path = '/get_friend_list'; break;
  case 'groups': path = '/get_group_list'; break;
  case 'get': path = '/get_msg'; payload = { message_id: args[0] }; break;
  case 'watch': break;
  case 'send': path = '/send_private_msg'; payload = { user_id: args[0], message: args.slice(1).join(' '), auto_escape: true }; break;
  case 'send-group': path = '/send_group_msg'; payload = { group_id: args[0], message: args.slice(1).join(' '), auto_escape: true }; break;
  case 'inject': path = '/admin/demo/inject'; payload = { id: Number(args[0]), user_id: Number(args[1]), message: args.slice(2).join(' ') }; break;
  case 'resolve': path = `/admin/jobs/${Number(args[0])}/resolve`; payload = { outcome: args[1] }; break;
  default: throw new Error('Commands: status | jobs | login [--wait] | poll HANDLE | logout | friends | groups | get ID | watch [SECONDS] | send USER TEXT | send-group GROUP TEXT | inject ID USER TEXT | resolve JOB sent|discard');
}
const tokenName = path?.startsWith('/admin/') ? 'ADMIN_ACCESS_TOKEN' : 'ONEBOT_ACCESS_TOKEN';
const token = process.env[tokenName];
if (!token) throw new Error(`${tokenName} is missing; run npm run init first`);
async function request(path, payload) {
  const response = await fetch(base + path, { method: payload ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok || result.status === 'failed') process.exitCode = 1;
  return result;
}
try {
  if (command === 'watch') {
    const seconds = Number(args[0] || 60);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/event', { headers: { Authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => ws.close(), seconds * 1000);
    const stop = () => ws.close(); process.once('SIGINT', stop);
    await new Promise((done, reject) => {
      ws.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (['message', 'message_sent'].includes(event.post_type)) process.stdout.write(`${JSON.stringify(event)}\n`);
      });
      ws.once('close', done); ws.once('error', reject);
    }).finally(() => { clearTimeout(timer); process.off('SIGINT', stop); ws.terminate(); });
  } else {
    let result = await request(path, payload);
    if (command === 'login' && result.data?.qrcode) {
      const qr = result.data.qrcode;
      if (!qr.startsWith('data:image/png;base64,')) throw new Error();
      const qrId = /^[a-f0-9-]{36}$/.test(result.data.handle || '') ? result.data.handle : String(Date.now());
      const qrPath = resolve(process.env.DATA_DIR || './data', `qrcode-${qrId}.png`);
      await mkdir(dirname(qrPath), { recursive: true });
      await writeFile(qrPath, Buffer.from(qr.slice('data:image/png;base64,'.length), 'base64'), { mode: 0o600 });
      delete result.data.qrcode; result.data.qrcode_file = qrPath;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command === 'login' && args.includes('--wait') && result.status === 'ok' && result.data?.handle) {
      const end = Date.now() + 180000, handle = result.data.handle;
      let previous = result.data.state;
      while (['waiting_scan', 'waiting_confirm', 'authenticated', 'initializing_session', 'registering'].includes(result.data.state) && Date.now() < end) {
        await delay(2000);
        result = await request('/admin/login/poll', { handle });
        if (result.status !== 'ok' || result.data.state !== previous) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        previous = result.data?.state;
      }
      if (result.data?.state !== 'online') {
        process.stderr.write('Login is incomplete. Inspect the last state; poll again or start a new QR login.\n'); process.exitCode = 1;
      }
    }
  }
} catch { process.stderr.write('Request failed. Confirm the bot is running and PORT/token match.\n'); process.exitCode = 1; }
