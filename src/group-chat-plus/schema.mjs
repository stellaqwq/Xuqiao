import {groupChatTemplate} from './config.mjs';
const sections=[
  ['参与概率',[
    ['initial_probability','基础参与概率','0–1，例如 0.06 表示 6%。直接 @、引用机器人不受随机概率限制。',0,1],
    ['after_reply_probability','回复后的参与概率','关闭注意力时，短期使用此概率。',0,1],
    ['boost_duration_seconds','概率提升持续时间（秒）','回复后短期概率提升的有效期。',0,3600],
    ['interest_keywords','兴趣关键词','每行一个关键词，匹配时增加参与倾向。'],
    ['interest_boost','兴趣词概率增量','匹配兴趣关键词时增加的概率。',0,1],
    ['density_penalty','回复密度惩罚系数','近期每条回复会按该系数降低参与概率，0 关闭惩罚。',0,5],
    ['low_information_multiplier','低信息消息概率倍率','仅标点或表情时，概率乘以此数。',0,1],
    ['cooldown_seconds','普通回复冷却（秒）','两次普通群聊参与之间的最短间隔。',0,3600],
    ['max_replies_per_minute','每分钟回复上限','限制普通参与密度。',1,60]
  ]],
  ['AI 读空气',[
    ['decision_ai_enabled','启用 AI 读空气','普通消息通过概率筛选后，再判断是否适合参与。'],
    ['decision_model','判断模型','留空沿用当前模型；与主模型共用服务地址和 Key。'],
    ['decision_reasoning_effort','判断模型推理强度','默认 none 明确关闭辅助思考，避免短判断的 Token 全被思考消耗。不支持此参数的服务可留空。正式回复的推理强度独立设置。'],
    ['decision_max_output_tokens','判断生成 Token 上限','包含思考和判断 JSON。启用思考时需预留更多额度。',64,32768],
    ['decision_timeout_ms','判断超时（毫秒）','超时或无效判断会保持沉默。',100,60000],
    ['decision_confidence_threshold','判断置信度门槛','判断结果须选择回复且达到此置信度。',0,1],
    ['decision_extra_prompt','额外判断规则','补充什么情况下应参与或沉默。此阶段不调用工具。']
  ]],
  ['注意力与情绪',[
    ['attention_enabled','启用成员注意力','每位成员分别累积和衰减。'],
    ['attention_half_life_seconds','注意力半衰期（秒）','经过该时长，注意力衰减为一半。',1,86400],
    ['attention_gain','每次互动增加量','@机器人时增加此数，普通消息增加此数的 15%。',0,1],
    ['attention_boost','注意力概率影响','注意力乘以此数后，加入基础概率。',0,1],
    ['mood_enabled','启用情绪表达建议','使用轻量关键词线索，不能推断真实心理状态。'],
    ['mood_decay_seconds','情绪线索有效期（秒）','超时恢复中性表达。',1,86400],
    ['neutral_style','中性表达建议','无有效情绪线索时的措辞。'],['happy_style','开心时的表达建议','开心线索对应的措辞。'],
    ['sad_style','难过时的表达建议','难过线索对应的措辞。'],['angry_style','生气时的表达建议','生气线索对应的措辞。'],
    ['confused_style','疑惑时的表达建议','疑惑线索对应的措辞。']
  ]],
  ['触发与过滤',[
    ['trigger_keywords','直接触发关键词','每行一个，匹配后跳过随机概率。仍检查权限与黑名单。'],
    ['blacklist_users','不参与的成员 QQ 号','每行一个 QQ 号。对应成员不进入增强回复。'],
    ['blacklist_keywords','忽略的输入关键词','每行一个，匹配的输入及背景会被过滤。'],
    ['ignore_mentions_others','忽略 @其他人的消息','避免插入其他成员的定向对话。'],
    ['merge_window_ms','消息合并窗口（毫秒）','短时间内的相关消息合并生成一条回复，0 关闭。',0,10000],
    ['max_batch_messages','单批合并消息上限','限制一次回复参考的合并消息数。',1,30],
    ['empty_at_wait_ms','单独 @等待时间（毫秒）','只有 @、没有正文时等待补充。',0,10000]
  ]],
  ['主动聊天',[
    ['proactive_enabled','启用主动聊天','群有足够历史活跃后，按沉默时间和概率参与。'],
    ['proactive_silence_seconds','群沉默阈值（秒）','距离最近群成员或机器人发言至少经过该时长。',10,86400],
    ['proactive_cooldown_seconds','主动聊天基础冷却（秒）','无人回应时逐步延长冷却。',10,86400],
    ['proactive_probability','每次检查的参与概率','达到时段、活跃度和冷却条件后再抽样。',0,1],
    ['proactive_min_user_messages','最低活跃消息数','近期窗口内至少需要的成员发言数。',1,100],
    ['proactive_activity_window_seconds','活跃度窗口（秒）','仅统计此窗口内的成员消息。',30,86400],
    ['proactive_max_per_day','每天主动聊天上限','按下方时区统计调度次数。',1,100],
    ['proactive_unanswered_limit','连续无人回应上限','达到后停止主动聊天，等待成员再次参与。',1,100],
    ['proactive_check_seconds','主动聊天检查间隔（秒）','后台每隔该时长检查是否满足条件。',5,3600]
  ]],
  ['安静时段',[
    ['quiet_hours_enabled','启用安静时段','安静时段停止普通随机参与与主动聊天，直接 @仍可回复。'],
    ['quiet_start','安静开始时间','24 小时制 HH:mm。'],['quiet_end','安静结束时间','可跨午夜，例如 23:00 至 07:00。'],
    ['timezone','时区','IANA 时区，例如 Asia/Shanghai；同时用于每日主动聊天计数。']
  ]],
  ['图片描述',[
    ['image_caption_enabled','启用图片描述','需要当前服务支持多模态输入。'],
    ['caption_unmentioned_images','后台描述未 @的图片','群消息未触发回复时仍可缓存描述，会消耗模型调用。'],
    ['image_caption_model','图片描述模型','留空沿用当前模型；须能识别图片。'],
    ['image_caption_reasoning_effort','图片描述推理强度','默认 none 直接描述图片；不支持此参数时留空。关闭描述思考不会修改正式回复的推理强度。'],
    ['image_caption_max_output_tokens','图片描述 Token 上限','包含思考和最终图片描述。',64,32768],
    ['image_caption_timeout_ms','描述超时（毫秒）','超时不会阻止普通群聊继续。',100,120000],
    ['image_cache_max_entries','图片描述缓存上限','每个群分别限制保留条数。',1,5000],
    ['image_cache_days','图片描述保留天数','超期描述在后台清理。',1,365]
  ]],
  ['回复输出',[
    ['duplicate_filter','拦截近期重复回复','开启时需完整生成后检查，因此 QQ 不逐段发送。'],
    ['duplicate_window_seconds','重复检查时间窗口（秒）','仅比较此窗口内的最近回复。',1,86400],
    ['output_block_words','禁止输出词','每行一个，命中时不发送整条回复；也会启用完整生成检查。'],
    ['typing_delay_ms','发送前延迟（毫秒）','生成后等待再发送。',0,10000],
    ['reply_style','额外回复风格','追加在群聊表达建议后；人格仍由 Agent 管理。']
  ]]
];
export const groupChatSchema=Object.fromEntries(sections.flatMap(([group,fields])=>fields.map(([key,description,hint,min,max])=>{
  const initial=groupChatTemplate.config[key];
  const type=Array.isArray(initial)?'list':typeof initial==='boolean'?'bool':typeof initial==='number'?(Number.isInteger(initial)&&!['initial_probability','after_reply_probability','attention_gain','attention_boost','proactive_probability','interest_boost','density_penalty','low_information_multiplier','decision_confidence_threshold'].includes(key)?'int':'float'):key.endsWith('_style')||key.endsWith('_prompt')?'text':'string';
  return [key,{type,description,hint,group,default:initial,...(min===undefined?{}:{slider:{min,max,step:type==='int'?1:0.01}})}];
})));
