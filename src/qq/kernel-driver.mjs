import { fork } from 'node:child_process';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { QQDriver } from './driver.mjs';
import { BotError } from '../errors.mjs';
import { verifyRuntime } from './kernel/runtime.mjs';
import { normalizeMessage } from './kernel/messages.mjs';
import { validateKernelMessage, hasMedia } from './kernel/elements.mjs';
import { sdkAppId, buddyListArity } from './kernel/profile.mjs';
import { ImageDelivery } from './image-delivery.mjs';
import { describeDriverFault } from './faults.mjs';

export function assertKernelPlatform(platform = process.platform, architecture = process.arch) {
  if (platform === 'win32' && architecture === 'x64') return;
  const error = new BotError('QQ_DRIVER=kernel requires Windows x64; Linux containers cannot load QQNT.dll. Run the kernel on Windows.', 1501);
  error.reason = 'kernel_requires_windows_x64'; throw error;
}
export async function verifyKernel(config) {
  assertKernelPlatform();
  const metadata = JSON.parse(await readFile(join(config.kernel.directory, 'adapter.json'), 'utf8'));
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  if (metadata.schema !== 1 || metadata.host_sha256 !== sha(await readFile(process.execPath))) throw new BotError('QQ host changed; run npm run qq:build', 1501);
  if (sha(await readFile(join(config.kernel.directory, 'wrapper.node'))) !== metadata.adapted_kernel_sha256 ||
      sha(await readFile(join(config.kernel.directory, 'QQNT.dll'))) !== metadata.bridge_sha256) throw new BotError('QQ adapter integrity mismatch; run npm run qq:build', 1501);
  const runtime = await verifyRuntime(config.kernel.runtime);
  const major = await readFile(join(runtime.appPath, 'major.node'));
  if (runtime.root !== metadata.runtime_root || runtime.appPath !== metadata.app_path || runtime.version !== metadata.version ||
      sha(await readFile(join(runtime.appPath, 'wrapper.node'))) !== metadata.official_kernel_sha256 ||
      metadata.official_kernel_sha256 !== metadata.adapted_kernel_sha256 || sdkAppId(major) !== metadata.sdk_app_id ||
      sha(major) !== metadata.major_sha256) throw new BotError('QQ runtime does not match the unmodified official kernel', 1501);
  return { ...metadata, buddy_list_arity: buddyListArity(await readFile(join(runtime.appPath, 'wrapper.node'))) };
}
function spawnHost(config, metadata) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [config.kernel.directory, metadata.app_path, metadata.version_path, process.env.PATH || ''].join(';');
  const options = { kernelDir: config.kernel.directory, appPath: metadata.app_path, dataDir: config.kernel.data,
    version: metadata.version, rpcTimeout: config.rpcTimeout, account: config.account, appid: metadata.sdk_app_id,
    buddyListArity: metadata.buddy_list_arity };
  options.media=config.media;
  const child = fork(fileURLToPath(new URL('./kernel/host.mjs', import.meta.url)), [Buffer.from(JSON.stringify(options)).toString('base64url')], {
    cwd: config.kernel.data, windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced'
  });
  captureHostStderr(child, join(config.kernel.data, 'host-stderr.log'));
  return child;
}

// Keep native crash output local and bounded; never copy it into API responses.
export function captureHostStderr(child, path) {
  const stderr = createWriteStream(path, { flags: 'w', mode: 0o600 });
  let remaining = 256 * 1024;
  child.stderrFinished = new Promise(resolve => { stderr.once('finish', resolve); stderr.once('error', resolve); });
  child.stderr.on('data', chunk => { if (remaining > 0) { const part = chunk.subarray(0, remaining); remaining -= part.length; stderr.write(part); } });
  child.stderr.once('end', () => stderr.end());
  child.once('close', () => stderr.end());
  return child.stderrFinished;
}

async function writeValidation(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path);
}

