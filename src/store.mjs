import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { conversation, eventKey } from './messages.mjs';

const eventIdentity = (event,contentState='not_stored') => ({...Object.fromEntries(
  ['self_id','post_type','message_type','sub_type','message_id','user_id','group_id','time']
    .filter(key=>['string','number','boolean'].includes(typeof event[key])).map(key=>[key,event[key]])),content_retained:false,content_state:contentState});

export class Store extends EventEmitter {
  constructor(path, { retainIgnoredContent = false, onRedaction = () => {} } = {}) {
    super();
    this.retainIgnoredContent=retainIgnoredContent;
    this.onRedaction=onRedaction;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
        event TEXT NOT NULL, input TEXT, reply TEXT, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, send_attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, next_at, id);
      CREATE INDEX IF NOT EXISTS jobs_conversation ON jobs(conversation,id);
      CREATE INDEX IF NOT EXISTS jobs_conversation_pending ON jobs(conversation,id)
        WHERE status IN ('queued','generating','ready','sending');
      CREATE INDEX IF NOT EXISTS jobs_uncertain_age ON jobs(updated_at) WHERE status='uncertain';
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reply_stream_parts (
        job_id INTEGER NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, message_id INTEGER, PRIMARY KEY(job_id,part)
      );
      CREATE INDEX IF NOT EXISTS history_conversation ON history(conversation, id);
      CREATE TABLE IF NOT EXISTS group_context_messages (
        id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, message_id TEXT NOT NULL,
        content TEXT NOT NULL, received_at INTEGER NOT NULL, UNIQUE(conversation,message_id)
      );
      CREATE INDEX IF NOT EXISTS group_context_age ON group_context_messages(received_at);
      CREATE TABLE IF NOT EXISTS group_chat_jobs (
        job_id INTEGER PRIMARY KEY, plugin_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
        data TEXT NOT NULL, approved INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_chat_state (conversation TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_chat_images (digest TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,conversation TEXT NOT NULL,model TEXT NOT NULL,caption TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS privacy_audit (
        id INTEGER PRIMARY KEY, action TEXT NOT NULL, count INTEGER NOT NULL,
        reason TEXT NOT NULL, created_at INTEGER NOT NULL
      );`);
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'send_attempts')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0');
    }
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'channel')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN channel TEXT NOT NULL DEFAULT 'qq'");
    }
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'context_input')) this.db.exec('ALTER TABLE jobs ADD COLUMN context_input TEXT');
    if(!this.retainIgnoredContent)this.redactIgnored('startup');
  }
  recover() {
    this.db.prepare("UPDATE jobs SET status='uncertain',reason='stream_delivery_unknown',updated_at=? WHERE status='generating' AND EXISTS (SELECT 1 FROM reply_stream_parts p WHERE p.job_id=jobs.id AND p.status IN ('sending','uncertain'))").run(Date.now());
    this.db.prepare("UPDATE jobs SET status='failed',reason='stream_interrupted',updated_at=? WHERE status='generating' AND EXISTS (SELECT 1 FROM reply_stream_parts p WHERE p.job_id=jobs.id)").run(Date.now());
    this.db.prepare("UPDATE jobs SET status='queued', reason='recovered_generation' WHERE status='generating'").run();
    this.db.prepare("UPDATE jobs SET status='uncertain', reason='process_stopped_during_send', updated_at=? WHERE status='sending'").run(Date.now());
    this.emit('change');
  }
  ingest(event, input, maxPending, reason = null, webSession = null, options = {}) {
    const count = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','generating','ready','sending','uncertain')").get().n;
    const state = input && count < maxPending ? 'queued' : 'ignored';
    const why = reason || (input && count >= maxPending ? 'queue_full' : input ? null : 'filtered');
    const now = Date.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO jobs
      (event_key, conversation, event, input, status, reason, created_at, updated_at,channel) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(options.eventKey || (webSession ? 'web:'+webSession+':'+event.message_id : eventKey(event)), webSession ? 'web:'+webSession : conversation(event), JSON.stringify(state==='ignored'&&!this.retainIgnoredContent?eventIdentity(event):event),
        state==='ignored'&&!this.retainIgnoredContent?null:input, state, why, now, now,webSession?'web':'qq');
    if (result.changes) this.emit('change');
    return { inserted: result.changes > 0, status: state, id: Number(result.lastInsertRowid) };
  }
  next(webOnly = false) {
    return this.db.prepare(`SELECT * FROM jobs j WHERE j.status IN ('queued','ready') AND j.next_at<=? AND (?=0 OR j.channel='web')
      AND NOT EXISTS (SELECT 1 FROM jobs older WHERE older.conversation=j.conversation AND older.id<j.id
        AND older.status IN ('queued','generating','ready','sending')) ORDER BY j.id LIMIT 1`).get(Date.now(),Number(webOnly));
  }
  nextTime(webOnly = false) {
    // Only conversation heads are eligible. An older active job wakes the
    // worker when it completes; it must not create a zero-delay polling loop.
    return this.db.prepare(`SELECT MIN(j.next_at) AS time FROM jobs j WHERE j.status IN ('queued','ready') AND (?=0 OR j.channel='web')
      AND NOT EXISTS (SELECT 1 FROM jobs older WHERE older.conversation=j.conversation AND older.id<j.id
        AND older.status IN ('queued','generating','ready','sending'))`).get(Number(webOnly)).time;
  }
  nextExpiryTime(maxAge) {
    const created=this.db.prepare("SELECT MIN(created_at) AS time FROM jobs WHERE status IN ('queued','ready')").get().time;
    return created===null?null:created+maxAge;
  }
  expirePending(maxAge) {
    const now=Date.now();
    const result=this.db.prepare("UPDATE jobs SET status='failed',reason='expired',next_at=0,updated_at=? WHERE status IN ('queued','ready') AND created_at<=?")
      .run(now,now-maxAge);
    if(result.changes)this.emit('change');
    return Number(result.changes);
  }
  privacyStatus() {
    return {total:Number(this.db.prepare('SELECT COALESCE(SUM(count),0) AS total FROM privacy_audit').get().total),
      records:this.db.prepare('SELECT id,action,count,reason,created_at FROM privacy_audit ORDER BY id DESC LIMIT 10').all()};
  }
  recordRedaction(count,reason){
    this.db.prepare('INSERT INTO privacy_audit(action,count,reason,created_at) VALUES (?,?,?,?)')
      .run('ignored_job_content_redacted',Number(count),reason,Date.now());
  }
  redactIgnored(source='retention') {
    // Keep identity fields for review. Deduplication uses event_key and does
    // not require message bodies, sender names, attachments, input or reply.
    this.db.exec('SAVEPOINT privacy_redaction');let count;
    try{count=Number(this.db.prepare(`UPDATE jobs SET input=NULL,reply=NULL,context_input=NULL,event=CASE WHEN json_valid(event) THEN
      json_object('self_id',json_extract(event,'$.self_id'),'post_type',json_extract(event,'$.post_type'),
        'message_type',json_extract(event,'$.message_type'),'sub_type',json_extract(event,'$.sub_type'),
        'message_id',json_extract(event,'$.message_id'),'user_id',json_extract(event,'$.user_id'),
        'group_id',json_extract(event,'$.group_id'),'time',json_extract(event,'$.time'),
        'content_retained',json('false'),'content_state','redacted')
      ELSE '{"content_retained":false,"content_state":"redacted"}' END
      WHERE status='ignored' AND (input IS NOT NULL OR reply IS NOT NULL OR context_input IS NOT NULL OR
        CASE WHEN json_valid(event) THEN COALESCE(json_extract(event,'$.content_retained'),1) != 0 OR
          EXISTS(SELECT 1 FROM json_each(jobs.event) WHERE key NOT IN
            ('self_id','post_type','message_type','sub_type','message_id','user_id','group_id','time','content_retained','content_state'))
          ELSE 1 END)`)
      .run().changes);
      if(count)this.recordRedaction(count,source);
      this.db.exec("DELETE FROM reply_stream_parts WHERE job_id IN (SELECT id FROM jobs WHERE status='ignored')");
      this.db.exec('RELEASE privacy_redaction');
    }catch(error){this.db.exec('ROLLBACK TO privacy_redaction; RELEASE privacy_redaction');throw error;}
    if(count)this.onRedaction({count,reason:source});
    return count;
  }
  update(id, status, { reply, attempts, sendAttempts, nextAt = 0, reason = null } = {}) {
    const omit=status==='ignored'&&!this.retainIgnoredContent;
    let savedEvent=null,redacted=false;
    if(omit){const row=this.get(id);if(row){let original={};try{original=JSON.parse(row.event);}catch{}
      redacted=original.content_retained!==false||row.input!==null||row.reply!==null;
      savedEvent=JSON.stringify(eventIdentity(original,redacted?'redacted':original.content_state||'unavailable'));}}
    if(omit)this.db.exec('SAVEPOINT privacy_redaction');
    try{this.db.prepare(`UPDATE jobs SET status=?,event=COALESCE(?,event),input=CASE WHEN ? THEN NULL ELSE input END,
      reply=CASE WHEN ? THEN NULL ELSE COALESCE(?,reply) END, context_input=CASE WHEN ? THEN NULL ELSE context_input END, attempts=COALESCE(?,attempts),
      send_attempts=COALESCE(?,send_attempts), next_at=?, reason=?, updated_at=? WHERE id=?`)
      .run(status,savedEvent,Number(omit),Number(omit),reply??null,Number(omit),attempts??null,sendAttempts??null,nextAt,reason,Date.now(),id);
      if(redacted)this.recordRedaction(1,'policy_changed');
      if(omit)this.db.prepare('DELETE FROM reply_stream_parts WHERE job_id=?').run(id);
      if(omit)this.db.exec('RELEASE privacy_redaction');
    }catch(error){if(omit)this.db.exec('ROLLBACK TO privacy_redaction; RELEASE privacy_redaction');throw error;}
    if(redacted)this.onRedaction({count:1,reason:'policy_changed'});
    this.emit('change');
  }
  finish(job, turns) {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.update(job.id, 'done');
      const add = this.db.prepare('INSERT INTO history(conversation,role,content,created_at) VALUES (?,?,?,?)');
      add.run(job.conversation, 'user', job.context_input || job.input, now);
      add.run(job.conversation, 'assistant', job.reply, now);
      this.db.prepare(`DELETE FROM history WHERE conversation=? AND id NOT IN
        (SELECT id FROM history WHERE conversation=? ORDER BY id DESC LIMIT ?)`)
        .run(job.conversation, job.conversation, turns * 2);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(session, turns) {
    return this.db.prepare(`SELECT role,content FROM (SELECT id,role,content FROM history WHERE conversation=?
      ORDER BY id DESC LIMIT ?) ORDER BY id`).all(session, turns * 2).map(row => ({ ...row }));
  }
  clearHistoryIfIdle(session) {
    // No await between checking jobs and clearing history: an older reply
    // must not finish afterwards and reintroduce the previous conversation.
    if (this.db.prepare("SELECT 1 FROM jobs WHERE conversation=? AND status IN ('queued','generating','ready','sending','uncertain') LIMIT 1").get(session)) return false;
    this.clearConversationContext(session);
    return true;
  }
  clearConversationContext(session) {
    this.db.exec('SAVEPOINT conversation_context_reset');
    try {
      this.db.prepare('DELETE FROM history WHERE conversation=?').run(session);
      this.db.prepare('DELETE FROM group_context_messages WHERE conversation=?').run(session);
      this.db.prepare('DELETE FROM group_chat_state WHERE conversation=?').run(session);
      this.db.exec('RELEASE conversation_context_reset');
    } catch(error) { this.db.exec('ROLLBACK TO conversation_context_reset; RELEASE conversation_context_reset'); throw error; }
    this.emit('context_reset',session);
  }
  summary() {
    return Object.fromEntries(this.db.prepare('SELECT status,count(*) AS n FROM jobs GROUP BY status').all().map(row => [row.status, row.n]));
  }
  list(limit = 50, session = null) {
    return this.db.prepare('SELECT id,conversation,status,attempts,send_attempts,next_at,reason,created_at,updated_at FROM jobs'+
      (session?' WHERE conversation=?':'')+' ORDER BY id DESC LIMIT ?').all(...(session?[session]:[]),limit);
  }
  jobConversations() {
    return this.db.prepare('SELECT DISTINCT conversation FROM jobs ORDER BY conversation').all().map(row=>row.conversation);
  }
  get(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  streamText(id, text) {
    this.db.prepare("UPDATE jobs SET reply=?,updated_at=? WHERE id=? AND status='generating'").run(text,Date.now(),id);
    this.emit('stream', { id, text });
  }
  beginStreamPart(jobId, content) {
    const part = this.db.prepare('SELECT COALESCE(MAX(part),0)+1 AS n FROM reply_stream_parts WHERE job_id=?').get(jobId).n;
    this.db.prepare("INSERT INTO reply_stream_parts VALUES (?,?,?,'sending',NULL)").run(jobId,part,content);
    return part;
  }
  endStreamPart(jobId, part, status, messageId=null) {
    this.db.prepare('UPDATE reply_stream_parts SET status=?,message_id=? WHERE job_id=? AND part=?').run(status,messageId??null,jobId,part);
  }
  streamedPrefix(jobId) { return this.db.prepare("SELECT content FROM reply_stream_parts WHERE job_id=? AND status='sent' ORDER BY part").all(jobId).map(p=>p.content).join(''); }
  cleanup(days, uncertainDays = 30, maxAge) {
    if(maxAge!==undefined)this.expirePending(maxAge);
    if(!this.retainIgnoredContent)this.redactIgnored();
    const before = Date.now() - days * 86400000;
    this.db.prepare("DELETE FROM jobs WHERE created_at<? AND status IN ('done','ignored','failed')").run(before);
    this.db.prepare("DELETE FROM jobs WHERE status='uncertain' AND updated_at<?").run(Date.now() - uncertainDays * 86400000);
    this.db.prepare('DELETE FROM history WHERE created_at<?').run(before);
    this.db.exec('DELETE FROM reply_stream_parts WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=reply_stream_parts.job_id)');
    this.db.exec('DELETE FROM group_chat_jobs WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=group_chat_jobs.job_id)');
    this.db.prepare('DELETE FROM group_chat_state WHERE updated_at<?').run(before);
    const tables = new Set(this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    const cacheTables = ['kernel_messages', 'native_messages'].filter(name => tables.has(name));
    for (const table of cacheTables) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_time ON ${table}(time)`);
      this.db.prepare(`DELETE FROM ${table} WHERE time<?`).run(Math.floor(before / 1000));
    }
    if (tables.has('native_message_ids') && this.db.prepare('PRAGMA table_info(native_message_ids)').all().some(column => column.name === 'last_seen')) {
      const referenced = cacheTables.map(table => `AND NOT EXISTS (SELECT 1 FROM ${table} cache
        WHERE cache.account=ids.account AND cache.message_id=ids.onebot_id)`).join(' ');
      this.db.prepare(`DELETE FROM native_message_ids AS ids WHERE last_seen<? ${referenced}`).run(Math.floor(before / 1000));
    }
  }
  close() { this.db.close(); }
}
