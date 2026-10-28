import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { BotError } from '../../errors.mjs';
import { cat, uint, sized, Reader } from './binary.mjs';
import { encode } from './protobuf.mjs';
import { encrypt, decrypt } from './tea.mjs';

export const MAX_PACKET = 8 * 1024 * 1024;
const signedCommands = new Set(['wtlogin.trans_emp', 'wtlogin.login', 'MessageSvc.PbSendMsg']);
const unavailable = () => new BotError('QQ connection unavailable before write', 1501, { retryable: true });
const cancelled = uncertain => new BotError('QQ request cancelled or timed out', 1502, { uncertain });

export class HttpSigner {
  constructor({ signUrl, signToken = '', timeout = 8000, profile }, fetcher = fetch) {
    Object.assign(this, { signUrl, signToken, timeout, profile, fetcher });
  }
  async sign(command, sequence, body, session, signal) {
    if (!signedCommands.has(command)) return undefined;
    if (!this.signUrl) throw new BotError('Set QQ_SIGN_URL to a trusted NTQQ signer matching QQ_PROFILE before login/send', 1501);
    let result;
    try {
      const response = await this.fetcher(this.signUrl, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'User-Agent': `qq/${this.profile.current_version}`,
          ...(this.signToken ? { Authorization: `Bearer ${this.signToken}` } : {}) },
        body: JSON.stringify({ command, seq: sequence, body: body.toString('hex'), uin: session.account,
          guid: session.guid, qua: this.profile.package_sign }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout)
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 65536) throw new Error();
        chunks.push(chunk);
      }
      result = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      if (signal?.aborted) throw cancelled(false);
      throw new BotError('QQ signer request failed before QQ packet write', 1501, { retryable: true });
    }
    if (result.code !== 0) throw new BotError('QQ signer rejected request or profile version', 1500);
    // Lagrange-compatible sign endpoints use either value.sec_* or value.*.
    const value = result.value;
    const fields = [value?.sec_sign ?? value?.sign, value?.sec_token ?? value?.token, value?.sec_extra ?? value?.extra];
    if (fields.some(v => typeof v !== 'string' || v.length % 2 || !/^[0-9a-f]*$/i.test(v)) || !fields[0]) {
      throw new BotError('Invalid QQ signer response', 1500);
    }
    return Object.fromEntries(fields.map((v, i) => [i + 1, Buffer.from(v, 'hex')]));
  }
}

export function packRequest({ command, sequence, body, session, profile, sign }) {
  const reserve = encode({ 15: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
    16: session.uid || '', 24: sign });
  const header = cat(uint(sequence), uint(profile.sub_app_id), uint(2052), Buffer.from('020000000000000000000000', 'hex'),
    sized(session.tgt), sized(command), sized(''), sized(Buffer.from(session.guid, 'hex')), sized(''),
    sized(profile.current_version, 2), sized(reserve));
  const encrypted = encrypt(cat(sized(header), sized(body)), session.d2key ?? Buffer.alloc(16));
  return sized(cat(uint(12), uint(session.d2?.length ? 1 : 2, 1), sized(session.d2), uint(0, 1),
    sized(String(session.account)), encrypted));
}

export function unpackResponse(frame, key) {
  const reader = new Reader(frame);
  if (![10, 11, 12, 13].includes(reader.u())) throw new BotError('Unsupported QQ SSO packet type', 1500);
  const encryption = reader.u(1);
  if (reader.u(1) !== 0) throw new BotError('Invalid QQ SSO marker', 1500);
  const account = reader.sized().toString();
  let payload = reader.rest();
  if (encryption === 1) payload = decrypt(payload, key ?? Buffer.alloc(16));
  else if (encryption === 2) payload = decrypt(payload, Buffer.alloc(16));
  else if (encryption !== 0) throw new BotError('Unsupported QQ SSO encryption', 1500);
  const sso = new Reader(payload), header = new Reader(sso.sized());
  const sequence = header.i32(), code = header.i32();
  header.sized(); // Error text can contain server-controlled secrets: do not log.
  if (code !== 0) {
    const error = new BotError(`QQ SSO rejected request (${code})`, 1500);
    error.protocolCode = code; error.sequence = sequence;
    error.authExpired = [-10001, -10003, -10008].includes(code);
    throw error;
  }
  const command = header.sized().toString();
  header.sized();
  const compression = header.u();
  let body = sso.sized();
  if (compression === 1) body = inflateSync(body, { maxOutputLength: MAX_PACKET });
  else if (compression === 8) body = new Reader(body).skip(4).rest();
  else if (compression !== 0) throw new BotError('Unsupported QQ SSO compression', 1500);
  return { sequence, command, body, account };
}

