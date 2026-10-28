export function formatJobDetail(job) {
  const event=job.event||{},reason={
    plugin_handled:'消息已由自定义插件处理',
    ai_disabled:'AI 自动回复未启用',user_not_allowed:'好友不在回复白名单中',group_not_allowed:'群聊不在回复白名单中',
    group_requires_at:'群消息未 @ 机器人',self_message:'机器人自身消息不触发 AI',no_text:'消息不含可处理的文本',
    group_user_blocked:'群聊发送人命中固定屏蔽规则',
    ai_reply_empty_after_filter:'AI 回复过滤 Emoji 后无可发送正文',
    filtered:'未匹配回复规则（旧记录未保存具体筛选原因）',invalid_ai_input:'消息无法作为 AI 输入',
    policy_changed:'回复策略已改变',queue_full:'任务队列已满',expired:'等待任务已过期',
    group_chat_silent:'群聊增强本次保持沉默',group_chat_reply_filtered:'群聊增强输出被重复或禁止词规则拦截',
    stream_interrupted:'分段回复中断，已发送部分不会自动重发',stream_delivery_unknown:'部分分段发送结果未知，请在 QQ 核对'
  }[job.reason]||job.reason||'无';
  let received;
  if(event.content_state==='redacted')received='正文已脱敏清除，无法恢复';
  else if(event.content_state==='not_stored')received='正文未记录，仅保留防重信息';
  else if(event.content_retained===false)received='正文未保留（旧记录未区分未记录与已脱敏）';
  else {
    const segments=event.message;
    const text=job.input||(Array.isArray(segments)?segments.filter(s=>s.type==='text').map(s=>s.data?.text||'').join(''):
      typeof segments==='string'?segments:event.raw_message||'');
    received=typeof text==='string'&&text.trim()?text:
      job.reason==='no_text'||Array.isArray(segments)?'原消息没有文本'+(Array.isArray(segments)&&segments.some(s=>s.type!=='text')?'，仅含图片等非文本内容':''):
      '未找到消息正文（记录未提供内容状态）';
  }
  const reply=job.reply||(event.content_retained===false?'未保留（正文保留策略）':job.status==='ignored'?'未生成（任务已忽略）':'尚未生成');
  const trace=(job.agent_steps||[]).map(step => (step.kind==='tool'?'工具：':'模型：')+step.name+' · '+step.state+' · '+step.duration_ms+' ms').join('\n');
  const parts=(job.stream_parts||[]).map(p=>'第 '+p.part+' 段 · '+p.status+(p.message_id?' · 消息 '+p.message_id:'')+'\n'+p.content).join('\n');
  const decision=job.group_chat_decision;
  const outcome=decision&&{accepted:'适合参与',declined:'不适合参与',low_confidence:'置信度不足，保持沉默',invalid:'判断输出格式无效，保持沉默',error:'判断请求失败或超时，保持沉默'}[decision.outcome];
  let judgment=outcome?'AI 读空气：'+outcome+
    (Number.isFinite(decision.confidence)?'\n判断置信度：'+decision.confidence+(Number.isFinite(decision.threshold)?'（参与门槛 '+decision.threshold+'）':''):'')+
    '\n判断理由：'+(typeof decision.reason==='string'&&decision.reason.trim()?decision.reason:'模型未提供简短判断理由。'):
    job.reason==='group_chat_silent'?'AI 读空气：未参与\n判断理由：该任务未保存判断理由（旧记录或判断未完成）。':'';
  if(outcome&&decision.diagnostic){
    const d=decision.diagnostic;
    const reason={ai_timeout:'请求超时',ai_reasoning_only:'仅有思考内容，没有判断正文',ai_empty_reply:'没有判断正文',ai_http_error:'模型服务拒绝请求',ai_network_error:'模型服务连接失败',ai_response_interrupted:'响应中断',ai_stream_error:'模型流式响应报错',ai_unknown_error:'未取得详细错误信息'}[d.reason];
    if(reason)judgment+='\n请求诊断：'+reason;
    if(Number.isSafeInteger(d.duration_ms)&&Number.isSafeInteger(d.timeout_ms))judgment+='\n请求耗时：'+d.duration_ms+' ms / 超时设置 '+d.timeout_ms+' ms';
    if(d.finish_reason)judgment+='\n停止原因：'+(d.finish_reason==='length'?'达到输出 Token 上限（length）':d.finish_reason);
    if(Number.isSafeInteger(d.http_status))judgment+='\n服务状态码：'+d.http_status;
    const usage=[['prompt_tokens','输入'],['completion_tokens','输出（含思考）'],['reasoning_tokens','思考']].filter(([key])=>Number.isSafeInteger(d[key])).map(([key,label])=>label+' '+d[key]);
    if(usage.length)judgment+='\nToken 统计：'+usage.join(' · ');
  }
  return '会话：'+job.conversation+'\n处理原因：'+reason+'\n收到：'+received+'\n回复：'+reply+(judgment?'\n\n'+judgment:'')+(parts?'\n\n流式发送记录：\n'+parts:'')+(trace?'\n\nAgent 执行过程：\n'+trace:'');
}
