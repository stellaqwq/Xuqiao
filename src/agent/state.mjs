import { createHash, randomUUID } from 'node:crypto';

export const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (v,max) => typeof v === 'string' && v.trim() && v.length <= max;
const memoryRevision = memory => createHash('sha256').update(JSON.stringify([memory.scope,memory.key,memory.value,memory.updated_at])).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}
export class AgentState {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (job_id INTEGER PRIMARY KEY, persona TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_steps (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS agent_steps_job ON agent_steps(job_id,id);
      CREATE TABLE IF NOT EXISTS agent_receipts (job_id INTEGER NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT, PRIMARY KEY(job_id,name,digest));
      CREATE TABLE IF NOT EXISTS agent_memories (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS agent_personas (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, tools TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS agent_sessions (conversation TEXT PRIMARY KEY, persona TEXT NOT NULL);`);
    this.db.exec("UPDATE agent_steps SET state='interrupted' WHERE state='running'; UPDATE agent_runs SET state='interrupted' WHERE state='running'; UPDATE agent_receipts SET state='uncertain' WHERE state='running';");
  }
  begin(job,persona) {
    this.db.prepare(`INSERT INTO agent_runs VALUES (?,?,'running',?,?) ON CONFLICT(job_id) DO UPDATE SET persona=excluded.persona,state='running',updated_at=excluded.updated_at`).run(job.id,persona,Date.now(),Date.now());
  }
  end(job,state) { this.db.prepare('UPDATE agent_runs SET state=?,updated_at=? WHERE job_id=?').run(state,Date.now(),job.id); }
  step(job,kind,name) {
    const started = Date.now();
    const id = this.db.prepare("INSERT INTO agent_steps(job_id,kind,name,state,started_at) VALUES (?,?,?,'running',?)").run(job.id,kind,name,started).lastInsertRowid;
    this.db.prepare('UPDATE agent_runs SET updated_at=? WHERE job_id=?').run(started,job.id);
    return state => { this.db.prepare('UPDATE agent_steps SET state=?,duration_ms=? WHERE id=?').run(state,Date.now()-started,id); this.db.prepare('UPDATE agent_runs SET updated_at=? WHERE job_id=?').run(Date.now(),job.id); };
  }
  trace(id) { return this.db.prepare('SELECT kind,name,state,started_at,duration_ms FROM agent_steps WHERE job_id=? ORDER BY id LIMIT 500').all(id); }
  async invoke(job,tool,args,signal) {
    signal?.throwIfAborted();
    const digest = createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
    const writing = tool.effect !== 'read';
    const prior = writing && this.db.prepare('SELECT * FROM agent_receipts WHERE job_id=? AND name=? AND digest=?').get(job.id,tool.name,digest);
    if (prior) { this.step(job,'tool',tool.name)(prior.state === 'done'?'cached':'uncertain'); return prior.state === 'done' ? JSON.parse(prior.result) : { result: { ok:false, uncertain:true, error:'上次工具执行结果未知，请人工核对；未重复执行。' } }; }
    // A write tool may run once per job. A model changing arguments is not a
    // new user authorization, including after a provider or process failure.
    if (writing && this.db.prepare('SELECT 1 FROM agent_receipts WHERE job_id=? AND name=?').get(job.id,tool.name)) return { result: { ok:false, error:'本任务已调用此写入工具，不能更换参数再次执行。请用户发起新任务。' } };
    if (writing) this.db.prepare("INSERT INTO agent_receipts VALUES (?,?,?,'running',NULL)").run(job.id,tool.name,digest);
    const finish = this.step(job,'tool',tool.name);
    try {
      const result = await tool.invoke(args,signal);
      const encoded = JSON.stringify(result);
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 32768) throw problem('工具返回超过大小限制。');
      if (writing) this.db.prepare("UPDATE agent_receipts SET state='done',result=? WHERE job_id=? AND name=? AND digest=?").run(encoded,job.id,tool.name,digest);
      finish(result?.result?.ok === false ? 'failed' : 'succeeded');
      return result;
    } catch {
      // Custom plugins can have submitted a mutation before throwing.
      if (writing) this.db.prepare("UPDATE agent_receipts SET state='uncertain' WHERE job_id=? AND name=? AND digest=?").run(job.id,tool.name,digest);
      finish(writing?'uncertain':'failed');
      signal?.throwIfAborted();
      return { result: { ok:false, uncertain:writing, error:writing?'工具执行未完成，结果未知。请核对后再发起新任务，不要重复操作。':'工具查询失败，请检查插件配置或返回内容大小。' } };
    }
  }
  memories(scope) { return this.db.prepare('SELECT key,value,updated_at FROM agent_memories WHERE scope=? ORDER BY updated_at DESC LIMIT 50').all(scope); }
  listMemories(session) {
    if(typeof session!=='string'||session.length>100||!/^(?:\d+:(private|group):\d+|web:[a-f0-9-]{36})$/.test(session))throw problem('会话编号无效。');
    return this.db.prepare('SELECT scope,key,value,updated_at FROM agent_memories WHERE scope=? OR scope LIKE ? ORDER BY updated_at DESC LIMIT 200')
      .all(session,session+':user:%').map(memory=>({...memory,revision:memoryRevision(memory)}));
  }
  editMemory(params) {
    if(!params||typeof params!=='object'||Array.isArray(params))throw problem('记忆参数无效。');
    const {scope,key,newKey=key,value,revision}=params;
    if(typeof scope!=='string'||scope.length>130||!/^(?:\d+:(private|group):\d+(?::user:\d+)?|web:[a-f0-9-]{36})$/.test(scope)||
      !text(key,60)||!text(newKey,60)||!text(value,500)||typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))throw problem('记忆参数无效：名称和内容不能为空，最多 60 / 500 字符。');
    const current=this.db.prepare('SELECT scope,key,value,updated_at FROM agent_memories WHERE scope=? AND key=?').get(scope,key);
    if(!current)throw problem('这条记忆已被删除，请取消编辑后刷新。',404);
    if(memoryRevision(current)!==revision)throw problem('这条记忆已被更新，请取消编辑后重新读取，避免覆盖较新的内容。',409);
    const updatedAt=Math.max(Date.now(),current.updated_at+1);
    const result=this.db.prepare('UPDATE OR IGNORE agent_memories SET key=?,value=?,updated_at=? WHERE scope=? AND key=? AND value=? AND updated_at=?')
      .run(newKey,value,updatedAt,scope,key,current.value,current.updated_at);
    if(!result.changes)throw problem('记忆名称已被占用或内容已更新，请使用其他名称或取消编辑后重新读取。',409);
    const saved={scope,key:newKey,value,updated_at:updatedAt};return {...saved,revision:memoryRevision(saved)};
  }
  remember(scope,key,value) {
    if (!text(key,60) || !text(value,500)) throw problem('记忆名称和内容不能为空，最多 60 / 500 字符。');
    if (!this.memories(scope).some(m => m.key === key) && this.memories(scope).length >= 50) throw problem('当前会话记忆已满，请先删除旧记忆。');
    this.db.prepare('INSERT INTO agent_memories VALUES (?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(scope,key,value,Date.now());
    return { ok:true };
  }
  forget(scope,key) { return { removed:Number(this.db.prepare('DELETE FROM agent_memories WHERE scope=? AND key=?').run(scope,key).changes) }; }
  personas() { return this.db.prepare('SELECT * FROM agent_personas ORDER BY name,id').all().map(p => ({...p,tools:JSON.parse(p.tools)})); }
  persona(session) { const id = this.db.prepare('SELECT persona FROM agent_sessions WHERE conversation=?').get(session)?.persona; return this.personas().find(p => p.id === id) || null; }
  savePersona({id,name,prompt,tools=null,revision}) {
    if (!text(name,80) || typeof prompt !== 'string' || prompt.length > 12000 || tools !== null && (!Array.isArray(tools) || tools.length > 100 || tools.some(v => typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v)))) throw problem('人格名称、提示词或工具范围无效。');
    const current = id ? this.personas().find(p => p.id === id) : null;
    if (id && !current) throw problem('人格不存在。',404);
    if (current && current.revision !== revision) throw problem('人格已变化，请刷新后保存。',409);
    if (!current && this.personas().length >= 32) throw problem('最多保存 32 个人格。');
    id ||= randomUUID();
    this.db.prepare('INSERT INTO agent_personas(id,name,prompt,tools) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,prompt=excluded.prompt,tools=excluded.tools,revision=agent_personas.revision+1').run(id,name,prompt,JSON.stringify(tools));
    return this.personas().find(p => p.id === id);
  }
  removePersona({id,revision}) {
    const current = this.personas().find(p => p.id === id);
    if (!current) throw problem('人格不存在。',404);
    if (revision !== current.revision) throw problem('人格已变化，请刷新后删除。',409);
    const sessions = this.db.prepare('SELECT conversation FROM agent_sessions WHERE persona=?').all(id);
    for (const session of sessions) this.assertIdle(session.conversation);
    this.db.exec('SAVEPOINT agent_persona_delete');
    try {
      for (const session of sessions) this.store.clearConversationContext(session.conversation);
      this.db.prepare('DELETE FROM agent_sessions WHERE persona=?').run(id);
      this.db.prepare('DELETE FROM agent_personas WHERE id=?').run(id);
      this.db.exec('RELEASE agent_persona_delete');
    } catch(error) { this.db.exec('ROLLBACK TO agent_persona_delete; RELEASE agent_persona_delete'); throw error; }
    return {ok:true};
  }
  assertIdle(session) {
    if (!text(session,100) || !this.db.prepare('SELECT 1 FROM jobs WHERE conversation=?').get(session)) throw problem('会话不存在。',404);
    if (this.db.prepare("SELECT 1 FROM jobs WHERE conversation=? AND status IN ('generating','ready','sending','uncertain')").get(session)) throw problem('会话有执行中或待核对任务，请处理后重试。',409);
  }
  bind({conversation,persona}) {
    this.assertIdle(conversation);
    if (persona && !this.personas().some(p => p.id === persona)) throw problem('人格不存在。');
    this.db.prepare('INSERT INTO agent_sessions VALUES (?,?) ON CONFLICT(conversation) DO UPDATE SET persona=excluded.persona').run(conversation,persona || '');
    this.store.clearConversationContext(conversation);
    return { ok:true };
  }
  reset({conversation}) { this.assertIdle(conversation); this.store.clearConversationContext(conversation); return {ok:true}; }
  sessions() { return this.db.prepare(`SELECT j.conversation,MAX(j.updated_at) AS updated_at,COUNT(*) AS jobs,COALESCE(s.persona,'') AS persona FROM jobs j LEFT JOIN agent_sessions s ON s.conversation=j.conversation GROUP BY j.conversation ORDER BY updated_at DESC LIMIT 100`).all(); }
  cleanup(days) {
    this.db.exec('DELETE FROM agent_steps WHERE job_id NOT IN (SELECT id FROM jobs); DELETE FROM agent_runs WHERE job_id NOT IN (SELECT id FROM jobs); DELETE FROM agent_receipts WHERE job_id NOT IN (SELECT id FROM jobs); DELETE FROM agent_sessions WHERE conversation NOT IN (SELECT conversation FROM jobs);');
    this.db.prepare('DELETE FROM agent_memories WHERE updated_at<?').run(Date.now()-days*86400000);
  }
}
