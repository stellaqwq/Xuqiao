const defaults={
  initial_probability:0.06,after_reply_probability:0.6,boost_duration_seconds:90,
  decision_ai_enabled:true,decision_model:'',decision_timeout_ms:12000,decision_extra_prompt:'',
  decision_reasoning_effort:'none',decision_max_output_tokens:512,
  attention_enabled:true,attention_half_life_seconds:120,attention_gain:0.18,attention_boost:0.55,
  cooldown_seconds:12,max_replies_per_minute:3,trigger_keywords:[],interest_keywords:[],blacklist_users:[],blacklist_keywords:[],ignore_mentions_others:true,
  quiet_hours_enabled:true,quiet_start:'23:00',quiet_end:'07:00',timezone:'Asia/Shanghai',
  merge_window_ms:1200,max_batch_messages:8,empty_at_wait_ms:4000,
  proactive_enabled:true,proactive_silence_seconds:600,proactive_cooldown_seconds:900,proactive_probability:0.3,
  proactive_min_user_messages:4,proactive_activity_window_seconds:1800,proactive_max_per_day:3,proactive_check_seconds:30,
  mood_enabled:true,mood_decay_seconds:300,image_caption_enabled:true,caption_unmentioned_images:true,image_caption_model:'',image_caption_timeout_ms:20000,
  image_caption_reasoning_effort:'none',image_caption_max_output_tokens:2048,
  image_cache_max_entries:500,image_cache_days:7,duplicate_filter:true,output_block_words:[],typing_delay_ms:0,reply_style:'',
  interest_boost:0.2,density_penalty:0.5,low_information_multiplier:0.35,decision_confidence_threshold:0.5,
  duplicate_window_seconds:1800,proactive_unanswered_limit:5,
  neutral_style:'自然简短地参与讨论。',happy_style:'可以轻松回应，避免机械复读。',sad_style:'语气体贴，不调侃对方的困扰。',
  angry_style:'保持冷静，不升级争执。',confused_style:'用清楚的解释帮助理解。'
};
const ranges={initial_probability:[0,1],after_reply_probability:[0,1],boost_duration_seconds:[0,3600],decision_timeout_ms:[100,60000],
  attention_half_life_seconds:[1,86400],attention_gain:[0,1],attention_boost:[0,1],cooldown_seconds:[0,3600],max_replies_per_minute:[1,60],
  merge_window_ms:[0,10000],max_batch_messages:[1,30],empty_at_wait_ms:[0,10000],proactive_silence_seconds:[10,86400],
  proactive_cooldown_seconds:[10,86400],proactive_probability:[0,1],proactive_min_user_messages:[1,100],proactive_activity_window_seconds:[30,86400],
  proactive_max_per_day:[1,100],proactive_check_seconds:[5,3600],mood_decay_seconds:[1,86400],image_caption_timeout_ms:[100,120000],
  image_cache_max_entries:[1,5000],image_cache_days:[1,365],typing_delay_ms:[0,10000],interest_boost:[0,1],density_penalty:[0,5],
  low_information_multiplier:[0,1],decision_confidence_threshold:[0,1],duplicate_window_seconds:[1,86400],proactive_unanswered_limit:[1,100]};
Object.assign(ranges,{decision_max_output_tokens:[64,32768],image_caption_max_output_tokens:[64,32768]});
const decimals=new Set(['initial_probability','after_reply_probability','attention_gain','attention_boost','proactive_probability','interest_boost','density_penalty','low_information_multiplier','decision_confidence_threshold']);
const fail=key=>Object.assign(new Error('群聊增强配置无效：'+key),{status:400});
export function groupChatConfig(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(defaults,k)))throw fail('未知配置项');
  const c={...structuredClone(defaults),...structuredClone(value)};
  for(const [key,initial] of Object.entries(defaults)){
    if(typeof initial==='boolean'&&typeof c[key]!=='boolean')throw fail(key);
    if(typeof initial==='string'&&(typeof c[key]!=='string'||c[key].length>(key.endsWith('prompt')||key.endsWith('_style')?2000:200)))throw fail(key);
    if(Array.isArray(initial)&&(!Array.isArray(c[key])||c[key].length>200||c[key].some(s=>typeof s!=='string'||!s.trim()||s.length>100)))throw fail(key);
  }
  for(const [key,[min,max]] of Object.entries(ranges))if(!Number.isFinite(c[key])||c[key]<min||c[key]>max||!decimals.has(key)&&!Number.isInteger(c[key]))throw fail(key);
  for(const key of ['quiet_start','quiet_end'])if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c[key]))throw fail(key);
  for(const key of ['decision_reasoning_effort','image_caption_reasoning_effort'])if(!['','none','minimal','low','medium','high','xhigh'].includes(c[key]))throw fail(key);
  if(c.blacklist_users.some(id=>!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)<=0))throw fail('blacklist_users');
  try{new Intl.DateTimeFormat('en',{timeZone:c.timezone}).format();}catch{throw fail('timezone');}
  return c;
}
export const groupChatTemplate={schema:1,kind:'group-chat-plus',name:'群聊增强 Chat Plus',version:'1.1.0',
  description:'参考 Group Chat Plus 的功能设计：读空气、动态概率、注意力、情绪、消息合并、定时主动聊天及图片描述缓存。',
  source:'// 内置群聊增强执行层；回复走现有 Agent、任务队列及 QQ 发送确认。\n',trigger:'',priority:-50,timeout_ms:10000,
  scope:{private_users:[],groups:[],all_private:false,all_groups:false,require_at:false},config:structuredClone(defaults)};

export function quiet(c,now=Date.now()){
  if(!c.quiet_hours_enabled||c.quiet_start===c.quiet_end)return false;
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:c.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  const minute=Number(parts.hour)*60+Number(parts.minute),asMinute=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
  const start=asMinute(c.quiet_start),end=asMinute(c.quiet_end);return start<end?minute>=start&&minute<end:minute>=start||minute<end;
}
export function localDay(c,now=Date.now()){return new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function moodOf(text){
  const entries=[['sad',/(?:难过|伤心|想哭|呜呜|😭|😢)/u],['angry',/(?:生气|气死|恼火|烦死|😡)/u],['happy',/(?:开心|高兴|哈哈|太好了|🎉|😄)/u],['confused',/(?:不懂|为什么|怎么回事|🤔)/u]];
  for(const [mood,pattern] of entries){const hit=pattern.exec(text);if(hit&&!/(?:不|没|别|不要|不是).{0,3}$/u.test(text.slice(Math.max(0,hit.index-6),hit.index)))return mood;}
  return 'neutral';
}
