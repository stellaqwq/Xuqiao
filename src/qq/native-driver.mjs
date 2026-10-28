import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, release } from 'node:os';
import { QQDriver } from './driver.mjs';
import { BotError } from '../errors.mjs';
import { loadProfile } from './native/profile.mjs';
import { HttpSigner, QQTransport } from './native/transport.mjs';
import { LoginCodec, registerRequest, assertRegistered } from './native/login.mjs';
import { encode } from './native/protobuf.mjs';
import { fetchFriends, fetchGroups } from './native/contacts.mjs';
import { encodeTextMessage, decodeSendAck, decodePush, messageKey, onebotMessage } from './native/messages.mjs';

const REGISTER = 'trpc.qq_new_tech.status_svc.StatusService.Register';
const HEARTBEAT = 'trpc.qq_new_tech.status_svc.StatusService.SsoHeartBeat';
const PUSH = 'trpc.msg.olpush.OlPushService.MsgPush';
const KICK = 'trpc.qq_new_tech.status_svc.StatusService.KickNT';
const activeQr = new Set(['waiting_scan', 'waiting_confirm']);

function deviceFile(path) {
  if (existsSync(path)) {
    const device = JSON.parse(readFileSync(path, 'utf8'));
    if (device.v !== 1 || !/^[a-f0-9]{32}$/.test(device.guid) || typeof device.deviceName !== 'string' ||
      typeof device.systemKernel !== 'string' || !Number.isSafeInteger(device.lastAccount) || device.lastAccount < 0) {
      throw new Error('Invalid native-device.json; restore its backup');
    }
    return device;
  }
  return { v: 1, guid: randomBytes(16).toString('hex'), deviceName: hostname(), systemKernel: release(), lastAccount: 0 };
}
function saveDevice(path, device) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(device), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export class NativeDriver extends QQDriver {
  constructor({ config, vault, ids, log = () => {}, transportFactory = options => new QQTransport(options) }) {
    super({ account: config.account });
    if (config.account > 0xffffffff) throw new Error('Native QQ_ACCOUNT must fit uint32');
    Object.assign(this, { config, vault, ids, log });
    this.controller = new AbortController(); this.closed = false; this.restorable = false;
    this.profile = loadProfile(config.native.profilePath);
    this.devicePath = join(config.dataDir, 'native-device.json');
    this.device = deviceFile(this.devicePath); saveDevice(this.devicePath, this.device);
    if (!this.account) this.account = this.device.lastAccount;
    this.session = { ...this.device, account: this.account, d2key: Buffer.alloc(16) };
    this.friends = new Map(); this.uids = new Map(); this.reverseUids = new Map();
    this.auth = { state: 'idle' };
    if (this.account) {
      const saved = this.vault.load(this.account); // Authentication failures never become an empty session.
      if (saved) {
        if (saved.v !== 1 || saved.account !== this.account || saved.guid !== this.device.guid) throw new Error('Native QQ saved session/device mismatch');
        if (saved.profile === this.profile.current_version) {
          for (const key of ['d2', 'd2key', 'tgt']) {
            if (typeof saved[key] !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(saved[key])) throw new Error('Invalid native QQ saved credential');
            this.session[key] = Buffer.from(saved[key], 'hex');
          }
          if (this.session.d2key.length !== 16) throw new Error('Invalid saved QQ session key');
          this.session.nickname = saved.nickname || ''; this.session.uid = saved.uid || ''; this.restorable = true;
        } else this.auth = { state: 'profile_changed' };
      }
    }
    this.transport = transportFactory({ ...config.native, timeout: config.rpcTimeout, profile: this.profile,
      session: this.session, signer: new HttpSigner({ ...config.native, profile: this.profile }) });
    this.transport.on('packet', packet => this.onPacket(packet));
    this.transport.on('fault', error => { this.lastError = error.message; this.emit('fault', error); });
    this.transport.on('expired', () => { this.restorable = false; this.auth = { state: 'session_expired' }; });
    this.transport.on('disconnect', () => {
      const wasOnline = this.online; this.online = false; clearTimeout(this.heartbeat);
      if (wasOnline && this.restorable && !this.closed) this.auth = { state: 'reconnecting' };
      else if (activeQr.has(this.auth.state)) this.auth = { handle: this.auth.handle, state: 'connection_lost' };
      this.emit('state', { online: false, reconnect: wasOnline && this.restorable && !this.closed });
    });
    ids.db.exec(`CREATE TABLE IF NOT EXISTS native_messages (
      account TEXT NOT NULL, message_id INTEGER NOT NULL, content TEXT NOT NULL, time INTEGER NOT NULL,
      PRIMARY KEY(account,message_id)
    )`);
    this.cleanupMessages();
  }
  get capabilities() { return ['auth.start', 'auth.poll', 'auth.logout', 'account.get', 'friend.list', 'group.list', 'message.send', 'message.at', 'message.get']; }
  diagnostics() {
    return { experimental: true, protocol: 'self-developed-ntqq', profile: this.profile.current_version,
      signer_configured: Boolean(this.config.native.signUrl), login_state: this.auth.state,
      transport: { ...this.transport.stats }, ...(this.lastError ? { last_error: this.lastError } : {}) };
  }
  context({ signal } = {}) { return { signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal }; }
  async connect(context = {}) {
    if (this.closed) throw new BotError('Native QQ driver closed', 1501);
    if (this.online || !this.restorable || this.authBusy) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.transport.open(this.context(context));
      try { await this.register(context); }
      catch (error) {
        if (error.authExpired) { this.restorable = false; this.auth = { state: 'session_expired' }; }
        this.lastError = error instanceof BotError ? error.message : 'QQ session restore failed';
        this.transport.close(); throw error;
      }
    })();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async register(context) {
    assertRegistered(await this.transport.request(REGISTER, registerRequest(this.session, this.profile), this.context(context)));
    this.context(context).signal.throwIfAborted();
    this.account = this.session.account; this.restorable = true;
    this.persist(); // Do not report online until the credential has been saved.
    this.rememberUid(this.account, this.session.uid);
    this.online = true; this.auth = { ...this.auth, state: 'online' }; this.lastError = undefined;
    this.emit('state', { online: true, account: this.account }); this.scheduleHeartbeat();
  }
  persist() {
    this.vault.save(this.account, { v: 1, account: this.account, guid: this.session.guid,
      profile: this.profile.current_version, nickname: this.session.nickname || '', uid: this.session.uid || '',
      ...Object.fromEntries(['d2', 'd2key', 'tgt'].map(key => [key, this.session[key].toString('hex')])) });
    this.device.lastAccount = this.account; saveDevice(this.devicePath, this.device);
  }
  scheduleHeartbeat() {
    clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(async () => {
      if (!this.online || this.closed) return;
      try {
        await this.transport.request(HEARTBEAT, encode({ 1: 1 }), this.context());
        this.cleanupMessages(); this.scheduleHeartbeat();
      } catch { this.transport.close(); }
    }, 270000);
  }
  rememberUid(uin, uid) {
    if (!uin || !uid) return;
    this.uids.set(uin, uid); this.reverseUids.set(uid, uin);
  }
  cleanupMessages() {
    this.ids.db.prepare('DELETE FROM native_messages WHERE time < ?').run(Math.floor(Date.now() / 1000) - this.config.retentionDays * 86400);
  }
  saveMessage(message) {
    const messageId = this.ids.allocate(this.account, messageKey(message));
    this.ids.db.prepare('INSERT INTO native_messages(account,message_id,content,time) VALUES (?,?,?,?) ON CONFLICT(account,message_id) DO UPDATE SET content=excluded.content')
      .run(String(this.account), messageId, JSON.stringify(onebotMessage(message, messageId)), message.time);
    return messageId;
  }
  onPacket(packet) {
    if (this.closed) return;
    if (packet.command === KICK) {
      this.restorable = false; this.online = false; this.auth = { state: 'kicked' }; clearTimeout(this.heartbeat);
      this.transport.close(); this.emit('state', { online: false }); return;
    }
    if (packet.command !== PUSH || !this.online) return;
    try {
      const message = decodePush(packet.body, this.account, uid => this.reverseUids.get(uid));
      if (!message) return;
      this.rememberUid(message.sender.user_id, message.fromUid); this.rememberUid(message.to, message.toUid);
      const messageId = this.saveMessage(message);
      this.emit('message', { ...message, id: messageId });
    } catch (error) { this.emit('fault', error instanceof BotError ? error : new BotError('Invalid QQ message push', 1500)); }
  }
  authResult(includeQr = false) {
    const { signature: _signature, image, ...fields } = this.auth;
    return { ...fields, account: this.account, online: this.online, simulated: false,
      ...(includeQr && image ? { qrcode: `data:image/png;base64,${image.toString('base64')}`, mime: 'image/png' } : {}) };
  }
  async startLogin(context) {
    if (this.online) return this.authResult();
    if (activeQr.has(this.auth.state)) return this.authResult(true);
    // Fail before opening QQ if a required signer has not been configured.
    if (!this.config.native.signUrl) throw new BotError('Set QQ_SIGN_URL to a trusted NTQQ signer matching QQ_PROFILE before login/send', 1501);
    this.codec = new LoginCodec();
    this.session.d2 = undefined; this.session.tgt = undefined; this.session.d2key = Buffer.alloc(16); this.restorable = false;
    await this.transport.open(this.context(context));
    const qr = this.codec.parseQr(await this.transport.request('wtlogin.trans_emp', this.codec.qrRequest(this.session, this.profile), this.context(context)));
    this.auth = { ...qr, handle: randomBytes(24).toString('hex'), state: 'waiting_scan',
      issued_at: Math.floor(Date.now() / 1000), expires_at: null, poll_after_ms: 2000 };
    this.lastError = undefined;
    return this.authResult(true);
  }
  async pollLogin({ handle }, context) {
    if (!handle || handle !== this.auth.handle) throw new BotError('Unknown or stale QQ login handle', 1400);
    if (!activeQr.has(this.auth.state)) return this.authResult();
    if (Date.now() < (this.nextPoll || 0)) return this.authResult();
    this.nextPoll = Date.now() + 2000;
    try {
      const result = this.codec.parseQrPoll(await this.transport.request('wtlogin.trans_emp',
        this.codec.qrPoll(this.session, this.profile, this.auth.signature), this.context(context)));
      this.auth.state = result.state;
      if (result.protocol_code !== undefined) this.auth.protocol_code = result.protocol_code;
      if (result.state !== 'confirmed') return this.authResult();
      if (this.account && result.account !== this.account) {
        this.auth.state = 'account_mismatch';
        throw new BotError('Scanned QQ account differs from configured account; restart with the intended account', 1400);
      }
      this.session.account = result.account; this.account = result.account;
      this.auth.state = 'authenticating';
      const login = this.codec.parseLogin(await this.transport.request('wtlogin.login',
        this.codec.loginRequest(this.session, this.profile, result), this.context(context)), result.key);
      this.auth.state = login.state;
      if (login.state !== 'authenticated') { this.auth.protocol_code = login.protocol_code; return this.authResult(); }
      Object.assign(this.session, login);
      await this.register(context);
      return this.authResult();
    } catch (error) {
      if (!activeQr.has(this.auth.state) && this.auth.state !== 'account_mismatch') this.auth.state = 'failed';
      this.lastError = error instanceof BotError ? error.message : 'QQ login failed';
      throw error;
    } finally {
      if (!activeQr.has(this.auth.state)) { delete this.auth.signature; delete this.auth.image; }
    }
  }
  async invoke(command, params = {}, context = {}) {
    if (this.closed) throw new BotError('Native QQ driver closed', 1501);
    if (command.startsWith('auth.')) {
      if (this.authBusy || this.connecting) throw new BotError('QQ login operation already in progress', 1503);
      this.authBusy = true;
      try {
        if (command === 'auth.start') return await this.startLogin(context);
        if (command === 'auth.poll') return await this.pollLogin(params, context);
        if (command === 'auth.logout') {
          this.restorable = false; this.online = false; clearTimeout(this.heartbeat); this.transport.close();
          if (this.account) this.vault.remove(this.account);
          this.session.d2 = undefined; this.session.tgt = undefined; this.session.d2key = Buffer.alloc(16);
          this.auth = { state: 'logged_out' }; this.emit('state', { online: false });
          return { disconnected: true, credentials_removed: true, remote_revocation: false };
        }
        throw new BotError('Unknown QQ login operation', 1404);
      } finally { this.authBusy = false; }
    }
    if (!this.online) throw new BotError('Native QQ is offline', 1501, { retryable: this.restorable });
    const ctx = this.context(context);
    switch (command) {
      case 'account.get': return { user_id: this.account, nickname: this.session.nickname || '' };
      case 'friend.list': {
        const friends = await fetchFriends(this.transport, ctx); this.friends = friends;
        for (const friend of friends.values()) this.rememberUid(friend.user_id, friend.uid);
        return [...friends.values()].map(({ uid: _uid, ...friend }) => friend);
      }
      case 'group.list': return fetchGroups(this.transport, ctx);
      case 'message.get': {
        const result = this.ids.db.prepare('SELECT content FROM native_messages WHERE account=? AND message_id=?').get(String(this.account), params.messageId);
        if (!result) throw new BotError('Message not found in retained native message cache', 1404);
        return JSON.parse(result.content);
      }
      case 'message.send': {
        if (!Number.isInteger(params.target) || params.target <= 0 || params.target > 0xffffffff) throw new BotError('Native QQ target must fit uint32', 1400);
        if (params.kind === 'private' && !this.uids.has(params.target)) await this.invoke('friend.list', {}, context);
        const body = encodeTextMessage({ ...params, sequence: randomBytes(2).readUInt16BE(), random: randomBytes(4).readUInt32BE(),
          uid: this.uids.get(params.target), resolveUid: target => this.uids.get(target) });
        const response = await this.transport.request('MessageSvc.PbSendMsg', body, { ...ctx, mutation: true });
        let ack;
        try { ack = decodeSendAck(response, params.kind); }
        catch (error) {
          if (error instanceof BotError) throw error;
          throw new BotError('Malformed QQ send ACK; result unknown', 1502, { uncertain: true });
        }
        const message = { ...params, ...ack, sender: { user_id: this.account, nickname: this.session.nickname || '' } };
        try { return { message_id: this.saveMessage(message) }; }
        catch { throw new BotError('QQ accepted message but local ID persistence failed', 1502, { uncertain: true }); }
      }
      default: throw new BotError('Native QQ command is not implemented', 1404);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.online = false; this.controller.abort(); clearTimeout(this.heartbeat);
    this.transport.close(); this.auth = { state: 'closed' }; this.codec = undefined;
  }
}
