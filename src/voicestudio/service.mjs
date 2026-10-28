import { mkdir, readFile, writeFile, readdir, unlink, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { wavToPCM } from '../qq/kernel/audio-codec.mjs';
import { chatCommandAllowed, chatText } from '../messages.mjs';
import { textWithoutMemeTags } from '../memes/service.mjs';
import { filterAIReply } from '../reply-filter.mjs';

const fail = message => Object.assign(new Error(message), { status: 400, retryable: false });
const defaults = { base_url: 'http://127.0.0.1:3900', api_key: '', model: 'tts-1', voice: 'default',
  language: '', speed: 1, timeout_seconds: 180, max_text_chars: 1000, ai_tools: true, reply_probability: 0 };
export const voiceStudioTemplate = { schema: 1, kind: 'voicestudio', name: '本地 VoiceStudio', version: '1.0.0',
  description: '模型可调用本地语音工具，也可按概率将 AI 文字回复转换为 QQ 语音。', trigger: '', priority: 20, timeout_ms: 10000,
  source: '// 内置 VoiceStudio 引擎；配置音色、服务地址及允许会话后启用。\n', config: defaults,
  scope: { private_users: [], groups: [], all_private: false, all_groups: false, require_at: true } };
function str(value, name, max = 300, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || required && !value.trim()) throw fail(name + '无效或超出长度限制。');
  return value.trim();
}
export function voiceStudioConfig(value = {}) {
  const c = { ...defaults, ...value }; let url;
  try { url = new URL(c.base_url); } catch { throw fail('VoiceStudio 地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.port === '0') throw fail('VoiceStudio 地址应为无账号密码或查询参数的 HTTP(S) 地址。');
  c.base_url = url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
  for (const key of ['api_key','model','voice','language']) c[key] = str(c[key], key, key === 'api_key' ? 4096 : key === 'language' ? 30 : 300);
  if (/[\r\n]/.test(c.api_key)) throw fail('API Key 不能包含换行。');
  if (!Number.isFinite(c.reply_probability) || c.reply_probability < 0 || c.reply_probability > 1) throw fail('语音输出概率必须在 0 至 1 之间。');
  if (!c.model || !c.voice || !Number.isFinite(c.speed) || c.speed < .25 || c.speed > 4 ||
      !Number.isSafeInteger(c.timeout_seconds) || c.timeout_seconds < 1 || c.timeout_seconds > 600 ||
      !Number.isSafeInteger(c.max_text_chars) || c.max_text_chars < 1 || c.max_text_chars > 2000 || typeof c.ai_tools !== 'boolean') throw fail('VoiceStudio 模型、音色、语速、超时或文字上限配置无效。');
  return Object.fromEntries(Object.keys(defaults).map(key => [key, c[key]]));
}
export const voiceStudioTools = [
  { type: 'function', function: { name: 'voicestudio_list_voices', description: '查询本地 VoiceStudio 已保存音色和引擎。需要选择声音时先查询 voice_id。',
    parameters: { type: 'object', properties: { keyword: { type: 'string', description: '按音色名称、ID 或语言筛选；留空查询全部。' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'voicestudio_speak', description: '用户要求语音、朗读或配音时，将正文交给本地 VoiceStudio 合成并作为本次 QQ 语音回复。仅传需要朗读的正文；成功后停止重复调用。',
    parameters: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string', description: '留空或 default 使用插件设置的默认音色；仅在用户指定其他声音时传查询得到的 voice_id。' },
      speed: { type: 'number', description: '0 使用配置；其余 .25–4。' }, instruct: { type: 'string', description: '可选语气提示，效果取决于引擎。' }, language: { type: 'string' } }, required: ['text'], additionalProperties: false } } }
];

// Only the latest user's direct request selects a required tool. Quoted code,
// discussions of TTS and negative requests keep ordinary model routing.
export function voiceStudioIntent(input = '') {
  const value = input.trim().replace(/^(?:(?:请|麻烦你?|帮我|替我|给我|你|现在|目前|试着|试试|再|也|直接)\s*)+/u, '');
  if (!value || /^(?:不要|别|不用|无需|不需要|不想|停止|取消)/u.test(value) || /^[`“"「『]/u.test(value)) return null;
  if (/^(?:能不能|能否|可不可以|能|可以|会|支持|是否支持|有没有|有)(?:调用|使用|用|发|发送|生成|合成)?(?:语音|声音|朗读|配音)(?:功能|工具)?(?:吗|么|嘛|不)?[？?。!！]*$/u.test(value)) return null;
  if (/^(?:(?:能不能|能否|可不可以|可以|能)\s*)?(?:(?:用|以)(?:语音|声音)(?:给我|帮我)?(?:说|读|念|回答|回复|讲|播报)|语音(?:回答|回复|朗读|说|读|念)|(?:发|发送|来)(?:一?[条段个])?语音|朗读|读出来|念出来|念给我听|配音)/u.test(value) ||
      /^(?:please\s+)?(?:speak\b|(?:reply|respond|answer)\s+(?:by|with|in)\s+(?:a\s+)?voice\b|read\s+(?:this|it)\s+aloud\b)/iu.test(value)) return 'voicestudio_speak';
  return null;
}

export class VoiceStudioService {
  constructor({ store, config, log, random = Math.random }) {
    Object.assign(this, { store, config, log, random }); this.pluginFor = () => null;
    this.root = resolve(config.dataDir, 'voicestudio'); this.controller = new AbortController(); this.tail = Promise.resolve();
    this.maxBytes = Math.min(config.media?.maxBytes || 10485760, 10485760);
    store.db.exec(`CREATE TABLE IF NOT EXISTS voicestudio_jobs(job_id INTEGER PRIMARY KEY, state TEXT NOT NULL,
      file TEXT, bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS voicestudio_reply_decisions(job_id INTEGER PRIMARY KEY,
        selected INTEGER NOT NULL, created_at INTEGER NOT NULL);
      UPDATE voicestudio_jobs SET state='uncertain' WHERE state='generating';`);
  }
  async request(config, path, payload, signal, limit = 1048576) {
    const deadline = AbortSignal.timeout(payload ? config.timeout_seconds * 1000 : Math.min(15000, config.timeout_seconds * 1000));
    const combined = AbortSignal.any([deadline, this.controller.signal, ...(signal ? [signal] : [])]);
    let response;
    try { response = await fetch(config.base_url + path, { method: payload ? 'POST' : 'GET', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(config.api_key ? { Authorization: 'Bearer ' + config.api_key } : {}) },
      body: payload ? JSON.stringify(payload) : undefined, signal: combined }); }
    catch { throw fail(combined.aborted ? 'VoiceStudio 请求已取消或超时；不会自动重复生成。' : '无法连接 VoiceStudio，请确认本地服务已启动。'); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail('VoiceStudio HTTP ' + response.status + '，请检查引擎、音色、许可或 API Key。'); }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fail('VoiceStudio 返回内容超过大小限制。'); }
    const chunks = []; let size = 0;
    try { for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw fail('VoiceStudio 返回内容超过大小限制。'); chunks.push(chunk); } }
    catch (error) { if (error.status) throw error; throw fail('VoiceStudio 响应读取失败或超时，不会自动重复生成。'); }
    return Buffer.concat(chunks, size);
  }
  async voices(plugin, keyword = '', signal, savedOnly = false) {
    keyword = str(keyword, '音色筛选词', 100).toLowerCase(); let result;
    const bytes = await this.request(voiceStudioConfig(plugin.config), '/v1/audio/voices', null, signal);
    try { result = JSON.parse(bytes.toString('utf8')); } catch { throw fail('VoiceStudio 没有返回有效音色列表。'); }
    if (!Array.isArray(result.voices)) throw fail('VoiceStudio 音色列表格式不兼容。');
    const all = result.voices.filter(v => v && typeof v === 'object').map(v => Object.fromEntries(['voice_id','name','language','type'].filter(k => typeof v[k] === 'string').map(k => [k, v[k].slice(0, 300)])))
      .filter(v => (!savedOnly || v.type === 'profile') && (!keyword || Object.values(v).join(' ').toLowerCase().includes(keyword)));
    return { ok: true, voices: all.slice(0, 50), total: all.length, engines: (Array.isArray(result.engines) ? result.engines : []).slice(0, 20).map(e => ({ id: e.id, available: e.available === true })) };
  }
  async synthesize(plugin, args, signal) {
    const c = voiceStudioConfig(plugin.config), input = str(args.text, '朗读正文', c.max_text_chars, true);
    const rate = args.speed === undefined || args.speed === 0 ? c.speed : args.speed;
    if (!Number.isFinite(rate) || rate < .25 || rate > 4) throw fail('语速必须为 0 或 .25–4。');
    const requestedVoice = str(args.voice ?? '', '音色');
    const payload = { model: c.model, input, voice: !requestedVoice || requestedVoice === 'default' ? c.voice : requestedVoice,
      speed: rate, response_format: 'wav' };
    const language = str(args.language ?? '', '语言', 30) || c.language, instruct = str(args.instruct ?? '', '风格指令', 1000);
    if (language) payload.language = language; if (instruct) payload.instruct = instruct;
    // The configured deadline also covers waiting for our local synthesis lock.
    const waiting = AbortSignal.any([AbortSignal.timeout(c.timeout_seconds * 1000), this.controller.signal, ...(signal ? [signal] : [])]);
    const task = this.tail.then(async () => {
      waiting.throwIfAborted();
      const bytes = await this.request(c, '/v1/audio/speech', payload, waiting, this.maxBytes);
      try { wavToPCM(bytes); } catch { throw fail('VoiceStudio 返回的不是可发送的 PCM/float WAV。请使用支持 WAV 输出的本地引擎。'); }
      await mkdir(this.root, { recursive: true });
      const files = await readdir(this.root, { withFileTypes: true });
      let total = 0;
      for (const item of files) if (item.isFile() && /^[a-f0-9]{64}\.wav$/.test(item.name)) total += (await stat(join(this.root, item.name))).size;
      if (total + bytes.length > 200 * 1048576) throw fail('VoiceStudio 本地音频缓存已满，请清理已过期任务。');
      const file = createHash('sha256').update(bytes).digest('hex') + '.wav';
      try { await writeFile(join(this.root, file), bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      return { file, bytes: bytes.length, text: input };
    });
    this.tail = task.catch(() => {});
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(fail('VoiceStudio 等待已取消或超时，不会自动重复生成。'));
      if (waiting.aborted) abort(); else waiting.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([task, cancelled]); }
    finally { waiting.removeEventListener('abort', abort); }
  }
  plan(jobId) { return this.store.db.prepare('SELECT * FROM voicestudio_jobs WHERE job_id=?').get(jobId); }
  replyDecision(jobId) { return this.store.db.prepare('SELECT * FROM voicestudio_reply_decisions WHERE job_id=?').get(jobId); }
  cachedReply(job) {
    const plan = this.plan(job.id);
    if (this.replyDecision(job.id)) return job.reply;
    return !plan ? null : plan.state === 'ready' ? job.reply || '语音回复' : '上次语音生成结果未确认，为避免重复生成，本次不再自动调用。请稍后重新发起请求。';
  }
  async prepareSpeech(plugin, job, args, signal, fallback) {
    if (this.plan(job.id)) return { finish: true, reply: this.cachedReply(this.store.get(job.id)) };
    const input=filterAIReply(str(args.text,'朗读正文',voiceStudioConfig(plugin.config).max_text_chars,true),this.config);
    if(!input.trim())return {finish:true,reply:''};
    args={...args,text:input};
    if(fallback!==undefined)fallback=filterAIReply(fallback,this.config);
    this.store.db.prepare("INSERT INTO voicestudio_jobs(job_id,state,created_at) VALUES (?,'generating',?)").run(job.id, Date.now());
    this.store.update(job.id, 'generating', { reply: fallback ?? input });
    try {
      const audio = await this.synthesize(plugin, args, signal);
      this.store.db.prepare("UPDATE voicestudio_jobs SET state='ready',file=?,bytes=? WHERE job_id=?").run(audio.file, audio.bytes, job.id);
      this.store.update(job.id, 'generating', { reply: input });
      this.log('info', 'voicestudio_audio_prepared', { job: job.id });
      return { finish: true, reply: input };
    } catch (error) {
      this.store.db.prepare("UPDATE voicestudio_jobs SET state='uncertain' WHERE job_id=?").run(job.id);
      this.log('warn', 'voicestudio_generation_failed', { job: job.id });
      return { finish: true, reply: fallback ?? (error.status ? error.message : '本地语音生成失败，未发送语音。') };
    }
  }
  async maybeSpeakReply(job, event, reply, signal) {
    if (job.channel === 'web' || this.plan(job.id) || this.replyDecision(job.id)) return reply;
    const plugin = this.pluginFor(event);
    if (!plugin?.enabled || !chatCommandAllowed(event, this.config)) return reply;
    const config = voiceStudioConfig(plugin.config), text = textWithoutMemeTags(reply);
    // Explicit text-only requests retain their delivery format. The model
    // cannot override this by suggesting a voice in its generated answer.
    const textOnly = /(?:只(?:用|要|需|发|输出)?\s*(?:文字|文本)|(?:用|以)(?:文字|文本)(?:回答|回复)|(?:不要|别|不用|无需|不需要).{0,8}(?:语音|朗读)|(?:text[ -]only|(?:reply|respond|answer)\s+(?:in|with)\s+text|(?:no|without)\s+(?:audio|voice)))/iu.test(chatText(event));
    const eligible = text && text.length <= config.max_text_chars && !textOnly;
    const selected = !!eligible && config.reply_probability > 0 && (config.reply_probability === 1 || this.random() < config.reply_probability);
    // Persist the original reply and the decision together, before TTS I/O.
    // Restart and send retries must neither regenerate nor reroll this reply.
    this.store.db.exec('SAVEPOINT voicestudio_reply_decision');
    try {
      this.store.update(job.id, 'generating', { reply });
      this.store.db.prepare('INSERT INTO voicestudio_reply_decisions VALUES (?,?,?)').run(job.id, Number(selected), Date.now());
      this.store.db.exec('RELEASE voicestudio_reply_decision');
    } catch (error) { this.store.db.exec('ROLLBACK TO voicestudio_reply_decision; RELEASE voicestudio_reply_decision'); throw error; }
    if (!selected) return reply;
    this.log('info', 'voicestudio_auto_reply_selected', { job: job.id });
    try { return (await this.prepareSpeech(plugin, job, { text }, signal, reply)).reply; }
    catch { this.log('warn', 'voicestudio_generation_failed', { job: job.id }); return reply; }
  }
  prompt(event) {
    const plugin = this.pluginFor(event);
    if (!plugin?.enabled || !voiceStudioConfig(plugin.config).ai_tools || !chatCommandAllowed(event, this.config)) return '';
    return '\n\n当前会话已启用本地 VoiceStudio 工具：voicestudio_list_voices 查询音色，voicestudio_speak 合成并发送 QQ 语音。' +
      '插件默认音色 ID 为 ' + JSON.stringify(voiceStudioConfig(plugin.config).voice) + '；用户未指定其他音色时，voice 参数留空或使用 default，沿用此默认音色。' +
      '用户要求语音、朗读或配音时应实际调用工具；不要声称没有语音功能，也不要只输出函数名或调用代码。' +
      '仅以当前提供的工具定义为准，历史消息中关于工具能力的说法可能已过时；不要复述历史中“只有浏览器/搜索”或“没有语音”的说法。' +
      '角色语气只用于措辞，不能代替执行明确的工具请求。合成是否成功以工具返回为准，不能仅凭音色列表断言模型已就绪。';
  }
  buffersReply(event) {
    const plugin=this.pluginFor(event);
    return !!plugin?.enabled && (voiceStudioConfig(plugin.config).reply_probability>0 || !!voiceStudioIntent(chatText(event)));
  }
  options(event, job, signal) {
    const plugin = this.pluginFor(event);
    if (!plugin?.enabled || !voiceStudioConfig(plugin.config).ai_tools || !chatCommandAllowed(event, this.config)) return {};
    const input = event.message?.filter(s => s.type === 'text').map(s => s.data?.text || '').join('') || '';
    const required = voiceStudioIntent(input);
    return { tools: voiceStudioTools, ...(required ? { requiredTool: required } : {}), invokeTool: async (name, args) => {
      const current = this.pluginFor(event);
      if (!current?.enabled || current.revision !== plugin.revision || !chatCommandAllowed(event, this.config)) return { result: { ok: false, error: 'VoiceStudio 插件已停用、配置已变化或指令权限已撤销。' } };
      this.log('info', 'voicestudio_tool_called', { job: job.id });
      if (name === 'voicestudio_list_voices') {
        try { return { result: await this.voices(plugin, args.keyword || '', signal) }; }
        catch (error) { return { result: { ok: false, error: error.message } }; }
      }
      if (name !== 'voicestudio_speak') return { result: { ok: false, error: '未知工具。' } };
      return this.prepareSpeech(plugin, job, args, signal);
    } };
  }
  async messageForJob(job, event) {
    const plan = this.plan(job.id); if (plan?.state !== 'ready') return null;
    if (!this.pluginFor(event)?.enabled) return [{ type: 'text', data: { text: job.reply } }];
    if (!/^[a-f0-9]{64}\.wav$/.test(plan.file || '')) throw fail('缓存语音编号无效。');
    const root = await realpath(this.root), file = await realpath(join(this.root, plan.file));
    if (!file.startsWith(root + sep)) throw fail('缓存语音路径无效。');
    const bytes = await readFile(file);
    if (bytes.length > this.maxBytes || createHash('sha256').update(bytes).digest('hex') + '.wav' !== plan.file) throw fail('缓存语音校验失败。');
    return [{ type: 'record', data: { file: 'base64://' + bytes.toString('base64') } }];
  }
  async handle(plugin, event, { dryRun = false } = {}) {
    const input = event.message.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
    const match = /^\/(vs_say|本地语音|vs_voices|本地音色|vs_status|本地语音状态)(?:\s+([\s\S]*))?$/.exec(input);
    if (!match) return { handled: false, reply: '' };
    if (dryRun) return { handled: true, reply: 'VoiceStudio 模拟测试不调用合成或发送接口。实际可使用 /vs_status、/vs_voices、/vs_say 文本。' };
    try {
      if (['vs_say','本地语音'].includes(match[1])) {
        if (!match[2]) return { handled: true, reply: '用法：/vs_say 需要朗读的正文' };
        const audio = await this.synthesize(plugin, { text: match[2] }, this.controller.signal);
        const bytes = await readFile(join(this.root, audio.file));
        return { handled: true, reply: '', message: [{ type: 'record', data: { file: 'base64://' + bytes.toString('base64') } }] };
      }
      const result = await this.voices(plugin, match[2] || '');
      return { handled: true, reply: (match[1].includes('status') || match[1].includes('状态') ? 'VoiceStudio 接口可用。\n' : '') +
        result.voices.slice(0, 20).map(v => (v.name || v.voice_id) + ' · ' + v.voice_id).join('\n') + '\n引擎：' + result.engines.filter(e => e.available).map(e => e.id).join('、') };
    } catch (error) { return { handled: true, reply: error.status ? error.message : 'VoiceStudio 调用失败，请检查本地服务。' }; }
  }
  async cleanup() {
    this.store.db.prepare('DELETE FROM voicestudio_reply_decisions WHERE job_id NOT IN (SELECT id FROM jobs)').run();
    const stale = this.store.db.prepare("SELECT * FROM voicestudio_jobs WHERE job_id NOT IN (SELECT id FROM jobs WHERE status NOT IN ('ignored','done','failed') OR updated_at>?)").all(Date.now() - 86400000);
    for (const row of stale) this.store.db.prepare('DELETE FROM voicestudio_jobs WHERE job_id=?').run(row.job_id);
    await mkdir(this.root, { recursive: true });
    const protectedFiles = new Set(this.store.db.prepare('SELECT file FROM voicestudio_jobs WHERE file IS NOT NULL').all().map(r => r.file));
    for (const file of await readdir(this.root)) if (/^[a-f0-9]{64}\.wav$/.test(file) && !protectedFiles.has(file) && (await stat(join(this.root, file))).mtimeMs < Date.now() - 86400000) await unlink(join(this.root, file));
  }
  async close() { this.controller.abort(); await this.tail; }
}
