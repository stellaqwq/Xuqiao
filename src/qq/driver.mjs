import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { BotError } from '../errors.mjs';

/**
 * Independent QQ core boundary. No QQ wire protocol is claimed here.
 * Drivers emit message(normalized), notice(OneBot fields), request(OneBot fields),
 * state({online, account}), fault(error). See docs/DRIVER.md for the contract.
 */
export class QQDriver extends EventEmitter {
  constructor({ account = 0 } = {}) { super(); this.account = account; this.online = false; }
  get mode() { return 'native'; }
  get capabilities() { return []; }
  async connect() {}
  async close() { this.online = false; }
  async invoke(_command, _params, _context) {
    throw new BotError('QQ protocol driver is not implemented', 1501);
  }
}

export class ScaffoldDriver extends QQDriver {
  get mode() { return 'scaffold'; }
}

export async function loadDriver(config, vault, log, ids) {
  if (config.driver === 'kernel') {
    const { KernelDriver } = await import('./kernel-driver.mjs');
    return new KernelDriver({ config, ids });
  }
  if (config.driver === 'native') {
    const { NativeDriver } = await import('./native-driver.mjs');
    return new NativeDriver({ config, vault, log, ids });
  }
  if (config.driver === 'scaffold') return new ScaffoldDriver({ account: config.account });
  if (config.driver === 'demo') {
    const { DemoDriver } = await import('./demo-driver.mjs');
    return new DemoDriver({ account: config.account || 10000 });
  }
  const module = await import(pathToFileURL(resolve(config.driver)).href);
  if (typeof module.createDriver !== 'function') throw new Error('QQ_DRIVER module must export createDriver');
  const driver = await module.createDriver({ account: config.account, vault, log, ids, config });
  if (!(driver instanceof QQDriver)) throw new Error('Custom driver must extend QQDriver');
  return driver;
}
