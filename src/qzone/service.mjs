import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AIClient } from '../ai.mjs';
import { BotError, deadline } from '../errors.mjs';
import { SessionVault } from '../qq/session-vault.mjs';
import { parseSession, QzoneTransport, visibilityRights } from './transport.mjs';

const systemPrompt = '你是 QQ 空间文案助手。按用户给出的主题和素材写一条中文说说，只返回可直接发布的正文，不加引号、解释或 Markdown。不要捏造用户经历、位置、身份、他人的隐私或未提供的事实。';
const bad = message => new BotError(message, 1400);
function contentOf(value, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Array.from(value).length > 2000 || /\x00/.test(value)) throw bad('说说正文应为 1–2000 字。');
  return value.trim();
}
function visibilityOf(value = 'private') {
  if (typeof value !== 'string' || !Object.hasOwn(visibilityRights, value)) throw bad('请选择所有人、好友或仅自己可见。');
  return value;
}
function requestIdOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw bad('request_id 应为 8–128 位字母、数字、点、下划线、冒号或短横线。');
  return value;
}

export class QzoneService {
  constructor({ store, config, log = () => {}, transport, ai }) {
    this.db = store.db; this.config = config; this.log = log;
    this.simulated = config.driver === 'demo';
    this.transport = transport || new QzoneTransport();
    this.ai = ai || new AIClient({ ...config.ai, systemPrompt, maxReplyChars: 2000 });
    this.controller = new AbortController(); this.pending = new Set(); this.generating = 0;
    this.vault = new SessionVault(join(config.dataDir, 'qzone-session'), config.sessionKey);
    try { this.session = this.vault.load(1); }
    catch { this.credentialError = true; }
    this.db.exec(`CREATE TABLE IF NOT EXISTS qzone_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL, status TEXT NOT NULL, account INTEGER, simulated INTEGER NOT NULL,
      tid TEXT, url TEXT, reason TEXT, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS qzone_posts_status ON qzone_posts(status, updated_at);
      CREATE TABLE IF NOT EXISTS qzone_requests (
        request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, post_id INTEGER NOT NULL UNIQUE,
        created_at INTEGER NOT NULL);`);
    const now = Date.now();
    this.db.prepare("UPDATE qzone_posts SET status='uncertain',reason='process_stopped_during_publish',revision=revision+1,updated_at=? WHERE status='publishing'").run(now);
    this.db.prepare("UPDATE qzone_posts SET status='failed',reason='generation_interrupted',revision=revision+1,updated_at=? WHERE status='generating'").run(now);
    this.cleanup();
  }
  status() {
    return { configured: this.simulated || !!this.session, account: this.simulated ? 10000 : this.session?.account || 0,
      simulated: this.simulated, credential_error: !!this.credentialError,
      cookie_export_enabled: this.config.qzone?.allowCookieExport === true,
      ai_ready: this.simulated || !!this.config.ai.model.trim(), max_chars: 2000,
      retention_days: this.config.retentionDays, uncertain_retention_days: this.config.uncertainRetentionDays };
  }
  saveSession({ cookie, token = '' }) {
    if (this.simulated) throw bad('演示模式不保存真实空间凭据。');
    const session = parseSession(cookie, token);
    this.vault.save(1, session); this.session = session; this.credentialError = false;
    return this.status();
  }
  clearSession() { this.vault.remove(1); this.session = null; this.credentialError = false; return this.status(); }
  async check() {
    if (this.simulated) return { ...this.status(), verified: true };
    const session = this.requireSession();
    await this.transport.check(session, this.controller.signal);
    return { ...this.status(), verified: true };
  }
  requireSession() {
    if (!this.session) throw bad('请先保存 QQ 空间 Cookie。');
    return { ...this.session };
  }
  exportCookies(domain, account) {
    if (!this.config.qzone?.allowCookieExport) throw new BotError('空间 Cookie 导出未启用。请在全部设置 → OneBot 与推送中开启“允许 AstrBot 获取空间 Cookie”，保存后重启。', 1403);
    if (typeof domain !== 'string' || !['user.qzone.qq.com', 'qzone.qq.com'].includes(domain)) throw bad('get_cookies 仅支持 user.qzone.qq.com 或 qzone.qq.com。');
    if (this.simulated) throw new BotError('演示模式不提供真实空间 Cookie。', 1404);
    if (!Number.isSafeInteger(account) || account < 1) throw new BotError('当前 QQ 账号尚未确定，请先登录 QQ。', 1501);
    const session = this.requireSession();
    if (session.account !== account) throw bad('空间 Cookie 所属账号与当前 QQ 账号不一致，请更新空间凭据。');
    const fields = new Map(session.cookie.split(';').map(pair => {
      const i = pair.indexOf('='); return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }));
    if (!fields.get('p_skey')) throw new BotError('空间凭据缺少 p_skey，请重新保存 Cookie。', 1501);
    // AstrBot's QzoneContext needs these three fields, including a normalized
    // uin even when the saved session originally contained only p_uin.
    const cookies = [`uin=o${session.account}`, ...(fields.get('skey') ? [`skey=${fields.get('skey')}`] : []), `p_skey=${fields.get('p_skey')}`];
    return { cookies: cookies.join('; ') };
  }
  list() { return this.db.prepare('SELECT * FROM qzone_posts ORDER BY id DESC LIMIT 50').all().map(row => this.expose(row)); }
  expose(row) { return { ...row, simulated: !!row.simulated }; }
  get(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw bad('无效的空间草稿编号。');
    const row = this.db.prepare('SELECT * FROM qzone_posts WHERE id=?').get(id);
    if (!row) throw new BotError('空间草稿不存在。', 1404);
    return this.expose(row);
  }
  assertRevision(row, revision) {
    if (!Number.isSafeInteger(revision) || row.revision !== revision) throw bad('草稿已在其他页面更新，请重新载入后再操作。');
  }
  insert({ content = '', prompt = '', visibility, status, account = null }) {
    if (this.db.prepare('SELECT count(*) AS n FROM qzone_posts').get().n >= 5000) throw bad('空间记录已满，请等待保留周期清理后重试。');
    const now = Date.now();
    const result = this.db.prepare('INSERT INTO qzone_posts(content,prompt,visibility,status,account,simulated,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(content, prompt, visibility, status, account, Number(this.simulated), now, now);
    return this.get(Number(result.lastInsertRowid));
  }
  change(id, status, fields = {}) {
    const allowed = ['content', 'visibility', 'account', 'tid', 'url', 'reason'];
    const keys = Object.keys(fields);
    if (keys.some(key => !allowed.includes(key))) throw new Error('Invalid Qzone update');
    this.db.prepare(`UPDATE qzone_posts SET status=?,updated_at=?,revision=revision+1${keys.map(key => `,${key}=?`).join('')} WHERE id=?`)
      .run(status, Date.now(), ...keys.map(key => fields[key]), id);
    return this.get(id);
  }
  saveDraft(params) {
    const content = contentOf(params.content), visibility = visibilityOf(params.visibility);
    if (params.id === undefined || params.id === null) return this.insert({ content, visibility, status: 'draft' });
    const row = this.get(params.id); this.assertRevision(row, params.revision);
    if (!['draft', 'failed'].includes(row.status)) throw bad('当前记录不能编辑，请新建草稿。');
    return this.change(row.id, 'draft', { content, visibility, reason: null });
  }
  track(promise) {
    this.pending.add(promise); promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  validateGeneration(params) {
    if (!this.status().ai_ready) throw bad('请先在“全部设置 → AI 与回复”配置模型，保存后重启。无需启用聊天自动回复。');
    if (typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > Math.min(4000, this.config.ai.maxInputChars)) throw bad('请输入有效的主题与素材，长度不能超过模型输入限制或 4000 字。');
    if (this.generating >= 2) throw bad('已有两条空间文案正在生成，请稍后重试。');
  }
  generate(params) {
    this.validateGeneration(params);
    const row = this.insert({ prompt: params.prompt.trim(), visibility: visibilityOf(params.visibility), status: 'generating' });
    return this.startGeneration(row);
  }
  startGeneration(row, publishAccount) {
    this.generating++;
    this.track((async () => {
      let generated;
      try {
        const text = this.simulated ? '【演示文案】给忙碌的日常留一点空白，让心情慢慢舒展。' :
          await deadline(signal => this.ai.reply(row.prompt, [], signal), this.config.ai.timeout, { signal: this.controller.signal });
        generated = this.change(row.id, 'draft', { content: contentOf(text) });
        this.log('info', 'qzone_draft_generated', { job: row.id });
      } catch {
        this.change(row.id, 'failed', { reason: this.controller.signal.aborted ? 'generation_interrupted' : 'generation_failed' });
        this.log('warn', 'qzone_generation_failed', { job: row.id });
      } finally { this.generating--; }
      if (generated && publishAccount !== undefined) await this.publishDirect(generated, publishAccount);
    })());
    return row;
  }
  requestStatus(requestId) {
    const key = requestIdOf(requestId);
    const request = this.db.prepare('SELECT post_id FROM qzone_requests WHERE request_id=?').get(key);
    if (!request) throw new BotError('发布请求不存在。', 1404);
    const row = this.db.prepare('SELECT * FROM qzone_posts WHERE id=?').get(request.post_id);
    return { ...(row ? this.expose(row) : { id: request.post_id, status: 'expired', reason: 'record_expired' }), request_id: key };
  }
  async send(params) {
    const requestId = requestIdOf(params.request_id);
    const hasContent = Object.hasOwn(params, 'content'), hasPrompt = Object.hasOwn(params, 'prompt');
    if (hasContent === hasPrompt) throw bad('content 和 prompt 必须且只能提供一个。');
    if (!Number.isSafeInteger(params.account) || params.account < 1) throw bad('请提供要发布到的空间 QQ 号 account。');
    const visibility = visibilityOf(params.visibility);
    const content = hasContent ? contentOf(params.content) : '';
    if (hasPrompt && (typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > Math.min(4000, this.config.ai.maxInputChars))) throw bad('请输入有效的主题与素材，长度不能超过模型输入限制或 4000 字。');
    const prompt = hasPrompt ? params.prompt.trim() : '';
    const hash = createHash('sha256').update(JSON.stringify([this.simulated, params.account, visibility, hasContent ? 'content' : 'prompt', content || prompt])).digest('hex');
    const existing = this.db.prepare('SELECT payload_hash FROM qzone_requests WHERE request_id=?').get(requestId);
    if (existing) {
      if (existing.payload_hash !== hash) throw bad('同一 request_id 不能用于不同的正文、主题、账号或可见范围。');
      return this.requestStatus(requestId);
    }
    const account = this.simulated ? 10000 : this.requireSession().account;
    if (params.account !== account) throw bad('空间账号已变化，请刷新页面并确认发布账号。');
    if (this.controller.signal.aborted) throw bad('服务正在退出，请稍后查询已有请求结果。');
    if (hasPrompt) this.validateGeneration(params);
    if (this.db.prepare('SELECT count(*) AS n FROM qzone_requests').get().n >= 100000) throw bad('直接发布请求记录已满，请先归档数据后再创建新请求。');
    let row;
    // Bind the idempotency key and post atomically before any external call.
    this.db.exec('SAVEPOINT qzone_direct_send');
    try {
      row = this.insert({ content, prompt, visibility, status: hasPrompt ? 'generating' : 'draft', account });
      this.db.prepare('INSERT INTO qzone_requests(request_id,payload_hash,post_id,created_at) VALUES (?,?,?,?)').run(requestId, hash, row.id, Date.now());
      this.db.exec('RELEASE qzone_direct_send');
    } catch (error) {
      this.db.exec('ROLLBACK TO qzone_direct_send; RELEASE qzone_direct_send'); throw error;
    }
    if (hasPrompt) this.startGeneration(row, account);
    else await this.publishDirect(row, account);
    return this.requestStatus(requestId);
  }
  async publishDirect(row, account) {
    try {
      this.controller.signal.throwIfAborted();
      await this.publish({ id: row.id, revision: row.revision, account });
    } catch {
      // Throttling, a changed account, shutdown, or an edited draft means the
      // mutation did not start. Do not silently queue a later publication.
      const current = this.get(row.id);
      if (['draft', 'failed'].includes(current.status)) this.change(row.id, 'failed', { reason: 'publish_not_started' });
      this.log('warn', 'qzone_publish_failed', { job: row.id, state: 'failed' });
    }
  }
  publish(params) {
    const row = this.get(params.id);
    // Returning persisted state makes duplicate/concurrent publish calls safe.
    if (['publishing', 'published', 'uncertain', 'discarded'].includes(row.status)) return Promise.resolve(row);
    this.assertRevision(row, params.revision);
    if (row.status !== 'draft') throw bad('请先生成或保存一份完整草稿。');
    if (this.publishing) throw new BotError('已有说说正在发布，请等待结果后再发布下一条。', 1503);
    if (Date.now() < (this.nextPublishAt || 0)) throw new BotError('发布操作过于频繁，请稍后重试。', 1503);
    if (row.simulated !== this.simulated) throw bad('这条记录来自另一运行模式，请新建草稿。');
    contentOf(row.content); visibilityOf(row.visibility);
    const session = this.simulated ? { account: 10000 } : this.requireSession();
    if (params.account !== session.account) throw bad('空间账号已变化，请刷新页面并确认发布账号。');
    // Persist before crossing the network boundary. No automatic retries.
    this.change(row.id, 'publishing', { account: session.account, reason: null });
    this.publishing = true;
    this.nextPublishAt = Date.now() + Math.max(3000, this.config.sendInterval);
    return this.track((async () => {
      try {
        const result = this.simulated ? { tid: `demo-${row.id}`, url: null } : await this.transport.publish(session, row, this.controller.signal);
        const updated = this.change(row.id, 'published', { tid: result.tid, url: result.url });
        this.log('info', 'qzone_post_published', { job: row.id });
        return updated;
      } catch (error) {
        const uncertain = !(error instanceof BotError) || error.uncertain;
        const updated = this.change(row.id, uncertain ? 'uncertain' : 'failed', { reason: uncertain ? 'publish_uncertain' : 'publish_rejected' });
        this.log('warn', 'qzone_publish_failed', { job: row.id, state: updated.status });
        return updated;
      } finally { this.publishing = false; }
    })());
  }
  resolve(params) {
    const row = this.get(params.id); this.assertRevision(row, params.revision);
    if (row.status !== 'uncertain' || !['published', 'discard'].includes(params.outcome)) throw bad('只能核对结果未知的发布记录。');
    return this.change(row.id, params.outcome === 'published' ? 'published' : 'discarded', { reason: 'manually_resolved' });
  }
  cleanup() {
    const now = Date.now(), day = 86400000;
    this.db.prepare("DELETE FROM qzone_posts WHERE status IN ('draft','failed','published','discarded') AND updated_at<?").run(now - this.config.retentionDays * day);
    this.db.prepare("DELETE FROM qzone_posts WHERE status='uncertain' AND updated_at<?").run(now - this.config.uncertainRetentionDays * day);
  }
  async close() { this.controller.abort(); await Promise.allSettled([...this.pending]); }
}
