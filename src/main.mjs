import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createLogger } from './logger.mjs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const log = createLogger();
let config;
try { config = loadConfig(); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
try {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  const app = await createApp(config, { log, settingsPath:existsSync(envPath) ? envPath : undefined });
  log('info', 'onebot_listening', { port: app.address.port, driver: app.adapter.driver.mode });
  if (app.adapter.driver.mode === 'scaffold') log('warn', 'qq_protocol_not_implemented');
  if (app.adapter.driver.mode === 'demo') log('warn', 'simulated_account_no_real_qq');
  if (app.adapter.driver.diagnostics) log('warn', 'experimental_qq_requires_account_validation');
  const stop = async () => {
    try { await app.close(); process.exitCode = 0; }
    catch { log('error', 'shutdown_failed'); process.exitCode = 1; }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  log('error', 'startup_failed', { code: error.code, reason: error.reason });
  process.exitCode = 1;
}