export class QQTransport extends EventEmitter {
  constructor({ session, profile, signer, host = 'msfwifi.3g.qq.com', port = 8080, timeout = 15000 }) {
    super(); Object.assign(this, { session, profile, signer, host, port, timeout });
    this.pending = new Map(); this.sequence = randomBytes(2).readUInt16BE() & 0x7fff;
    this.stats = { connected: false, sent: 0, received: 0 };
  }
  async open({ signal } = {}) {
    if (signal?.aborted) throw cancelled(false);
    if (this.socket && !this.socket.destroyed && this.stats.connected) return;
    if (this.opening) return this.opening;
    this.opening = this.openSocket(signal);
    try { await this.opening; } finally { this.opening = null; }
  }
  async openSocket(signal) {
    const socket = createConnection({ host: this.host, port: this.port });
    this.socket = socket; this.buffer = Buffer.alloc(0);
    socket.setNoDelay(true); socket.setKeepAlive(true, 30000);
    socket.on('error', () => {});
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        socket.off('error', failed); socket.off('connect', connected); socket.off('close', closed);
        if (error) { socket.destroy(); reject(error); } else resolve();
      };
      const abort = () => finish(cancelled(false));
      const failed = () => finish(unavailable());
      const closed = () => finish(unavailable());
      const connected = () => {
        this.stats.connected = true;
        socket.on('data', chunk => this.receive(chunk));
        socket.on('close', () => {
          if (this.socket !== socket) return;
          this.stats.connected = false;
          this.rejectPending(); this.emit('disconnect');
        });
        finish();
      };
      const timer = setTimeout(failed, this.timeout);
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('error', failed); socket.once('close', closed); socket.once('connect', connected);
      if (signal?.aborted) abort();
    });
  }
  receive(chunk) {
    try {
      this.buffer = cat(this.buffer, chunk);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE();
        if (length < 10 || length > MAX_PACKET) throw new BotError('Invalid QQ TCP frame size', 1500);
        if (this.buffer.length < length) break;
        const frame = this.buffer.subarray(4, length);
        this.buffer = this.buffer.subarray(length);
        let packet;
        try { packet = unpackResponse(frame, this.session.d2key); }
        catch (error) {
          const pending = this.pending.get(error.sequence);
          if (!pending || error.authExpired) throw error;
          pending.finish(error); continue;
        }
        this.stats.received++;
        const pending = this.pending.get(packet.sequence);
        if (pending && pending.command === packet.command) pending.finish(null, packet.body);
        else this.emit('packet', packet);
      }
    } catch (error) {
      this.emit('fault', error instanceof BotError ? error : new BotError('Malformed QQ server packet', 1500));
      if (error.authExpired) this.emit('expired');
      this.close();
    }
  }
  async request(command, body, { signal, mutation = false } = {}) {
    if (signal?.aborted) throw cancelled(false);
    if (!this.stats.connected || this.socket?.destroyed) throw unavailable();
    if (this.pending.size >= 128) throw new BotError('QQ request limit exceeded', 1503);
    let sequence;
    do { this.sequence = (this.sequence + 1) % 0x8000; sequence = this.sequence; } while (this.pending.has(sequence));
    const sign = await this.signer.sign(command, sequence, body, this.session, signal);
    if (signal?.aborted) throw cancelled(false);
    if (!this.stats.connected || this.socket?.destroyed) throw unavailable();
    const frame = packRequest({ command, sequence, body, sign, session: this.session, profile: this.profile });
    if (frame.length > MAX_PACKET) throw new BotError('QQ outgoing packet too large', 1400);
    return new Promise((resolve, reject) => {
      let written = false;
      const finish = (error, value) => {
        if (!this.pending.delete(sequence)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(cancelled(mutation && written));
      const timer = setTimeout(() => finish(new BotError('QQ request timed out', 1502,
        { uncertain: mutation && written, retryable: !mutation })), this.timeout);
      this.pending.set(sequence, { command, finish, error: () => written && mutation ?
        new BotError('QQ disconnected after write; send result unknown', 1502, { uncertain: true }) : unavailable() });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { written = true; this.socket.write(frame); this.stats.sent++; }
      catch { finish(mutation ? new BotError('QQ write result unknown', 1502, { uncertain: true }) : unavailable()); }
    });
  }
  rejectPending() { for (const pending of [...this.pending.values()]) pending.finish(pending.error()); }
  close() { this.stats.connected = false; this.rejectPending(); this.socket?.destroy(); }
}
