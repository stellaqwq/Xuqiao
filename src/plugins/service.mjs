import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { conversation, eventKey, chatText, isChatCommand, isChatAdmin, isGroupUserBlocked, aiInput, replyMessage, replyOptions } from '../messages.mjs';
import { memeConfig, memePluginTemplate } from '../memes/service.mjs';
import { voiceStudioConfig, voiceStudioTemplate } from '../voicestudio/service.mjs';
import { normalizeTools } from '../agent/schema.mjs';
import { groupChatConfig,groupChatTemplate } from '../group-chat-plus/config.mjs';
import { normalizeConfigSchema,applyConfigSchema } from './config-schema.mjs';
import {groupChatSchema} from '../group-chat-plus/schema.mjs';
import {GroupChatManagement} from '../group-chat-plus/management.mjs';

const MAX_PLUGINS = 32, MAX_SOURCE = 49152, MAX_QUEUE = 100;
export const pluginErrors = {
  syntax_error: '代码加载失败，请检查 JavaScript 语法和导入。',
  invalid_export: '代码必须使用 export default 导出一个函数。',
  runtime_error: '插件执行失败，请检查代码和配置。',
  invalid_result: '返回值应为 { reply: "文本" }、{ message: [文本或图片消息段] } 或 null；文本最多 2000 字，消息段最多 5 个。',
  timeout: '插件执行超时，已终止线程。', stopped: '插件执行已取消。',
  send_failed: '回复发送失败，未自动重试。', delivery_unknown: '发送结果未知，请在 QQ 中核对；不会自动重发。'
};
export const pluginTemplate = {
  schema: 1, name: '指令回复', description: '收到 /ping 时返回自定义文本。', version: '1.0.0',
  trigger: '/', priority: 0, timeout_ms: 3000,
  scope: { private_users: [], groups: [], all_private: false, all_groups: false, require_at: true },
  config: { command: '/ping', response: 'pong！插件运行正常。' },
  source: `export default async function ({ text, config, event }) {
  if (text.trim() !== config.command) return null;
  return { reply: config.response, handled: true };
}
`
};
function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function boundedText(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw problem(label + '无效或超过长度限制。');
  return value;
}
function ids(value) {
  if (!Array.isArray(value) || value.length > 500 || value.some(id => !/^[1-9]\d{0,15}$/.test(String(id)) || !Number.isSafeInteger(Number(id)))) throw problem('会话范围必须为有效 QQ 号数组（最多 500 项）。');
  return [...new Set(value.map(String))];
}
function normalize(value) {
  if (!object(value) || value.schema !== undefined && value.schema !== 1) throw problem('请选择版本 1 的插件 JSON。');
  const name = boundedText(value.name, '插件名称', 80, true).trim();
  const kind = value.kind ?? 'script';
  if (!['script', 'meme-manager', 'voicestudio','group-chat-plus'].includes(kind)) throw problem('未知插件类型。');
  const source = boundedText(value.source, '插件代码', MAX_SOURCE, true);
  if (Buffer.byteLength(source) > MAX_SOURCE) throw problem('插件代码不能超过 48 KiB。');
  const config_schema=normalizeConfigSchema(value.config_schema??{});
  const config = value.config ?? {}, scope = value.scope ?? pluginTemplate.scope;
  if (!object(config) || Buffer.byteLength(JSON.stringify(config)) > 32768) throw problem('插件配置必须为 JSON 对象且不能超过 32 KiB。');
  if (!object(scope)) throw problem('插件会话范围无效。');
  for (const key of ['all_private', 'all_groups', 'require_at']) if (scope[key] !== undefined && typeof scope[key] !== 'boolean') throw problem('会话范围开关必须是布尔值。');
  const priority = value.priority ?? 0, timeout = value.timeout_ms ?? 3000;
  if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) throw problem('优先级必须是 -100 至 100 的整数。');
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10000) throw problem('执行时限必须是 100 至 10000 毫秒的整数。');
  if(kind==='group-chat-plus'&&(scope.all_private||scope.private_users?.length))throw problem('群聊增强只能配置群聊范围。');
  const mergedConfig=kind==='meme-manager'?memeConfig(config):kind==='voicestudio'?voiceStudioConfig(config):kind==='group-chat-plus'?groupChatConfig(config):applyConfigSchema(config_schema,config);
  if(Buffer.byteLength(JSON.stringify(mergedConfig))>32768)throw problem('合并默认值后的插件配置不能超过 32 KiB。');
  return { schema: 1, kind, name, source: kind === 'meme-manager' ? memePluginTemplate.source : kind === 'voicestudio' ? voiceStudioTemplate.source : kind==='group-chat-plus'?groupChatTemplate.source:source,
    config: mergedConfig,
    config_schema,
    author: boundedText(value.author??'', '插件作者',100),
    repository: boundedText(value.repository??'', '插件仓库',300),
    tools: kind === 'script' ? normalizeTools(value.tools) : [],
    description: boundedText(value.description ?? '', '插件说明', 500),
    version: boundedText(value.version ?? '1.0.0', '插件版本', 40, true),
    trigger: kind !== 'script' ? '' : boundedText(value.trigger ?? '', '触发前缀', 80), priority, timeout_ms: timeout,
    scope: { private_users: ids(scope.private_users ?? []), groups: ids(scope.groups ?? []),
      all_private: scope.all_private ?? false, all_groups: scope.all_groups ?? false, require_at: scope.require_at ?? true } };
}
function textOf(event) {
  return Array.isArray(event.message) ? event.message.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim() : '';
}
function matches(plugin, event, tool = false) {
  const scope = plugin.scope;
  if(plugin.kind==='group-chat-plus'&&event.message_type!=='group')return false;
  if (event.post_type !== 'message' || String(event.user_id) === String(event.self_id)) return false;
  if (event.message_type === 'private') {
    if (!scope.all_private && !scope.private_users.includes(String(event.user_id))) return false;
  } else if (event.message_type === 'group') {
    if (!scope.all_groups && !scope.groups.includes(String(event.group_id))) return false;
    if (plugin.kind!=='group-chat-plus'&&scope.require_at && !event.message?.some(s => s.type === 'at' && String(s.data?.qq) === String(event.self_id))) return false;
  } else return false;
  return tool || textOf(event).startsWith(plugin.trigger);
}

