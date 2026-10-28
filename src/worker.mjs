import { aiInput, aiDecision, chatCommandAllowed, isGroupUserBlocked, replyMessage, replyOptions } from './messages.mjs';
import { describeAIFailure } from './ai.mjs';
import { ReplyStream } from './reply-stream.mjs';
import { filterAIReply } from './reply-filter.mjs';

export class ReplyWorker {
  constructor({ adapter, store, ai, config, log, memes, voicestudio, attachments, groupContext,groupChatPlus }) {
    Object.assign(this, { adapter, store, ai, config, log, memes, voicestudio, attachments, groupContext,groupChatPlus });
    this.controller = new AbortController(); this.running = null;
    this.revision = 0; this.waiters = new Set(); this.onChange = () => this.wake();
  }
  ingest(event, handledByPlugin = false) {
    if (event.post_type !== 'message') return true;
    this.store.expirePending(this.config.jobMaxAge);
    let input = null;
    let reason = null;
    try { if (isGroupUserBlocked(event, this.config)) reason = 'group_user_blocked'; else if (!chatCommandAllowed(event, this.config)) reason = 'command_forbidden'; else if (handledByPlugin) reason = 'plugin_handled'; else ({input,reason}=aiDecision(event,this.config.ai)); }
    catch { reason = 'invalid_ai_input'; }
    const result = this.store.ingest(event, input, this.config.maxPending, reason);
    if (result.inserted && result.status === 'queued') this.log('info', 'ai_job_queued', { job: result.id });
    if (result.inserted && input && result.status === 'ignored') this.log('warn', 'ai_queue_full');
    return result.inserted;
  }
  start() {
    if (this.running || this.controller.signal.aborted) return;
    this.store.on('change', this.onChange);
    this.adapter.on?.('state', this.onChange);
    this.store.recover();
    // Each step claims its job synchronously before awaiting I/O. Store.next()
    // blocks later jobs in that conversation until generation and send finish.
    this.running = Promise.all(Array.from({ length: this.config.ai.concurrency }, () => this.loop()));
  }
  async loop() {
    while (!this.controller.signal.aborted) {
      const revision = this.revision;
      let failed = false;
      try { if (await this.step()) continue; }
      catch { failed = true; this.log('error', 'worker_iteration_failed'); }
      if (this.controller.signal.aborted) break;
      // Register against a revision to avoid losing a change between the
      // asynchronous step and going to sleep. Only retries need a timer.
      let milliseconds;
      try {
        if (failed) milliseconds = 1000;
        else {
          let time=this.store.nextExpiryTime(this.config.jobMaxAge);
          if(this.config.ai.enabled){
            const retry=this.store.nextTime(!this.adapter.status().online);
            if(retry!==null)time=time===null?retry:Math.min(time,retry);
            if(!this.adapter.status().online&&!this.adapter.on)milliseconds=5000;
          } else if(this.config.ai.enabled&&!this.adapter.on)milliseconds=5000;
          if(time!==null)milliseconds=Math.min(milliseconds??Infinity,Math.max(1,time-Date.now()));
        }
      } catch { milliseconds = 1000; }
      await this.wait(revision, milliseconds);
    }
  }
  wake() { this.revision++; for (const resume of [...this.waiters]) resume(); }
  wait(revision, milliseconds) {
    if (this.controller.signal.aborted || revision !== this.revision) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const resume = () => { clearTimeout(timer); this.waiters.delete(resume); resolve(); };
      this.waiters.add(resume);
      if (milliseconds !== undefined) timer = setTimeout(resume, Math.min(milliseconds, 2147483647));
    });
  }
  async step() {
    // Waiting jobs still age while AI is disabled or QQ is offline. Active
    // generation/sending and unknown delivery must never be reclassified here.
    if(this.store.expirePending(this.config.jobMaxAge))return true;
    if (!this.config.ai.enabled) return;
    const job = this.store.next(!this.adapter.status().online);
    if (!job) return;
    const currentEvent = JSON.parse(job.event);
    const route=this.groupChatPlus?.route(job);
    const signal=route?this.groupChatPlus.signal(job,currentEvent,this.controller.signal):this.controller.signal;
    try {
      if (job.channel !== 'web' && isGroupUserBlocked(currentEvent, this.config)) {
        this.store.update(job.id, 'ignored', { reason: 'group_user_blocked' }); return true;
      }
      if (job.channel !== 'web' && (!chatCommandAllowed(currentEvent, this.config) || !(route?this.groupChatPlus.scopedRoute(job,currentEvent):aiInput(currentEvent, this.config.ai)))) {
        this.store.update(job.id, 'ignored', { reason: 'policy_changed' }); return true;
      }
    } catch { this.store.update(job.id, 'ignored', { reason: 'policy_changed' }); return true; }
    if (job.status === 'queued') {
      if (job.attempts >= this.config.ai.maxAttempts) {
        this.store.update(job.id, 'failed', { reason: 'generation_attempts_exhausted' }); return true;
      }
      const attempt = job.attempts + 1;
      const started = Date.now();
      this.store.update(job.id, 'generating', { attempts: attempt });
      const stream = new ReplyStream(this, job, currentEvent);
      stream.signal=signal;stream.replyOptions=replyOptions(this.config,route?.kind==='proactive');
      stream.qq = !this.voicestudio?.buffersReply(currentEvent)&&!(route?.kind!=='proactive'&&this.memes?.requested?.(currentEvent))&&(!route||this.groupChatPlus.streamingAllowed(job,currentEvent));
      try {
        if(route&&!await this.groupChatPlus.beforeGenerate(job,currentEvent,signal)){this.store.update(job.id,'ignored',{reason:'group_chat_silent'});return true;}
        const history = this.store.history(job.conversation, this.config.ai.contextTurns);
        let reply = this.voicestudio?.cachedReply(job);
        if(reply==null){
          let prepared=await this.attachments?.prepare(job,currentEvent,signal)||{};
          if(route)prepared=await this.groupChatPlus.enrich(job,currentEvent,prepared,signal);
          const background=this.groupContext?.prepare(job,currentEvent,route?this.groupChatPlus.contextOptions(job,currentEvent):{})||{};
          signal.throwIfAborted();
          if(prepared.contextInput)this.store.db.prepare('UPDATE jobs SET context_input=? WHERE id=?').run(prepared.contextInput,job.id);
          reply=prepared.reply??await this.ai.reply(job.input, history, signal,
            { event:currentEvent, job, userContent:prepared.userContent, backgroundContent:background.backgroundContent,proactive:route?.kind==='proactive',
              ...(this.config.ai.stream !== false ? {onDelta:(delta,text)=>stream.delta(delta,text)} : {}),
              systemPromptSuffix:(prepared.systemPromptSuffix||'')+(background.systemPromptSuffix||'')+(route?this.groupChatPlus.prompt(job,currentEvent):'')+(job.channel==='web'?'':(this.memes?.prompt(currentEvent) || '') + (this.voicestudio?.prompt(currentEvent) || '')),
              ...(job.channel==='web'||route?.kind==='proactive'?{}:this.voicestudio?.options(currentEvent, job, signal) || {}) });
        }
        reply=filterAIReply(reply,this.config);
        if(!reply.trim()){this.store.update(job.id,'ignored',{reason:'ai_reply_empty_after_filter'});return true;}
        if(route){reply=this.groupChatPlus.filterReply(job,currentEvent,reply);if(reply===null){this.store.update(job.id,'ignored',{reason:'group_chat_reply_filtered'});return true;}}
        if (job.channel!=='web' && this.memes && this.voicestudio?.plan(job.id)?.state !== 'ready') reply = this.memes.planReply(reply, currentEvent, job.id,{requested:route?.kind==='proactive'?false:undefined});
        if (job.channel!=='web' && this.voicestudio&&route?.kind!=='proactive'&&!this.memes?.plan?.(job.id)?.image_id&&!this.memes?.requested?.(currentEvent)) reply = await this.voicestudio.maybeSpeakReply(job, currentEvent, reply, signal);
        this.store.update(job.id, 'ready', { reply,...(route?{nextAt:Date.now()+this.groupChatPlus.delay(job,currentEvent)}:{}) });
      } catch (error) {
        const parts = this.store.db.prepare('SELECT status FROM reply_stream_parts WHERE job_id=?').all(job.id);
        const unknown = parts.some(p=>['sending','uncertain'].includes(p.status));
        const retry = !parts.length && !this.controller.signal.aborted && error.retryable && attempt < this.config.ai.maxAttempts;
        this.store.update(job.id, unknown ? 'uncertain' : parts.length ? 'failed' : retry || this.controller.signal.aborted ? 'queued' : 'failed', {
          nextAt: Date.now() + Math.min(30000, 1000 * 2 ** (attempt - 1)), reason: unknown ? 'stream_delivery_unknown' : parts.length ? 'stream_interrupted' : 'ai_generation_failed' });
        if (!parts.length && this.voicestudio?.cachedReply(this.store.get(job.id)) == null) this.store.db.prepare('UPDATE jobs SET reply=NULL WHERE id=?').run(job.id);
        this.log('warn', 'ai_generation_failed', { job: job.id, attempt, ...describeAIFailure(error),
          duration_ms: Date.now() - started, timeout_ms: this.config.ai.timeout });
      }
      return true;
    }
    const event = JSON.parse(job.event);
    const deliveredPrefix=this.store.streamedPrefix(job.id);
    if(!deliveredPrefix||job.reply.startsWith(deliveredPrefix)){
      // A recovered job may have been generated before this setting changed.
      // Confirmed stream receipts remain immutable; filter only the unsent tail.
      const reply=deliveredPrefix+filterAIReply(job.reply.slice(deliveredPrefix.length),this.config);
      if(!reply.trim()){this.store.update(job.id,'ignored',{reason:'ai_reply_empty_after_filter'});return true;}
      if(reply!==job.reply){this.store.update(job.id,'ready',{reply});job.reply=reply;}
    }
    if (job.channel === 'web') {
      this.store.finish(job,this.config.ai.contextTurns);
      this.log('info','agent_web_reply_completed',{job:job.id});
      return true;
    }
    const sendAttempt = job.send_attempts + 1;
    if (sendAttempt > this.config.sendMaxAttempts) {
      this.store.update(job.id, 'failed', { reason: 'send_attempts_exhausted' }); return true;
    }
    this.store.update(job.id, 'sending', { sendAttempts: sendAttempt });
    try {
      // Claim synchronously before reading an image. Otherwise another worker
      // can select the same ready job while the first awaits filesystem I/O.
      const voice = await this.voicestudio?.messageForJob(job, event);
      let message = voice || (this.memes ? await this.memes.messageForJob(job, event) : [{ type: 'text', data: { text: job.reply } }]);
      if(!voice&&this.memes?.plan?.(job.id)?.image_only&&!message.some(segment=>segment.type==='image')){
        job.reply=message.filter(segment=>segment.type==='text').map(segment=>segment.data.text).join('');
        this.store.update(job.id,'sending',{reply:job.reply});
      }
      const prefix = this.store.streamedPrefix(job.id);
      if (prefix) {
        if (!job.reply.startsWith(prefix)) throw new Error('Streamed reply prefix changed');
        let skip = prefix.length;
        message = message.flatMap(segment=>{
          if(segment.type!=='text'||!skip)return [segment];
          const text=segment.data.text.slice(skip);skip=Math.max(0,skip-segment.data.text.length);
          return text?[{type:'text',data:{text}}]:[];
        });
      }
      message=message.flatMap(segment=>{
        if(segment.type!=='text')return [segment];
        const text=filterAIReply(segment.data.text,this.config);
        return text?[{...segment,data:{...segment.data,text}}]:[];
      });
      const params = { message: replyMessage(event,message,replyOptions(this.config,route?.kind==='proactive')),
        ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: event.user_id }) };
      if(message.length)await this.adapter.action(event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg', params,
        { signal });
      this.store.finish(job, this.config.ai.contextTurns);
      if(route)this.groupChatPlus.delivered(job,event);
      try { this.memes?.sent(job, event); } catch { this.log('warn', 'meme_usage_record_failed'); }
      this.log('info', 'ai_reply_sent', { job: job.id });
    } catch (error) {
      // A shutdown can cancel a send still waiting in the limiter. It must
      // explicitly confirm non-submission; cancellation after submission and
      // untyped failures remain ambiguous and must never be resent blindly.
      const cancelledBeforeSubmission = this.controller.signal.aborted && error.code === 1502 && error.uncertain === false;
      const exhausted = sendAttempt >= this.config.sendMaxAttempts;
      const retry = cancelledBeforeSubmission || error.retryable && !error.uncertain && !this.controller.signal.aborted && !exhausted;
      const uncertain = error.uncertain || (!error.code && !retry);
      const state = retry ? 'ready' : uncertain ? 'uncertain' : 'failed';
      this.store.update(job.id, state, {
        sendAttempts: cancelledBeforeSubmission ? job.send_attempts : sendAttempt,
        nextAt: retry && !cancelledBeforeSubmission ? Date.now() + Math.min(30000, 1000 * 2 ** (sendAttempt - 1)) : 0,
        reason: cancelledBeforeSubmission ? 'send_cancelled_before_submission' : uncertain ? 'delivery_unknown' :
          exhausted && error.retryable ? 'send_attempts_exhausted' : 'send_failed' });
      this.log(uncertain ? 'error' : 'warn', 'ai_reply_send_failed', { job: job.id, state, attempt: sendAttempt });
    }
    return true;
  }
  async close() {
    this.controller.abort(); this.wake();
    this.store.off('change', this.onChange); this.adapter.off?.('state', this.onChange);
    await this.running;
  }
}