export class KernelDriver extends QQDriver {
  constructor({ config, ids, verify = verifyKernel, spawn = spawnHost, writeEvidence = writeValidation }) {
    super({ account: config.account }); Object.assign(this, { config, ids, verify, spawn, writeEvidence });
    this.images=new ImageDelivery(config,()=>this.account);
    this.closed = false; this.pending = new Map(); this.sequence = 0; this.state = 'stopped';
    this.evidence = { core_loaded: false, qr_received: false, authenticated: false, messages_received: false, messages_sent: false };
    ids.db.exec(`CREATE TABLE IF NOT EXISTS kernel_messages (account TEXT NOT NULL,message_id INTEGER NOT NULL,content TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(account,message_id));
      CREATE TABLE IF NOT EXISTS kernel_contacts (account TEXT NOT NULL,uin INTEGER NOT NULL,uid TEXT NOT NULL,nickname TEXT NOT NULL,PRIMARY KEY(account,uin));`);
    ids.db.prepare('DELETE FROM kernel_messages WHERE time < ?').run(Math.floor(Date.now() / 1000) - config.retentionDays * 86400);
  }
  get mode() { return 'kernel'; }
  get capabilities() { return ['auth.start', 'auth.poll', 'auth.logout', 'account.get', 'friend.list', 'group.list', 'message.send', 'message.at', 'message.reply', 'message.get', 'image.get', 'media.image', 'media.record']; }
  diagnostics() { return { experimental: true, protocol: 'official-qqnt-kernel', version: this.metadata?.version || null,
    sdk_app_id: this.metadata?.sdk_app_id || null,
    ...(this.hostExit ? { host_exit: this.hostExit, stderr_file: 'host-stderr.log' } : {}),
    previous_stderr_file: 'host-stderr.previous.log',
    login_state: this.state, ...this.evidence, ...(this.lastLoginCode !== undefined ? { last_login_code: this.lastLoginCode } : {}),
    ...(this.lastError ? { last_error: this.lastError } : {}),
    ...(this.lastFault ? { last_fault: { ...this.lastFault } } : {}) }; }
  reportFault(error) {
    const failure = error instanceof BotError ? error : new BotError('Official QQ kernel request failed', 1500);
    this.lastFault = { ...describeDriverFault(failure), time: new Date().toISOString() };
    this.emit('fault', failure);
  }
  recordEvidence() {
    const snapshot = {
      version: this.metadata?.version || null, sdk_app_id: this.metadata?.sdk_app_id || null,
      login_state: this.state, ...this.evidence };
    const signature = JSON.stringify(snapshot);
    if (signature === this.evidenceSignature) return this.evidenceWrite;
    this.evidenceSignature = signature;
    const content = JSON.stringify({ ...snapshot, recorded_at: new Date().toISOString() }, null, 2) + '\n';
    this.evidenceWrite = (this.evidenceWrite || Promise.resolve())
      .then(() => this.writeEvidence(join(this.config.kernel.data, 'validation.json'), content))
      .catch(() => { this.evidenceSignature = null; this.reportFault(new BotError('Cannot save QQ validation record', 1500)); });
    return this.evidenceWrite;
  }
  async connect({ signal } = {}) {
    if (this.closed) throw new BotError('QQ kernel driver is closed', 1501);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.stopping;
      signal?.throwIfAborted();
      if (this.closed || this.loggedOut) return;
      if (this.child?.connected && this.ready) {
        if (this.needsRecovery) await this.rpc('auth.restore', {}, { signal });
        return;
      }
      this.metadata = await this.verify(this.config); signal?.throwIfAborted();
      await mkdir(this.config.kernel.data, { recursive: true });
      await this.stderrFinished;
      try { await rename(join(this.config.kernel.data, 'host-stderr.log'), join(this.config.kernel.data, 'host-stderr.previous.log')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      signal?.throwIfAborted();
      const child = this.child = this.spawn({ ...this.config, account: this.account }, this.metadata);
      this.ready = false; this.state = 'booting';
      child.on('message', packet => this.receive(packet, child));
      child.on('error', () => this.disconnected(child));
      child.once('exit', (code, signal) => { this.hostExit = { code, signal }; this.disconnected(child); });
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.off('host-ready', success); this.off('host-failed', failed); };
        const success = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new BotError('Official QQ kernel host failed to start', 1501, { retryable: true })); };
        const abort = () => { cleanup(); this.stopHost().catch(error => this.reportFault(error)); reject(new BotError('QQ kernel startup cancelled or timed out', 1502, { retryable: true })); };
        const timer = setTimeout(abort, this.config.rpcTimeout);
        this.once('host-ready', success); this.once('host-failed', failed);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  receive(packet, child) {
    if (this.child !== child || !packet || typeof packet !== 'object') return;
    if (packet.id) {
      const pending = this.pending.get(packet.id); if (!pending) return;
      if (packet.error) pending.reject(new BotError(packet.error.message || 'QQ kernel request failed', packet.error.code || 1500, { uncertain: packet.error.uncertain, retryable: packet.error.retryable }));
      else pending.resolve(packet.result);
      return;
    }
    switch (packet.event) {
      case 'ready': this.ready = true; this.evidence.core_loaded = true; this.recordEvidence(); this.emit('host-ready'); break;
      case 'fatal': this.lastError = 'Official QQ kernel host initialization failed'; this.emit('host-failed'); this.stopHost().catch(error => this.reportFault(error)); break;
      case 'fault': this.reportFault(new BotError('Official QQ kernel host fault', 1500)); break;
      case 'state': {
        const data = packet.data;
        if (!data || typeof data.state !== 'string') return;
        if (data.account) {
          if (!Number.isSafeInteger(data.account) || data.account <= 0 || this.account && this.account !== data.account) {
            this.lastError = 'QQ account mismatch'; this.loggedOut = true; this.stopHost({ force: true }).catch(error => this.reportFault(error)); return;
          }
          this.account = data.account;
        }
        this.online = data.online === true && data.authenticated === true && this.account > 0;
        this.state = data.state;
        this.needsRecovery = !this.online && data.reconnect === true;
        if (typeof data.reason === 'string') this.lastError = data.reason;
        if (Number.isFinite(data.login_error_code)) this.lastLoginCode = data.login_error_code;
        for (const name of ['qr_received', 'authenticated']) if (data[name] === true) this.evidence[name] = true;
        this.recordEvidence();
        this.emit('state', { online: this.online, account: this.account, reconnect: this.needsRecovery && !this.loggedOut && !this.closed }); break;
      }
      case 'contact': {
        const c = packet.data;
        if (this.account && Number.isSafeInteger(c?.user_id) && c.user_id > 0 && typeof c.uid === 'string' && /^u_[\w-]+$/.test(c.uid)) {
          this.ids.db.prepare('INSERT INTO kernel_contacts VALUES (?,?,?,?) ON CONFLICT(account,uin) DO UPDATE SET uid=excluded.uid,nickname=excluded.nickname')
            .run(String(this.account), c.user_id, c.uid, c.nickname || '');
        }
        break;
      }
      case 'message': {
        if (!this.online) return;
        try { const message = this.saveMessage(packet.data); if (message.sender.user_id !== this.account) this.evidence.messages_received = true; this.recordEvidence(); this.emit('message', message); }
        catch (error) { this.reportFault(error instanceof BotError ? error : new BotError('QQ message normalization failed', 1500)); }
        break;
      }
    }
  }
  resolveUid(uid) { return this.ids.db.prepare('SELECT uin FROM kernel_contacts WHERE account=? AND uid=?').get(String(this.account), uid || '')?.uin || 0; }
  saveMessage(raw) {
    const normalized = normalizeMessage(raw, this.account, uid => this.resolveUid(uid),file=>this.images.describe(file),
      msgId=>this.ids.allocate(this.account,JSON.stringify(['qq-kernel',Number(raw.chatType),String(raw.peerUid),msgId])));
    const id = this.ids.allocate(this.account, normalized.nativeId), message = { ...normalized, id };
    const replySource={msgId:String(raw.msgId),msgSeq:String(raw.msgSeq||'0'),clientSeq:String(raw.clientSeq||'0'),senderUin:String(message.sender.user_id)};
    const content = { message_id: id, real_id: String(raw.msgId), kernel_reply:replySource, time: message.time, message_type: message.kind,
      sender: message.sender, message: message.message, ...(message.kind === 'group' ? { group_id: message.groupId } : { user_id: message.sender.user_id }) };
    this.ids.db.prepare('INSERT INTO kernel_messages VALUES (?,?,?,?) ON CONFLICT(account,message_id) DO UPDATE SET content=excluded.content')
      .run(String(this.account), id, JSON.stringify(content), message.time);
    return message;
  }
  disconnected(child, { reconnect = !this.closed && !this.loggedOut } = {}) {
    if (child !== this.child) return;
    this.stderrFinished = child.stderrFinished;
    this.child = null; this.ready = false; this.online = false; this.state = reconnect ? 'reconnecting' : 'stopped'; this.needsRecovery = reconnect;
    for (const pending of this.pending.values()) pending.reject(new BotError('QQ kernel host disconnected', 1502, { uncertain: pending.mutation }));
    this.recordEvidence(); this.emit('host-failed'); this.emit('state', { online: false, reconnect });
  }
  stopHost({ force = false } = {}) {
    const child = this.child; if (!child) return this.stopping || Promise.resolve();
    this.stopping = new Promise((resolve, reject) => {
      let timer, fallback, finished = false;
      const cleanup = () => { clearTimeout(timer); clearTimeout(fallback); child.off('exit', finish); child.off('close', finish); };
      const finish = () => { finished = true; cleanup(); resolve(); };
      const kill = () => {
        if (finished) return;
        clearTimeout(timer); clearTimeout(fallback);
        child.kill();
        if (!finished) fallback = setTimeout(() => { cleanup(); reject(new BotError('QQ kernel host did not exit after shutdown', 1502)); }, 2000);
      };
      child.once('exit', finish); child.once('close', finish);
      if (typeof child.exitCode === 'number' || child.signalCode) { finish(); return; }
      if (force || !child.connected) { kill(); return; }
      timer = setTimeout(kill, this.config.kernel.shutdownTimeout);
      child.send({ event: 'shutdown' }, error => { if (error) kill(); });
    }).then(() => child.stderrFinished).finally(() => { this.stopping = null; });
    this.disconnected(child, { reconnect: false });
    return this.stopping;
  }
  async rpc(command, params, { signal, mutation = false, timeout = this.config.rpcTimeout } = {}) {
    signal?.throwIfAborted();
    const child = this.child;
    if (!child?.connected || !this.ready) throw new BotError('QQ kernel host is unavailable', 1501);
    const id = ++this.sequence; let timer, abort;
    try {
      return await new Promise((resolve, reject) => {
        abort = () => { if (child.connected) child.send({ cancel: id }, () => {}); reject(new BotError('QQ kernel operation cancelled or timed out', 1502, { uncertain: mutation })); };
        timer = setTimeout(abort, timeout); signal?.addEventListener('abort', abort, { once: true });
        this.pending.set(id, { resolve, reject, mutation });
        child.send({ id, command, params }, error => { if (error) reject(new BotError('QQ kernel IPC write failed', 1502, { uncertain: mutation })); });
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); }
  }
  async invoke(command, params = {}, context = {}) {
    if (command === 'auth.logout') { this.loggedOut = true; await this.stopHost(); return { disconnected: true, credentials_removed: false, remote_revocation: false }; }
    if (command.startsWith('auth.')) {
      if (command === 'auth.start') this.loggedOut = false;
      // A manual QR request must reach a running host even while connect() is
      // waiting for saved-session recovery. Otherwise that same failed recovery
      // prevents the user from ever requesting fresh authentication.
      if (command !== 'auth.start' || !this.child?.connected || !this.ready) await this.connect(context);
      return this.rpc(command, params, context);
    }
    if (!this.online) throw new BotError('Official QQ kernel is offline', 1501);
    if (command === 'message.get') {
      const row = this.ids.db.prepare('SELECT content FROM kernel_messages WHERE account=? AND message_id=?').get(String(this.account), params.messageId);
      if (!row) throw new BotError('Message not in retained QQ kernel cache', 1404);
      let message=JSON.parse(row.content);
      if(message.message.some(s=>s.type==='image'&&s.data?.file?.startsWith('file:')||s.type==='text'&&s.data?.text==='[图片下载失败，请稍后重发]')){
        const nativeId=this.ids.resolve(this.account,params.messageId),[,chatType,peerUid,msgId]=JSON.parse(nativeId);
        const result=await this.rpc('message.fetch',{chatType,peerUid,msgId},{...context,timeout:this.config.media?.timeout||90000});
        if(result.raw?.elements?.some(e=>e.picElement?.onebotImageError))throw new BotError('QQ original image download is unavailable; retry later',1404);
        this.saveMessage(result.raw);message=JSON.parse(this.ids.db.prepare('SELECT content FROM kernel_messages WHERE account=? AND message_id=?').get(String(this.account),params.messageId).content);
      }
      message.message=message.message.map(s=>s.type==='image'&&/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(s.data?.file||'')?
        {...s,data:{...s.data,...this.images.describe(s.data.file)}}:s);
      return message;
    }
    if(command==='image.get')return this.images.info(params.file);
    if (command === 'message.send') {
      validateKernelMessage(params.message);
      let replyIdentity,replySource;
      const source=params.message.find(s=>s.type==='reply');
      if(source){
        const nativeId=this.ids.resolve(this.account,Number(source.data.id));
        if(!nativeId)throw new BotError('Reply source is not retained',1404);
        const [protocol,chatType,peerUid,msgId]=JSON.parse(nativeId);
        if(protocol!=='qq-kernel'||chatType!==(params.kind==='group'?2:1))throw new BotError('Reply source belongs to another conversation',1400);
        const row=this.ids.db.prepare('SELECT content FROM kernel_messages WHERE account=? AND message_id=?').get(String(this.account),Number(source.data.id));
        const cached=row&&JSON.parse(row.content);
        const target=params.kind==='group'?Number(peerUid):cached?.user_id;
        const privateUid=this.ids.db.prepare('SELECT uid FROM kernel_contacts WHERE account=? AND uin=?').get(String(this.account),params.target)?.uid;
        if(params.kind==='group'?target!==params.target:privateUid?peerUid!==privateUid:target!==params.target)throw new BotError('Reply source belongs to another conversation',1400);
        replyIdentity={chatType,peerUid,msgId};replySource=cached?.kernel_reply;
      }
      const mentions={};
      for(const segment of params.message.filter(s=>s.type==='at'&&s.data.qq!=='all')){
        const contact=this.ids.db.prepare('SELECT uid,nickname FROM kernel_contacts WHERE account=? AND uin=?').get(String(this.account),Number(segment.data.qq));
        if(contact)mentions[String(segment.data.qq)]=contact;
      }
      const contact = this.ids.db.prepare('SELECT uid FROM kernel_contacts WHERE account=? AND uin=?').get(String(this.account), params.target);
      const result = await this.rpc(command, { ...params, peerUid: contact?.uid,replyIdentity,replySource,mentions }, { ...context, mutation: true,
        timeout:hasMedia(params.message)?this.config.media?.timeout||90000:this.config.rpcTimeout });
      try { const message = this.saveMessage(result.raw); this.evidence.messages_sent = true; this.recordEvidence(); return { message_id: message.id }; }
      catch { throw new BotError('QQ acknowledged send but message identity could not be stored', 1502, { uncertain: true }); }
    }
    if (!this.capabilities.includes(command)) throw new BotError('Official kernel command not implemented', 1404);
    return this.rpc(command, params, context);
  }
  async close() { this.closed = true; await this.stopHost(); await this.evidenceWrite; }
}
