import { mkdir, writeFile, readFile, unlink, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { readImage } from '../qq/kernel/image.mjs';
import { conversation, chatText } from '../messages.mjs';

const defaults = { ai_enabled: true, auto_collect: false, review_required: true,
  send_probability: 1, cooldown_seconds: 30, admin_users: [] };
export const memePluginTemplate = {
  schema: 1, kind: 'meme-manager', name: '表情包管理器', version: '1.0.0',
  description: '本地分类图库、聊天收集审核与去重，支持分类发图和 AI 回复选图。',
  trigger: '', priority: 10, timeout_ms: 10000,
  scope: { private_users: [], groups: [], all_private: false, all_groups: false, require_at: true },
  config: defaults, source: '// 内置表情包引擎；在“表情图库”中管理图片与配置。\n'
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || required && !value.trim()) throw fail(label + '无效。');
  return value.trim();
}
export function memeConfig(value = {}) {
  if (!object(value)) throw fail('表情配置必须是 JSON 对象。');
  const config = { ...defaults, ...value };
  for (const key of ['ai_enabled', 'auto_collect', 'review_required']) if (typeof config[key] !== 'boolean') throw fail('表情开关必须为布尔值。');
  if (!Number.isFinite(config.send_probability) || config.send_probability < 0 || config.send_probability > 1) throw fail('选图概率必须在 0 至 1 之间。');
  if (!Number.isSafeInteger(config.cooldown_seconds) || config.cooldown_seconds < 0 || config.cooldown_seconds > 3600) throw fail('冷却时间必须为 0 至 3600 秒的整数。');
  if (!Array.isArray(config.admin_users) || config.admin_users.length > 100 || config.admin_users.some(id => !/^[1-9]\d{0,15}$/.test(String(id)) || !Number.isSafeInteger(Number(id)))) throw fail('管理好友 QQ 号无效。');
  return Object.fromEntries(Object.keys(defaults).map(key => [key, key === 'admin_users' ? [...new Set(config[key].map(String))] : config[key]]));
}
const seedCategories = [
  ['happy', '开心', '开心、高兴、哈哈、好耶、笑'], ['sad', '难过', '难过、伤心、委屈、哭、失落'],
  ['angry', '生气', '生气、愤怒、气死、可恶'], ['confused', '疑惑', '疑惑、困惑、问号、为什么、迷惑'],
  ['love', '喜欢', '喜欢、爱、抱抱、可爱、感谢'], ['surprised', '惊讶', '惊讶、震惊、居然、没想到'],
  ['tired', '疲惫', '困、累、疲惫、晚安、睡觉'], ['celebrate', '庆祝', '恭喜、庆祝、成功、干杯'],
  ['other', '未分类', '其他表情，等待人工整理']
];
const mime = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// Models often localize punctuation in this otherwise structured marker.
// Use the same bounded grammar for selection, cleanup and the admin preview.
const memeTag = () => /\[\[\s*表情\s*[:：]\s*([^\[\]\r\n]{0,100})\s*\]\]/gu;
const replyTags = value => {
  const tags = [...value.matchAll(memeTag())].map(tag => tag[1].trim()).filter(name => name.length > 0 && name.length <= 30);
  return { tags, cleaned: value.replace(memeTag(), '').trim() };
};
export const textWithoutMemeTags = value => replyTags(value).cleaned;
export function memeReplyIntent(input='') {
  const value=input.trim().replace(/^(?:(?:请|麻烦你?|帮我|给我|替我|现在|直接|再|也|你?能不能|你?能否|可不可以|可以|能)\s*)+/u,'');
  if(!value||/^(?:不要|别|不用|无需|不需要|不想|停止|取消|[`“"「『])/u.test(value))return false;
  return /^(?:发(?:送)?|来)(?:给我)?(?:[^，。！？\n]{0,30})?(?:表情包|表情图|meme)(?:给我|看看|吧|呀|啊|啦|哦|吗|好不好|可以吗|行吗|[。！!？?\s])*$/iu.test(value);
}

export class MemeService {
  constructor({ store, adapter, config, log }) {
    Object.assign(this, { store, adapter, config, log });
    this.root = resolve(config.dataDir, 'memes', 'files');
    this.maxBytes = Math.min(config.media?.maxBytes || 5 * 1024 * 1024, 5 * 1024 * 1024);
    this.controller = new AbortController(); this.closed = false; this.mutations = Promise.resolve();
    this.pluginFor = () => null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS meme_categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meme_images (
      id TEXT PRIMARY KEY, format TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      name TEXT NOT NULL, tags TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, created_at INTEGER NOT NULL, picks INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS meme_images_filter ON meme_images(status,category,created_at);
      CREATE TABLE IF NOT EXISTS meme_rejected (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meme_sessions (id TEXT PRIMARY KEY, last_image TEXT, last_sent INTEGER NOT NULL DEFAULT 0, last_collect INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS meme_reply_plans (job_id INTEGER PRIMARY KEY, image_id TEXT, image_only INTEGER NOT NULL DEFAULT 0);`);
    const add = store.db.prepare('INSERT OR IGNORE INTO meme_categories VALUES (?,?,?,?)');
    for (const category of seedCategories) add.run(...category, Date.now());
  }
  get db() { return this.store.db; }
  serial(fn) {
    const task = this.mutations.then(() => { if (this.closed) throw fail('图库正在关闭。', 409); return fn(); });
    this.mutations = task.catch(() => {}); return task;
  }
  categories() {
    return this.db.prepare(`SELECT c.*,COUNT(CASE WHEN m.status='approved' THEN 1 END) AS count,
      COUNT(CASE WHEN m.status='pending' THEN 1 END) AS pending FROM meme_categories c
      LEFT JOIN meme_images m ON m.category=c.id GROUP BY c.id ORDER BY c.name`).all();
  }
  category(id) {
    const row = this.db.prepare('SELECT * FROM meme_categories WHERE id=? OR name=?').get(String(id || ''), String(id || ''));
    if (!row) throw fail('分类不存在，请刷新后选择。', 404);
    return row;
  }
  saveCategory({ id, name, description = '' }) {
    name = text(name, '分类名称', 30, true); description = text(description, '分类描述', 300);
    if (/[\[\]\r\n]/.test(name)) throw fail('分类名称不能包含方括号或换行。');
    if (id) this.category(id);
    const existing = this.db.prepare('SELECT id FROM meme_categories WHERE name=?').get(name);
    if (existing && existing.id !== id) throw fail('已有同名分类。', 409);
    if (!id && this.categories().length >= 50) throw fail('最多创建 50 个分类。');
    id ||= randomUUID();
    this.db.prepare(`INSERT INTO meme_categories VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,description=excluded.description,updated_at=excluded.updated_at`).run(id, name, description, Date.now());
    return this.category(id);
  }
  deleteCategory({ id }) {
    const row = this.category(id);
    if (row.id === 'other') throw fail('“未分类”是保留分类，不能删除。');
    this.db.exec('SAVEPOINT meme_category');
    try {
      this.db.prepare("UPDATE meme_images SET category='other' WHERE category=?").run(id);
      this.db.prepare('DELETE FROM meme_categories WHERE id=?').run(id);
      this.db.exec('RELEASE meme_category');
    } catch (error) { this.db.exec('ROLLBACK TO meme_category; RELEASE meme_category'); throw error; }
    return { removed: true, images_moved_to: 'other' };
  }
  snapshot(query = {}) {
    const plugin = this.pluginFor(), category = query.category || '', search = text(query.search || '', '搜索词', 100);
    const status = query.status || 'approved', page = Number(query.page || 1);
    if (!['approved', 'pending'].includes(status) || !Number.isSafeInteger(page) || page < 1) throw fail('图库筛选参数无效。');
    const params = [status, category, category, search, '%' + search + '%', '%' + search + '%'];
    const filter = "status=? AND (?='' OR category=?) AND (?='' OR name LIKE ? OR tags LIKE ?)";
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM meme_images WHERE ' + filter).get(...params).n;
    const images = this.db.prepare('SELECT * FROM meme_images WHERE ' + filter + ' ORDER BY created_at DESC,id LIMIT 24 OFFSET ?').all(...params, (page - 1) * 24);
    return { plugin: plugin ? { id: plugin.id, name: plugin.name, enabled: plugin.enabled, revision: plugin.revision, scope: plugin.scope, config: memeConfig(plugin.config) } : null,
      categories: this.categories(), images, total, page, pages: Math.max(1, Math.ceil(total / 24)),
      counts: Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS n FROM meme_images GROUP BY status').all().map(r => [r.status, r.n])),
      max_bytes: this.maxBytes, limit: 2000, ai_ready: this.config.ai.enabled };
  }
  image(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail('表情编号无效。');
    const row = this.db.prepare('SELECT * FROM meme_images WHERE id=?').get(id);
    if (!row) throw fail('表情已删除或不存在。', 404);
    return row;
  }
  async bytes(id) {
    const row = this.image(id), path = join(this.root, row.id + '.' + row.format);
    const [root, actual] = await Promise.all([realpath(this.root), realpath(path)]).catch(() => { throw fail('表情文件不存在，请重新上传。', 404); });
    if (!actual.startsWith(root + sep)) throw fail('表情路径无效。');
    const image = await readImage(actual, { maxBytes: this.maxBytes, signal: this.controller.signal });
    if (createHash('sha256').update(image.bytes).digest('hex') !== id) throw fail('表情文件校验失败，请重新上传。');
    return { row, bytes: image.bytes, mime: mime[row.format] };
  }
  upload({ data, name = '表情', category = 'other', tags = '', status = 'approved', source = 'upload' }) {
    return this.serial(async () => {
      this.category(category); name = text(name, '表情名称', 100, true); tags = text(tags, '表情标签', 300);
      if (!['approved', 'pending'].includes(status) || !['upload', 'chat'].includes(source)) throw fail('表情状态无效。');
      if (source === 'upload' && (typeof data !== 'string' || !/^(?:base64:\/\/|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(data))) throw fail('请选择 PNG、JPEG、GIF 或 WebP 图片。');
      let image;
      try { image = await readImage(data, { maxBytes: this.maxBytes, signal: this.controller.signal }); }
      catch { throw fail('图片内容无效或超过大小限制，请使用 PNG、JPEG、GIF 或 WebP，并检查文件大小。'); }
      const id = createHash('sha256').update(image.bytes).digest('hex');
      const existing = this.db.prepare('SELECT * FROM meme_images WHERE id=?').get(id);
      if (existing) return { duplicate: true, image: existing };
      if (source === 'chat' && this.db.prepare('SELECT 1 FROM meme_rejected WHERE id=?').get(id)) return { rejected: true };
      if (this.db.prepare('SELECT COUNT(*) AS n FROM meme_images').get().n >= 2000) throw fail('图库已满（2000 张），请先整理。', 409);
      if (status === 'pending' && this.db.prepare("SELECT COUNT(*) AS n FROM meme_images WHERE status='pending'").get().n >= 200) throw fail('待审核已达 200 张，请先审核。', 409);
      await mkdir(this.root, { recursive: true });
      this.category(category);
      const path = join(this.root, id + '.' + image.format);
      try { await writeFile(path, image.bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      this.db.prepare('INSERT INTO meme_images (id,format,size,width,height,name,tags,category,status,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, image.format, image.bytes.length, image.width, image.height, name, tags, category, status, source, Date.now());
      this.log('info', status === 'pending' ? 'meme_collected' : 'meme_uploaded', { count: 1 });
      return { duplicate: false, image: this.image(id) };
    });
  }
  edit({ ids, category, name, tags, action = 'edit', ignore = false }) {
    return this.serial(async () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw fail('每次请选择 1 至 100 张表情。');
      const rows = [...new Set(ids)].map(id => this.image(id));
      if (!['edit', 'approve', 'delete'].includes(action)) throw fail('表情操作无效。');
      if (category !== undefined) this.category(category);
      if (name !== undefined) name = text(name, '表情名称', 100, true);
      if (tags !== undefined) tags = text(tags, '表情标签', 300);
      for (const row of rows) {
        if (action === 'delete') {
          if (ignore === true) this.db.prepare('INSERT OR IGNORE INTO meme_rejected VALUES (?,?)').run(row.id, Date.now());
          this.db.prepare('DELETE FROM meme_images WHERE id=?').run(row.id);
          await unlink(join(this.root, row.id + '.' + row.format)).catch(error => { if (error.code !== 'ENOENT') this.log('warn', 'meme_file_cleanup_failed'); });
        } else this.db.prepare('UPDATE meme_images SET category=?,name=?,tags=?,status=? WHERE id=?').run(
          category ?? row.category, name ?? row.name, tags ?? row.tags, action === 'approve' ? 'approved' : row.status, row.id);
      }
      return { count: rows.length };
    });
  }
  select(category, previous) {
    const rows = this.db.prepare("SELECT * FROM meme_images WHERE status='approved' AND category=? ORDER BY picks,created_at LIMIT 100").all(this.category(category).id);
    const candidates = rows.length > 1 ? rows.filter(row => row.id !== previous) : rows;
    return candidates.length ? candidates[randomInt(candidates.length)] : null;
  }
  categoryFor(value) {
    const needle = value.toLowerCase();
    return this.categories().filter(c => c.count > 0 && c.id !== 'other').find(c =>
      needle.includes(c.name.toLowerCase()) || c.description.split(/[、,，\s]+/).some(word => word.length >= 2 && needle.includes(word.toLowerCase())));
  }
  async segment(id) {
    const { bytes } = await this.bytes(id);
    return { type: 'image', data: { file: 'base64://' + bytes.toString('base64') } };
  }
  async collect(event, config, category = 'other', explicit = false) {
    const segments = event.message?.filter(s => s.type === 'image') || [];
    if (!segments.length) return null;
    const key = String(event.self_id) + ':' + conversation(event), now = Date.now();
    const previous = this.db.prepare('SELECT * FROM meme_sessions WHERE id=?').get(key);
    if (!explicit && previous && now - previous.last_collect < 60000) return null;
    this.db.prepare('INSERT INTO meme_sessions(id,last_collect) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET last_collect=excluded.last_collect').run(key, now);
    // Received kernel images are resolved by their cache key. Never fetch an
    // arbitrary image URL supplied by a chat participant from the bot host.
    const file = segments[0].data?.file;
    if (typeof file !== 'string') return null;
    const info = await this.adapter.action('get_image', { file }, { signal: this.controller.signal });
    const result = await this.upload({ data: info.file, name: explicit ? '聊天上传' : '聊天收集', category,
      status: explicit || !config.review_required ? 'approved' : 'pending', source: 'chat' });
    return result;
  }
  async handle(plugin, event, { dryRun = false } = {}) {
    const config = memeConfig(plugin.config), value = event.message.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
    const command = /^\/(?:表情|表情管理)(?:\s+(.*))?$/.exec(value);
    if (!command) {
      if (!dryRun && config.auto_collect) try { await this.collect(event, config, this.categoryFor(value)?.id || 'other'); }
      catch { this.log('warn', 'meme_collection_failed'); }
      return { reply: '', handled: false };
    }
    const input = (command[1] || '帮助').trim(), [verb, ...rest] = input.split(/\s+/), argument = rest.join(' ');
    if (verb === '帮助') return { handled: true, reply: '/表情 分类\n/表情 发 开心\n/表情 搜 关键词\n/表情 添加 开心（附带图片，需管理权限）\n图库和收集审核请使用管理台“表情图库”。' };
    if (['分类', '查看图库'].includes(verb)) return { handled: true, reply: this.categories().map(c => c.name + '：' + c.count + ' 张').join('\n') };
    if (verb === '添加') {
      if (!config.admin_users.includes(String(event.user_id))) return { handled: true, reply: '当前 QQ 号没有聊天上传权限。可在表情图库设置“管理好友 QQ 号”。' };
      let category; try { category = this.category(argument); } catch { return { handled: true, reply: '分类不存在。请使用 /表情 分类 查看分类，并在添加指令的同一条消息附带图片。' }; }
      if (dryRun) return { handled: true, reply: '模拟测试不会保存图片。实际使用请在同一条消息附带图片。' };
      try {
        const result = await this.collect(event, config, category.id, true);
        return { handled: true, reply: !result ? '请在同一条添加指令中附带图片。' : result.duplicate ? '图库中已存在相同图片，没有重复添加。' : '表情已添加到“' + category.name + '”。' };
      } catch { return { handled: true, reply: '图片保存失败，请重发图片或通过管理台上传。' }; }
    }
    let image;
    if (verb === '发') { try { image = this.select(argument); } catch {} }
    else if (verb === '搜' && argument) {
      image = this.db.prepare("SELECT * FROM meme_images WHERE status='approved' AND (name LIKE ? OR tags LIKE ?) ORDER BY picks LIMIT 1").get('%' + argument + '%', '%' + argument + '%');
      if (!image) { const category = this.categoryFor(argument); if (category) image = this.select(category.id); }
    } else return { handled: true, reply: '未知指令。发送 /表情 帮助 查看用法。' };
    if (!image) return { handled: true, reply: '没有找到可用表情，请先上传图片并完成审核。' };
    if (dryRun) return { handled: true, reply: '将发送表情：' + image.name, image_id: image.id };
    const message = [await this.segment(image.id)];
    this.db.prepare('UPDATE meme_images SET picks=picks+1 WHERE id=?').run(image.id);
    return { reply: '', message, handled: true };
  }
  prompt(event) {
    const plugin = this.pluginFor(event); if (!plugin?.enabled || !memeConfig(plugin.config).ai_enabled) return '';
    const categories = this.categories().filter(c => c.count > 0);
    if (!categories.length) return '';
    return '\n\n当前会话已启用表情包插件，可以通过队列发送图库中已审核的真实图片。用户明确要求发表情包时，优先调用当前提供的 meme_reply 工具选择现有分类，配文可留空；未提供此工具时使用下述分类标签。不要声称只能发文字、无法发图或无法发送消息，也不要编造图片内容。以当前工具和图库为准，不沿用历史回复中否认发图能力的说法。\n可选表情分类：' + categories.map(c => c.name + '（' + c.description + '）').join('；') +
      '。普通聊天时可先正常回答；有合适情绪时，可在回复末尾附加一个 [[表情:分类名称]] 标签。仅使用上述已有分类；没有合适表情时不要附加标签。标签由系统转成图片，请勿编造图片 URL 或 CQ 码。';
  }
  requested(event) {
    const plugin=this.pluginFor(event);
    return !!plugin?.enabled&&memeConfig(plugin.config).ai_enabled&&memeReplyIntent(chatText(event));
  }
  plan(jobId) { return this.db.prepare('SELECT * FROM meme_reply_plans WHERE job_id=?').get(jobId); }
  planReply(reply, event, jobId, options={}) {
    const plugin = this.pluginFor(event);
    if (!plugin?.enabled || !memeConfig(plugin.config).ai_enabled) return reply;
    const config = memeConfig(plugin.config), { tags, cleaned } = replyTags(reply);
    const requested=options.requested??this.requested(event);
    const existing=this.plan(jobId);
    if(existing)return existing.image_only?'[表情]':requested&&!existing.image_id?'本次未选出可用表情，请稍后再试。':cleaned||(existing.image_id?'[表情]':'暂时没有合适的表情。');
    let image = null;
    let unavailable='本次未选出可用表情，请换一种表情再试。';
    const key = String(event.self_id) + ':' + conversation(event), session = this.db.prepare('SELECT * FROM meme_sessions WHERE id=?').get(key);
    if (tags.length && (!session || Date.now() - session.last_sent >= config.cooldown_seconds * 1000) && Math.random() < config.send_probability) {
      try { image = this.select(tags[0], session?.last_image); } catch {}
    }
    if(session&&Date.now()-session.last_sent<config.cooldown_seconds*1000)unavailable='表情还在冷却中，请稍后再试。';
    else if(!this.categories().some(category=>category.count>0))unavailable='图库里还没有可用的已审核表情，请先添加图片并完成审核。';
    this.db.prepare('INSERT INTO meme_reply_plans VALUES (?,?,?)').run(jobId, image?.id || null, Number((requested||!cleaned) && !!image));
    if (image) this.db.prepare('UPDATE meme_images SET picks=picks+1 WHERE id=?').run(image.id);
    if(requested)return image?'[表情]':unavailable;
    return cleaned || (image ? '[表情]' : '暂时没有合适的表情。');
  }
  async messageForJob(job, event) {
    const plan = this.db.prepare('SELECT * FROM meme_reply_plans WHERE job_id=?').get(job.id);
    const fallback = [{ type: 'text', data: { text: plan?.image_only?'选中的表情图片已不可用，请换一张再试。':job.reply } }];
    if (!plan?.image_id || !this.pluginFor(event)?.enabled) return fallback;
    try {
      if (this.image(plan.image_id).status !== 'approved') return fallback;
      const image = await this.segment(plan.image_id);
      return [...(plan.image_only ? [] : fallback), image];
    } catch { return fallback; }
  }
  sent(job, event) {
    const plan = this.db.prepare('SELECT * FROM meme_reply_plans WHERE job_id=?').get(job.id);
    if (plan?.image_id) this.db.prepare(`INSERT INTO meme_sessions(id,last_image,last_sent) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_image=excluded.last_image,last_sent=excluded.last_sent`).run(String(event.self_id) + ':' + conversation(event), plan.image_id, Date.now());
  }
  preview({ text: value = '' }) {
    value = text(value, '预览文本', 2000, true);
    const { tags, cleaned } = replyTags(value);
    let category; try { category = tags.length ? this.category(tags[0]) : this.categoryFor(value); } catch {}
    const image = category ? this.select(category.id) : null;
    return { simulated: true, image, category: category?.name || null, text: cleaned };
  }
  cleanup() {
    this.db.exec("DELETE FROM meme_reply_plans WHERE job_id NOT IN (SELECT id FROM jobs WHERE status IN ('ready','sending','uncertain'))");
    this.db.prepare('DELETE FROM meme_sessions WHERE MAX(last_sent,last_collect)<?').run(Date.now() - 7 * 86400000);
  }
  async close() { this.closed = true; this.controller.abort(); await this.mutations; }
}