export class PluginService {
  constructor({ store, adapter, log, config, retentionDays = 7, memes, voicestudio, groupChatPlus }) {
    Object.assign(this, { store, adapter, log, config, retentionDays, memes, voicestudio, groupChatPlus });
    this.closed = false; this.workers = new Map(); this.tasks = new Set(); this.tails = new Map(); this.mutations = Promise.resolve();
    store.db.exec(`CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY, definition TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
      runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
      last_run INTEGER, last_error TEXT);
      CREATE TABLE IF NOT EXISTS plugin_receipts (event_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`);
    this.cleanup();
    if(groupChatPlus)this.groupAdmin=new GroupChatManagement(this);
  }
  cleanup() {
    this.store.db.prepare('DELETE FROM plugin_receipts WHERE created_at < ?').run(Date.now() - this.retentionDays * 86400000);
  }
  rows() {
    return this.store.db.prepare('SELECT * FROM plugins ORDER BY id').all().map(row => ({
      kind: 'script', ...JSON.parse(row.definition), id: row.id, enabled: !!row.enabled, revision: row.revision,
      updated_at: row.updated_at, runs: row.runs, failures: row.failures,
      last_run: row.last_run, last_error: row.last_error ? pluginErrors[row.last_error] || pluginErrors.runtime_error : null
    })).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }
  get(id) {
    if (typeof id !== 'string') throw problem('插件编号无效。');
    const row = this.rows().find(row => row.id === id);
    if (!row) throw problem('插件不存在，请刷新列表。', 404);
    if(row.kind==='group-chat-plus')row.config_schema=groupChatSchema;
    return row;
  }
  list() {
    return { plugins: this.rows().map(({ source, config, config_schema, ...row }) => row), template: pluginTemplate, limit: MAX_PLUGINS, builtins: [memePluginTemplate, voiceStudioTemplate,groupChatTemplate] };
  }
  mutate(fn) {
    const task = this.mutations.then(() => { if (this.closed) throw problem('服务正在关闭。', 409); return fn(); });
    this.mutations = task.catch(() => {}); return task;
  }
  checkRevision(row, revision) {
    if (row.revision !== revision) throw problem('插件已被其他窗口修改，请重新加载后再保存。', 409);
  }
  save(params) {
    return this.mutate(async () => {
      const definition = normalize(params.plugin), old = params.id ? this.get(params.id) : null;
      if (old && old.kind !== definition.kind) throw problem('不能更改已有插件的类型，请新建插件。');
      if (definition.kind === 'meme-manager' && this.rows().some(p => p.kind === 'meme-manager' && p.id !== old?.id)) throw problem('表情包管理器已安装，请编辑现有插件。', 409);
      if (definition.kind === 'voicestudio' && this.rows().some(p => p.kind === 'voicestudio' && p.id !== old?.id)) throw problem('VoiceStudio 已安装，请编辑现有插件。', 409);
      if (definition.kind === 'group-chat-plus' && this.rows().some(p => p.kind === 'group-chat-plus' && p.id !== old?.id)) throw problem('群聊增强已安装，请编辑现有插件。',409);
      if (old) this.checkRevision(old, params.revision);
      else if (this.rows().length >= MAX_PLUGINS) throw problem('最多安装 32 个插件，请先删除不再使用的插件。');
      await this.run(definition, null, 'validate');
      if (this.closed) throw problem('服务正在关闭。', 409);
      const id = old?.id || randomUUID();
      this.cancel(id);
      this.store.db.prepare(`INSERT INTO plugins (id, definition, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET definition=excluded.definition, revision=plugins.revision+1,
        updated_at=excluded.updated_at, last_error=NULL`).run(id, JSON.stringify(definition), Date.now());
      this.log('info', 'plugin_saved', { plugin: id });
      return this.get(id);
    });
  }
  async install({ kind }) {
    if (!['meme-manager', 'voicestudio','group-chat-plus'].includes(kind)) throw problem('未知内置插件。');
    const existing = kind === 'meme-manager' ? this.findMeme() : kind==='group-chat-plus'?this.findGroupChat():this.findVoice();
    return existing || this.save({ plugin: structuredClone(kind === 'meme-manager' ? memePluginTemplate : kind==='group-chat-plus'?groupChatTemplate:voiceStudioTemplate) });
  }
  findMeme(event) {
    return this.rows().find(p => p.kind === 'meme-manager' && (!event || p.enabled && matches(p, event))) || null;
  }
  findVoice(event) { return this.rows().find(p => p.kind === 'voicestudio' && (!event || p.enabled && matches(p, event))) || null; }
  findGroupChat(event){return this.rows().find(p=>p.kind==='group-chat-plus'&&(!event||p.enabled&&matches(p,event)))||null;}
  toggle({ id, revision, enabled }) {
    return this.mutate(() => {
      const row = this.get(id); this.checkRevision(row, revision);
      if (typeof enabled !== 'boolean') throw problem('启用状态必须为布尔值。');
      if (enabled && !row.scope.all_private && !row.scope.all_groups && !row.scope.private_users.length && !row.scope.groups.length) throw problem('请先设置允许触发的好友或群聊，再启用插件。');
      this.cancel(id);
      this.store.db.prepare('UPDATE plugins SET enabled=?,revision=revision+1,updated_at=? WHERE id=?').run(Number(enabled), Date.now(), id);
      this.log('info', enabled ? 'plugin_enabled' : 'plugin_disabled', { plugin: id });
      return this.get(id);
    });
  }
  remove({ id, revision }) {
    return this.mutate(() => {
      const row = this.get(id); this.checkRevision(row, revision); this.cancel(id);
      this.store.db.prepare('DELETE FROM plugins WHERE id=?').run(id);
      this.log('info', 'plugin_deleted', { plugin: id }); return { removed: true };
    });
  }
  reload({id,revision}){
    return this.mutate(async()=>{
      const row=this.get(id);this.checkRevision(row,revision);
      await this.run(normalize(row),null,'validate');
      if(this.closed)throw problem('服务正在关闭。',409);
      this.cancel(id);
      this.store.db.prepare('UPDATE plugins SET revision=revision+1,updated_at=?,last_error=NULL WHERE id=?').run(Date.now(),id);
      this.log('info','plugin_reloaded',{plugin:id});return this.get(id);
    });
  }
  async test({ plugin, text = '/ping', message_type = 'private', user_id = '10001', group_id = '20001', at = true }) {
    const definition = normalize(plugin);
    boundedText(text, '测试消息', 8000, true);
    if (!['private', 'group'].includes(message_type)) throw problem('测试会话类型无效。');
    ids([user_id]); ids([group_id]);
    const event = { post_type: 'message', message_type, self_id: 10000, user_id: Number(user_id),
      ...(message_type === 'group' ? { group_id: Number(group_id) } : {}), message: [
        ...(message_type === 'group' && at ? [{ type: 'at', data: { qq: '10000' } }] : []),
        { type: 'text', data: { text } }], raw_message: text, time: Math.floor(Date.now() / 1000), message_id: 1 };
    const started = Date.now(), result = await this.run(definition, event, 'test');
    return { simulated: true, scope_matches: matches(definition, event), ...result, duration_ms: Date.now() - started };
  }
  toolName(plugin,tool) { return 'plugin_'+plugin.id.replaceAll('-','').slice(0,24)+'_'+tool.name; }
  agentTools(event,signal) {
    return this.rows().filter(p => p.enabled && matches(p,event,true)).flatMap(p => (p.tools || []).map(tool => ({
      ...tool,name:this.toolName(p,tool),invoke:async args => {
        const current = this.rows().find(row => row.id === p.id);
        if (!current?.enabled || current.revision !== p.revision || !matches(current,event,true)) return {result:{ok:false,error:'插件已停用、更新或移出当前会话范围。'}};
        const result = await this.run(p,event,'tool',{tool:tool.name,arguments:args},signal);
        return {result};
      }
    })));
  }
  run(plugin, event, mode = 'message', extra = {}, signal) {
    if (this.closed) return Promise.reject(problem(pluginErrors.stopped, 409));
    if (signal?.aborted) return Promise.reject(problem(pluginErrors.stopped,409));
    if (plugin.kind === 'meme-manager') return mode === 'validate' ? Promise.resolve(null) : this.memes.handle(plugin, event, { dryRun: mode === 'test' });
    if (plugin.kind === 'voicestudio') return mode === 'validate' ? Promise.resolve(null) : this.voicestudio.handle(plugin, event, { dryRun: mode === 'test' });
    if (plugin.kind === 'group-chat-plus') return mode === 'validate'?Promise.resolve(null):Promise.resolve(this.groupChatPlus.preview(plugin,event));
    if (this.workers.size >= 8) return Promise.reject(problem('插件执行繁忙，请稍后再试。', 409));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./runner.mjs', import.meta.url), {
        workerData: { source: plugin.source, mode, tools:plugin.tools || [], context: event ? { event, text: textOf(event), config: plugin.config, simulated: mode === 'test', ...extra } : null },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
        stdout: true, stderr: true
      });
      worker.stdout.resume(); worker.stderr.resume();
      let settled = false;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort',aborted); this.workers.delete(worker);
        // Wait for termination before releasing callers or the SQLite owner.
        worker.terminate().catch(() => {}).then(() => error ? reject(error) : resolve(result));
      };
      const failed = code => finish(Object.assign(problem(pluginErrors[code] || pluginErrors.runtime_error), { reason: code }));
      const aborted = () => failed('stopped');
      const timer = setTimeout(() => failed('timeout'), plugin.timeout_ms);
      this.workers.set(worker, { id: plugin.id, cancel: () => failed('stopped') });
      signal?.addEventListener('abort',aborted,{once:true});
      worker.once('message', value => value.error ? failed(value.error) : finish(null, value.result));
      worker.once('error', () => failed('runtime_error'));
      worker.once('exit', () => { if (!settled) failed('runtime_error'); });
    });
  }
  cancel(id) { for (const item of this.workers.values()) if (item.id === id) item.cancel();this.groupChatPlus?.cancel(id); }
  enqueue(event, fallback) {
    if (this.closed || event.post_type !== 'message' || String(event.user_id) === String(event.self_id)) return null;
    if (isGroupUserBlocked(event, this.config)) return null;
    const receiptKey = String(event.self_id) + ':' + eventKey(event);
    // A claim survives a crash even when the plugin is subsequently disabled
    // or its scope changes. Never send the same claimed event through AI.
    if (this.store.db.prepare('SELECT 1 FROM plugin_receipts WHERE event_key=?').get(receiptKey)) return { inserted: false };
    const candidates = this.rows().filter(p => p.enabled && matches(p, event));
    const key = conversation(event);
    // Keep a conversation ordered even if a later message matches no plugin.
    const builtinCommand = /^\/(?:tools|工具|new)$|^\/gcp_(?:status|help|pause|resume|reset_here|reset|clear_image_cache|probability)(?:\s|$)/.test(chatText(event));
    if (!candidates.length && !this.tails.has(key) && !builtinCommand) return null;
    if (this.tasks.size >= MAX_QUEUE || Buffer.byteLength(JSON.stringify(event)) > 65536) {
      this.log('warn', 'plugin_queue_full'); return null;
    }
    if (this.store.db.prepare('SELECT 1 FROM jobs WHERE event_key=?').get(eventKey(event))) return { inserted: false };
    const claim = this.store.db.prepare('INSERT OR IGNORE INTO plugin_receipts VALUES (?,?)').run(receiptKey, Date.now());
    if (!claim.changes) return { inserted: false };
    const snapshot = structuredClone(event);
    const task = (this.tails.get(key) || Promise.resolve()).then(async () => {
      let handled = false;
      try { if (!this.closed) handled = await this.process(snapshot, candidates); }
      catch { this.log('error', 'plugin_processing_failed'); }
      if (!this.closed) fallback(handled);
    }).catch(() => this.log('error', 'event_persistence_failed')).finally(() => {
      this.tasks.delete(task); if (this.tails.get(key) === task) this.tails.delete(key);
    });
    this.tasks.add(task); this.tails.set(key, task);
    return { inserted: true };
  }
  async process(event, candidates) {
    if (isGroupUserBlocked(event, this.config)) return false;
    if (isChatCommand(event) && !isChatAdmin(event, this.config)) {
      // Consume denied commands before AI. Reply only inside an existing
      // plugin/AI scope; unrelated groups must not gain a new bot response.
      let inScope = candidates.length > 0;
      try { inScope ||= !!aiInput(event, this.config.ai); } catch {}
      if (inScope) await this.commandReply(event, '此指令仅聊天管理员可用。请在工作台“全部设置 → 回复范围”配置管理员 QQ ID。');
      return true;
    }
    if (chatText(event) === '/new') {
      const cleared = this.store.clearHistoryIfIdle(conversation(event));
      await this.commandReply(event, cleared ? '已开启新对话，当前会话上下文已清空。人格和已保存的记忆继续保留。' :
        '当前会话有排队、执行中或待核对的任务，请处理完成后再发送 /new。');
      return true;
    }
    const plusCommand=this.groupChatPlus?.command(event);
    if(plusCommand!==null&&plusCommand!==undefined){await this.commandReply(event,plusCommand);return true;}
    if (/^\/(?:tools|工具)$/.test(chatText(event))) {
      const available = this.rows().filter(p => p.enabled && matches(p, event));
      const lines = ['聊天指令（仅管理员）：', '/tools 或 /工具：查看本说明', '/new：清空当前会话上下文，开启新对话（保留人格和已保存的记忆）'];
      if (available.some(p => p.kind === 'voicestudio')) lines.push('/vs_status：语音接口状态', '/vs_voices [关键词]：查询音色', '/vs_say 正文：直接发送语音');
      if (available.some(p => p.kind === 'meme-manager')) lines.push('/表情 帮助：表情指令说明', '/表情 分类：查看分类', '/表情 发 分类：发送表情');
      if(available.some(p=>p.kind==='group-chat-plus'))lines.push('/gcp_help：群聊增强管理指令','/gcp_status：群聊增强运行状态');
      const scripts = available.filter(p => p.kind === 'script');
      if (scripts.length) lines.push('自定义插件：' + scripts.map(p => p.name).join('、'));
      await this.commandReply(event, lines.join('\n').slice(0, 2000)); return true;
    }
    for (const original of candidates) {
      if(original.kind==='group-chat-plus')continue;
      if (this.closed) break;
      const plugin = this.rows().find(p => p.id === original.id);
      if (!plugin?.enabled || !matches(plugin, event)) continue;
      let result;
      try {
        result = await this.run(plugin, event);
        const current = this.rows().find(p => p.id === plugin.id);
        if (!current?.enabled || current.revision !== plugin.revision || this.closed) continue;
        if (isChatCommand(event) && !isChatAdmin(event, this.config)) return true;
        this.record(plugin.id, null);
      } catch (error) {
        if (!this.closed) { this.record(plugin.id, error.reason || 'runtime_error'); this.log('warn', 'plugin_execution_failed', { plugin: plugin.id, reason: error.reason || 'runtime_error' }); }
        continue;
      }
      if (result.reply || result.message) {
        try {
          await this.adapter.action(event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg', {
            message: replyMessage(event,[...(result.reply ? [{ type: 'text', data: { text: result.reply } }] : []), ...(result.message || [])],replyOptions(this.config)),
            ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: event.user_id })
          }, { signal: this.controller.signal });
          this.log('info', 'plugin_reply_sent', { plugin: plugin.id });
        } catch (error) {
          const reason = error.uncertain || !error.code ? 'delivery_unknown' : 'send_failed';
          if (!this.closed) {
            this.store.db.prepare('UPDATE plugins SET failures=failures+1,last_error=? WHERE id=?').run(reason, plugin.id);
            this.log('warn', 'plugin_reply_failed', { plugin: plugin.id, reason });
          }
        }
      }
      if (result.handled) return true;
    }
    const groupPlugin=this.findGroupChat(event);
    if(groupPlugin&&this.groupChatPlus){try{const handled=await this.groupChatPlus.handle(event);if(handled)this.record(groupPlugin.id,null);return handled;}
      catch{this.record(groupPlugin.id,'runtime_error');this.log('warn','group_chat_processing_failed');return true;}}
    return false;
  }
  controller = new AbortController();
  async commandReply(event, text) {
    if (this.closed) return;
    try {
      await this.adapter.action(event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg', {
        message: replyMessage(event,[{ type: 'text', data: { text } }],replyOptions(this.config)), ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: event.user_id })
      }, { signal: this.controller.signal });
    } catch { if (!this.closed) this.log('warn', 'chat_command_reply_failed'); }
  }
  record(id, error) {
    this.store.db.prepare('UPDATE plugins SET runs=runs+1,failures=failures+?,last_run=?,last_error=? WHERE id=?').run(Number(!!error), Date.now(), error, id);
  }
  async close() {
    this.closed = true; this.controller.abort();
    for (const item of this.workers.values()) item.cancel();
    await Promise.allSettled([...this.tasks, this.mutations]);
  }
}
