import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';
import { KernelDriver, verifyKernel } from '../src/qq/kernel-driver.mjs';
import { MessageIdMap } from '../src/qq/message-ids.mjs';

// Always use fresh credentials and data: never restore the user's QQ account.
const report = { success: false, checked_at: new Date().toISOString(), node: process.versions.node,
  platform: process.platform, architecture: process.arch, authenticated: false,
  messages_received: false, messages_sent: false };
let directory, database, driver, reportPath;
try {
  let qrRequested = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--qr') qrRequested = true;
    else if (args[i] === '--report' && args[i + 1] && !args[i + 1].startsWith('--')) reportPath = resolve(args[++i]);
    else throw new Error('Usage: npm run qq:check -- [--qr] [--report PATH]');
  }
  const kernel = { runtime: resolve(process.env.QQ_RUNTIME_DIR || './runtime/qq'),
    directory: resolve(process.env.QQ_KERNEL_DIR || './runtime/kernel') };
  const metadata = await verifyKernel({ kernel });
  Object.assign(report, { version: metadata.version, runtime: kernel.runtime, kernel: kernel.directory,
    integrity_verified: true, required_exports: metadata.required_exports,
    buddy_list_arity: metadata.buddy_list_arity, sdk_app_id: metadata.sdk_app_id,
    qr_check_requested: qrRequested });
  if (qrRequested) {
    directory = await mkdtemp(join(tmpdir(), 'qq-runtime-check-'));
    const config = loadConfig({ QQ_DRIVER: 'kernel', QQ_ACCOUNT: '0',
      QQ_RUNTIME_DIR: kernel.runtime, QQ_KERNEL_DIR: kernel.directory, QQ_KERNEL_DATA: directory,
      DATA_DIR: directory, PORT: '0', QQ_RPC_TIMEOUT_MS: '20000', AI_ENABLED: 'false',
      ONEBOT_ACCESS_TOKEN: randomBytes(32).toString('hex'),
      ADMIN_ACCESS_TOKEN: randomBytes(32).toString('hex'), SESSION_KEY: randomBytes(32).toString('hex') });
    database = new DatabaseSync(':memory:');
    driver = new KernelDriver({ config, ids: new MessageIdMap(database) });
    driver.on('fault', () => {});
    await driver.connect();
    report.core_loaded = driver.diagnostics().core_loaded;
    assert.equal(report.core_loaded, true);
    const qr = await driver.invoke('auth.start');
    assert.equal(qr.mime, 'image/png');
    assert.match(qr.qrcode, /^data:image\/png;base64,/);
    const bytes = Buffer.from(qr.qrcode.split(',')[1], 'base64');
    assert.ok(bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
      'QQ must return a valid PNG QR image');
    const status = await driver.invoke('auth.poll', { handle: qr.handle });
    assert.equal(status.account, 0);
    assert.equal(status.state, 'waiting_scan');
    Object.assign(report, { qr_received: true, qr_bytes: bytes.length, login_state: status.state });
    await driver.close();
    assert.equal(driver.hostExit?.code, 0, 'QQ host must exit cleanly');
    report.clean_shutdown = true;
  }
  report.success = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try { await driver?.close(); }
  catch (error) { report.success = false; report.error = error.message; process.exitCode = 1; }
  database?.close();
  if (directory) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { report.success = false; report.error = 'Cannot remove isolated QQ check data'; process.exitCode = 1; }
  }
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
