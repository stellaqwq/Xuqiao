// An intentionally bounded subset of AstrBot-style configuration descriptions.
const types=new Set(['string','text','int','float','bool','list','object']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const invalid=message=>Object.assign(new Error('插件配置：'+message),{status:400});
const safe=key=>/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)&&!['__proto__','constructor','prototype'].includes(key);
export function normalizeConfigSchema(value={},depth=0,budget={count:0}){
  if(!plain(value)||depth>4||Buffer.byteLength(JSON.stringify(value))>24576)throw invalid('配置定义无效或过大。');
  const result={};
  for(const [key,field] of Object.entries(value)){
    if(!safe(key)||!plain(field)||!types.has(field.type)||++budget.count>100)throw invalid('不支持的配置定义 '+key);
    const item={type:field.type};
    for(const [name,max] of [['description',160],['hint',1200],['group',80]])if(field[name]!==undefined){if(typeof field[name]!=='string'||field[name].length>max)throw invalid(key+' 的 '+name+' 无效');item[name]=field[name];}
    if(field.secret!==undefined){if(typeof field.secret!=='boolean')throw invalid(key+' 的 secret 无效');item.secret=field.secret;}
    if(field.options!==undefined){if(!Array.isArray(field.options)||!field.options.length||field.options.length>100||field.options.some(v=>typeof v!=='string'||v.length>200))throw invalid(key+' 的选项无效');item.options=[...field.options];}
    if(field.slider!==undefined){const s=field.slider;if(!plain(s)||!Number.isFinite(s.min)||!Number.isFinite(s.max)||s.min>s.max||s.step!==undefined&&(!Number.isFinite(s.step)||s.step<=0))throw invalid(key+' 的数值范围无效');item.slider={min:s.min,max:s.max,step:s.step??(field.type==='int'?1:0.01)};}
    if(field.type==='object')item.items=normalizeConfigSchema(field.items||{},depth+1,budget);
    if(Object.hasOwn(field,'default'))item.default=structuredClone(field.default);
    result[key]=item;
  }
  applyConfigSchema(result,{});
  return result;
}
export function applyConfigSchema(schema,value,path=''){
  if(!plain(value))throw invalid(path+'必须是对象');
  for(const key of Object.keys(value))if(['__proto__','constructor','prototype'].includes(key))throw invalid('不支持的配置键');
  const result=structuredClone(value);
  for(const [key,f] of Object.entries(schema)){
    const label=path+key,defaults={string:'',text:'',int:0,float:0,bool:false,list:[],object:{}};
    let v=Object.hasOwn(value,key)?value[key]:structuredClone(Object.hasOwn(f,'default')?f.default:defaults[f.type]);
    if(f.type==='object')v=applyConfigSchema(f.items,v,label+'.');
    else if(f.type==='bool'){if(typeof v!=='boolean')throw invalid(label+'必须是开关');}
    else if(f.type==='int'||f.type==='float'){
      if(!Number.isFinite(v)||f.type==='int'&&!Number.isSafeInteger(v))throw invalid(label+'必须是有效数值');
      if(f.slider&&(v<f.slider.min||v>f.slider.max))throw invalid(label+'超出允许范围');
    }else if(f.type==='list'){
      if(!Array.isArray(v)||v.length>200||v.some(x=>typeof x!=='string'||x.length>1000))throw invalid(label+'必须是字符串列表');
    }else if(typeof v!=='string'||v.length>(f.type==='text'?8000:2000))throw invalid(label+'文本无效或过长');
    if(f.options&&(Array.isArray(v)?v.some(x=>!f.options.includes(x)):!f.options.includes(v)))throw invalid(label+'不在可选范围');
    result[key]=v;
  }
  return result;
}
