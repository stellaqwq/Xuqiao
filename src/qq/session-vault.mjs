import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export class SessionVault {
  constructor(directory, keyHex) {
    if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('Invalid session encryption key');
    this.directory = directory;
    this.key = Buffer.from(keyHex, 'hex');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  path(account) {
    if (!/^[1-9]\d*$/.test(String(account))) throw new Error('Invalid account ID');
    return join(this.directory, `${account}.session`);
  }
  save(account, session) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`qq-ai-bot/session/v1/${account}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    const target = this.path(account);
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify({ v: 1, nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  }
  load(account) {
    const target = this.path(account);
    if (!existsSync(target)) return null;
    const saved = JSON.parse(readFileSync(target, 'utf8'));
    if (saved.v !== 1) throw new Error('Unsupported encrypted session version');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(saved.nonce, 'base64'));
    cipher.setAAD(Buffer.from(`qq-ai-bot/session/v1/${account}`));
    cipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(saved.data, 'base64')), cipher.final()]).toString('utf8'));
  }
  remove(account) {
    try { unlinkSync(this.path(account)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
