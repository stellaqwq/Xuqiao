import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.mjs';
import { PROJECT_NAME } from '../src/brand.mjs';
import { createLogger } from '../src/logger.mjs';
import { loadConfig } from '../src/config.mjs';
import { createLoginServer } from '../src/web/login-server.mjs';
import { initializeEnv } from './init.mjs';
import { Telemetry } from '../src/telemetry.mjs';
import { prepareKernel } from '../src/qq/kernel/prepare.mjs';

function localEndpoint(config, port = config.port) {
  const host = config.host === '::' ? '[::1]' : ['0.0.0.0', 'localhost'].includes(config.host) ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
export async function launchWorkspace(config, { log = () => {}, settingsPath, lockedKeys = [], prepareRuntime = false, notify = () => {} } = {}) {
  let app, web, closing;
  const telemetry = new Telemetry();
  let restarting;
  let reused = false, backend = localEndpoint(config);
  if (config.port) {
    let response;
    try {
      response = await fetch(`${backend}/admin/status`, { headers: { Authorization: `Bearer ${config.adminToken}` }, signal: AbortSignal.timeout(2000) });
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw new Error('无法检查现有服务，请检查 HOST、PORT 和服务状态。', { cause: error });
    }
    if (response) {
      const status = await response.json().catch(() => null);
      if (!response.ok || typeof status?.online !== 'boolean' || typeof status?.driver !== 'string' || !status?.capabilities) {
        throw new Error('端口已被占用，或现有服务的管理员凭据与 .env 不一致；请检查后重试。');
      }
      if (status.features?.plugins !== 1) {
        throw new Error('检测到旧版本机器人服务，尚未加载插件管理接口。请先在原启动窗口按 Ctrl+C 退出机器人，再重新运行 start.cmd；只关闭网页或再次打开工作台不会更新旧服务。');
      }
      if (status.features?.memes !== 1) throw new Error('检测到旧版本机器人服务，尚未加载表情图库接口。请先在原启动窗口按 Ctrl+C 完全退出机器人，再重新运行 start.cmd。');
      if (status.features?.voicestudio !== 1) throw new Error('检测到旧版本机器人服务，尚未加载 VoiceStudio 插件。请先在原启动窗口按 Ctrl+C 完全退出机器人，再重新运行 start.cmd。');
      if (status.features?.agent !== 1) throw new Error('检测到旧版本机器人服务，尚未加载 Agent 核心。请先在原启动窗口按 Ctrl+C 完全退出机器人，再重新运行 start.cmd。');
      reused = true;
    }
  }
  try {
    if (!reused) {
      if(prepareRuntime)await prepareKernel(config,{notify});
      app = await createApp(config, { log, settingsPath, lockedKeys, telemetry }); backend = localEndpoint(config, app.address.port);
    }
    async function restart() {
      if (reused) throw new Error('此工作台复用了其他进程的服务。配置已保存，请在原服务窗口重新启动。');
      if (closing) throw new Error('服务正在退出。');
      if (restarting) return restarting;
      restarting = (async () => {
        const saved = await app.settings.environment(), next = loadConfig(saved), previous = config;
        if(prepareRuntime)await prepareKernel(next,{notify});
        await app.close();
        try { app = await createApp(next, { log, settingsPath, lockedKeys, telemetry }); config = next; }
        catch (error) {
          telemetry.add('log', { level:'error', event:'restart_failed', fields:{} });
          try {
            app = await createApp(previous, { log, settingsPath, lockedKeys, telemetry });
            if (!settingsPath) app.settings.memory = saved;
            backend = localEndpoint(previous, app.address.port);
          }
          catch { throw new Error('新配置启动失败，旧服务也无法恢复。请在启动窗口检查错误并重新启动。'); }
          throw new Error('新配置启动失败，已恢复原服务。请检查运行目录、端口与驱动设置。');
        }
        backend = localEndpoint(config, app.address.port);
        return { restarted:true };
      })().finally(() => { restarting = null; });
      return restarting;
    }
    web = await createLoginServer({ backend, token:config.adminToken,
      connection:() => ({ backend, token:config.adminToken }), restart:reused ? undefined : restart });
    return { get app() { return app; }, web, reused, url: web.url, restart, close() {
      if (!closing) closing = (async () => { try { await web.close(); } finally { await restarting?.catch(() => {}); await app?.close(); } })();
      return closing;
    } };
  } catch (error) { await app?.close(); throw error; }
}

function openBrowser(url) {
  const windows = process.platform === 'win32';
  const child = windows ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -FilePath $env:QQ_BOT_PAGE_URL'], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, QQ_BOT_PAGE_URL: url }
  }) : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.once('error', () => console.log('浏览器未能打开，请手动打开上方工作台地址。'));
  child.once('exit', code => { if (code) console.log('浏览器未能打开，请手动打开上方工作台地址。'); });
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  process.chdir(root);
  const args = process.argv.slice(2);
  if (args.some(arg => !['--demo', '--no-open'].includes(arg))) throw new Error('可用参数：--demo（独立演示）、--no-open（不打开浏览器）');
  let directory, workspace, stopping = false;
  async function stop() {
    stopping = true;
    await workspace?.close();
  }
  const onSignal = () => { stop().catch(() => { process.exitCode = 1; }); };
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, onSignal);
  try {
    let env;
    if (args.includes('--demo')) {
      directory = await mkdtemp(join(tmpdir(), 'qq-ai-workspace-demo-'));
      env = { DATA_DIR: directory, PORT: '0', QQ_DRIVER: 'demo', QQ_ACCOUNT: '10000', AI_ENABLED: 'false',
        ONEBOT_ACCESS_TOKEN: randomBytes(32).toString('hex'), ADMIN_ACCESS_TOKEN: randomBytes(32).toString('hex'), SESSION_KEY: randomBytes(32).toString('hex') };
    } else {
      initializeEnv(root);
      env = { ...parseEnv(await readFile(join(root, '.env'), 'utf8')), ...process.env };
    }
    if (stopping) return;
    workspace = await launchWorkspace(loadConfig(env), { log:createLogger(),
      prepareRuntime:!args.includes('--demo'), notify:line=>console.log(line),
      settingsPath:args.includes('--demo') ? undefined : join(root, '.env'),
      lockedKeys:args.includes('--demo') ? [] : Object.keys(process.env) });
    if (stopping) { await workspace.close(); return; }
    console.log(args.includes('--demo') ? '\n'+PROJECT_NAME+' · 独立演示（不会登录真实 QQ）' : '\n'+PROJECT_NAME+' 工作台已启动');
    console.log(workspace.reused ? '已复用现有服务；退出此窗口仅关闭工作台。' : '此窗口管理机器人服务；按 Ctrl+C 安全退出。');
    console.log(`\n${workspace.url}\n`);
    if (!args.includes('--no-open')) openBrowser(workspace.url);
    await new Promise(resolve => {
      // close() is idempotent. Observe the server close event, including signals.
      workspace.web.server.once('close', resolve);
      if (!workspace.web.server.listening) resolve();
    });
    await workspace.close();
  } finally {
    await workspace?.close();
    for (const name of ['SIGINT', 'SIGTERM']) process.removeListener(name, onSignal);
    // directory is only assigned the exact fresh mkdtemp result above.
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
}
