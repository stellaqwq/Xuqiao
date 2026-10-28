import {groupChatConfig,quiet,localDay} from './config.mjs';
import {groupChatSchema} from './schema.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const reasons={paused:'当前群已暂停',probability:'未命中参与概率',approved:'判断适合参与',decision_silent:'AI 判断保持沉默',quiet_hours:'安静时段',cooldown:'回复冷却中',density:'达到回复密度限制',blacklist:'命中黑名单',mention_others:'消息在 @其他成员',low_information:'有效信息不足',no_input:'没有可处理正文'};
export class GroupChatManagement{
  constructor(plugins){this.plugins=plugins;this.store=plugins.store;this.runtime=plugins.groupChatPlus;}
  plugin(){const p=this.plugins.findGroupChat();if(!p)throw fail('请先安装群聊增强插件。',404);return p;}
  target(p,group,requireAccount=false){
    if(typeof group!=='string'||!/^\d{1,16}$/.test(group)||!Number.isSafeInteger(Number(group))||Number(group)<=0)throw fail('请选择有效群号。');
    if(!p.scope.all_groups&&!p.scope.groups.includes(group))throw fail('此群不在插件允许范围内。',403);
    const account=this.plugins.adapter.driver.account;
    if(requireAccount&&!account)throw fail('尚未取得机器人账号，请先连接 QQ。',409);
    return (account||0)+':group:'+group;
  }
  overview(group){
    const p=this.plugins.findGroupChat();if(!p)return {plugin:null,schema:groupChatSchema,groups:[]};
    const db=this.store.db,now=this.runtime.now(),states=db.prepare('SELECT conversation FROM group_chat_state WHERE plugin_id=? ORDER BY updated_at DESC LIMIT 500').all(p.id);
    const ids=[...new Set([...p.scope.groups,...(p.scope.all_groups?this.plugins.config.ai.allowedGroups:[]),...states.map(r=>r.conversation.split(':')[2])])].filter(id=>p.scope.all_groups||p.scope.groups.includes(id));
    const groups=ids.map(id=>{
      const session=this.target(p,id),state=this.runtime.read(session,p),c=this.runtime.settings(p,session);
      return {id,conversation:session,allowed:this.plugins.config.ai.allowedGroups.has(id),paused:!!state.paused,
        probability:state.probability??c.initial_probability,last_probability:state.last_probability??null,
        last_reason:reasons[state.last_reason]||state.last_reason||'等待群消息',last_user:state.last_user||null,last_reply:state.last_reply||null,
        quiet:quiet(c,now),proactive:c.proactive_enabled,proactive_today:state.day===localDay(c,now)?state.proactive_count||0:0,
        proactive_limit:c.proactive_max_per_day,unanswered:state.unanswered_proactive||0,members:Object.keys(state.users).length,
        active_jobs:db.prepare("SELECT count(*) AS n FROM jobs WHERE conversation=? AND status IN ('queued','generating','ready','sending','uncertain')").get(session).n,
        images:db.prepare('SELECT count(*) AS n FROM group_chat_images WHERE plugin_id=? AND conversation=?').get(p.id,session).n,
        override_revision:this.runtime.settingsRevision(p,session)};
    });
    let detail=null;
    if(group){
      const session=this.target(p,group),state=this.runtime.read(session,p),c=this.runtime.settings(p,session);
      const row=db.prepare('SELECT config,revision FROM group_chat_overrides WHERE plugin_id=? AND group_id=?').get(p.id,group);
      detail={id:group,conversation:session,config:c,overrides:row?JSON.parse(row.config):{},override_revision:row?.revision||0,
        probability_override:state.probability??null,
        members:Object.entries(state.users).map(([id,user])=>({id,attention:this.runtime.attention(user,c,now),mood:c.mood_enabled&&now-(user.mood_at||0)<c.mood_decay_seconds*1000?user.mood:'neutral',last_at:user.at})),
        images:db.prepare('SELECT digest,model,caption,created_at FROM group_chat_images WHERE plugin_id=? AND conversation=? ORDER BY created_at DESC LIMIT 100').all(p.id,session),
        history:db.prepare('SELECT message_id,content,received_at FROM group_context_messages WHERE conversation=? ORDER BY id DESC LIMIT 30').all(session).reverse().map(row=>({...row,content:JSON.parse(row.content)}))};
    }
    return {plugin:{...p,config:groupChatConfig(p.config),config_schema:groupChatSchema},schema:groupChatSchema,groups,detail,
      ai_enabled:this.plugins.config.ai.enabled,context_enabled:this.plugins.config.ai.groupContextEnabled,online:this.plugins.adapter.status().online,checked_at:now};
  }
  action(params){
    return this.plugins.mutate(()=>{
      const p=this.plugin();this.plugins.checkRevision(p,params.revision);
      const session=this.target(p,params.group,params.action!=='overrides'),state=this.runtime.read(session,p),db=this.store.db;
      switch(params.action){
        case 'pause':case 'resume':state.paused=params.action==='pause';this.runtime.write(session,p,state);if(state.paused)this.runtime.cancelSession(session);break;
        case 'probability':
          if(params.value===null)delete state.probability;
          else if(!Number.isFinite(params.value)||params.value<0||params.value>1)throw fail('概率须为 0–1，或留空恢复配置。');
          else state.probability=params.value;
          this.runtime.write(session,p,state);break;
        case 'overrides':{
          const current=this.runtime.settingsRevision(p,session);
          if(params.override_revision!==current)throw fail('群专属设置已被其他窗口修改，请刷新。',409);
          if(!params.config||typeof params.config!=='object'||Array.isArray(params.config))throw fail('群专属设置须为对象。');
          groupChatConfig({...p.config,...params.config});
          db.prepare('INSERT INTO group_chat_overrides VALUES (?,?,?,?) ON CONFLICT(plugin_id,group_id) DO UPDATE SET config=excluded.config,revision=excluded.revision').run(p.id,params.group,JSON.stringify(params.config),current+1);
          this.runtime.cancelSession(session);break;
        }
        case 'reset':if(!this.store.clearHistoryIfIdle(session))throw fail('此群有未完成或待核对任务，请先在任务队列处理。',409);break;
        case 'clear_images':db.prepare('DELETE FROM group_chat_images WHERE plugin_id=? AND conversation=?').run(p.id,session);this.runtime.cancelSession(session);break;
        case 'delete_image':
          if(!/^[a-f0-9]{64}$/.test(params.digest||''))throw fail('图片缓存编号无效。');
          db.prepare('DELETE FROM group_chat_images WHERE plugin_id=? AND conversation=? AND digest=?').run(p.id,session,params.digest);this.runtime.cancelSession(session);break;
        default:throw fail('未知群聊管理操作。');
      }
      this.plugins.log('info','group_chat_managed',{plugin:p.id,action:params.action});
      return {updated:true};
    });
  }
}
