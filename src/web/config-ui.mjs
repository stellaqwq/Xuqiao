export const configStyles=String.raw`
.config-layout{display:grid;grid-template-columns:170px minmax(0,1fr);gap:28px;align-items:start}.config-nav{display:grid;gap:5px}.config-nav button{border:0;background:none;text-align:left;font-size:13px;padding:10px 12px;color:var(--muted);min-height:42px}.config-nav button[aria-current=true]{background:var(--accent-soft);color:var(--accent);font-weight:600}.config-nav button:hover{background:var(--surface-muted);color:var(--ink)}.config-section{border:0;padding:0;margin:0;min-width:0}.config-section legend{font-size:16px;font-weight:650;padding:0;margin:0 0 18px}.config-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 24px}.config-field{min-width:0;display:grid;gap:7px;align-content:start;font-size:12px;font-weight:600}.config-field.wide{grid-column:1/-1}.config-field small{font-size:12px;font-weight:400;line-height:1.7;color:var(--muted);overflow-wrap:anywhere}.config-field input:not([type=checkbox]),.config-field textarea,.config-field select{width:100%;min-width:0;border:1px solid var(--field-line);padding:9px 11px;background:var(--surface);color:var(--ink);font-weight:400;min-height:40px}.config-field textarea{resize:vertical;min-height:100px}.config-toggle{display:flex;gap:9px;align-items:center;min-height:40px}.config-toggle input{width:17px;height:17px;accent-color:var(--accent)}.config-key{color:var(--muted);font:11px/1.6 var(--mono);overflow-wrap:anywhere}.config-raw{margin:22px 0 0}.config-raw>summary{cursor:pointer;font-size:12px;color:var(--muted);padding:8px 0}.config-raw textarea{width:100%;font:12px/1.7 var(--mono);margin-top:10px;min-height:220px}.config-search{margin-bottom:22px}.config-search input{width:100%;max-width:440px;min-height:40px;padding:9px 11px;border:1px solid var(--field-line);background:var(--surface)}
@media(max-width:900px){.config-layout{grid-template-columns:minmax(0,1fr);gap:20px}.config-nav{display:flex;gap:6px;flex-wrap:wrap}.config-nav button{font-size:12px;padding:8px 10px}}
@media(max-width:680px){.config-fields{grid-template-columns:minmax(0,1fr);gap:22px}.config-field.wide{grid-column:auto}.config-nav button,.config-toggle{min-height:44px}.config-field input:not([type=checkbox]),.config-field textarea,.config-field select,.config-search input{font-size:16px;min-height:44px}}
`;
export const configClient=String.raw`
function mountConfigFields(root,schema,initial,onChange,prefix='config'){
  root.replaceChildren();const draft=structuredClone(initial),controls=[],sections=[];
  const layout=el('div','config-layout'),nav=el('nav','config-nav'),body=el('div');nav.setAttribute('aria-label','插件配置分组');layout.append(nav,body);root.append(layout);
  const groups=[...new Set(Object.values(schema).map(f=>f.group||'插件配置'))];
  function select(group){for(const s of sections){s.node.hidden=s.group!==group;s.button.setAttribute('aria-current',String(s.group===group));}}
  function build(parent,fields,values,path=[]){
    for(const [key,f] of Object.entries(fields)){
      const name=[...path,key],id=prefix+'-'+name.join('-'),initial=f.default??({bool:false,list:[],object:{},int:0,float:0}[f.type]??'');
      if(values[key]===undefined)values[key]=structuredClone(initial);
      if(f.type==='object'){const set=el('fieldset','config-section config-field wide');set.append(el('legend','',f.description||key));const grid=el('div','config-fields');set.append(grid);parent.append(set);build(grid,f.items,values[key],name);continue;}
      const field=el('div','config-field'+(['text','list'].includes(f.type)?' wide':'')),label=el('label','',f.description||key);label.htmlFor=id;
      let control;
      if(f.options&&f.type!=='list'){control=el('select');for(const v of f.options){const option=el('option','',v);option.value=v;control.append(option);}}
      else if(f.type==='text'||f.type==='list'){control=el('textarea');control.rows=f.type==='text'?4:3;}
      else{control=el('input');control.type=f.type==='bool'?'checkbox':f.type==='int'||f.type==='float'?'number':f.secret?'password':'text';}
      control.id=id;control.dataset.key=name.join('.');control.setAttribute('aria-describedby',id+'-help');
      if(f.type==='bool'){control.checked=values[key]===true;const line=el('div','config-toggle');line.append(control,label);field.append(line);}
      else{control.value=f.type==='list'?(values[key]||[]).join('\n'):values[key];if(f.type==='int'||f.type==='float'){control.step=f.type==='int'?'1':'any';if(f.slider){control.min=f.slider.min;control.max=f.slider.max;}}field.append(label,control);}
      const hint=el('small','',f.hint||'');hint.id=id+'-help';field.append(hint,el('span','config-key',name.join('.')));parent.append(field);
      controls.push({control,f,values,key,field});control.addEventListener('input',()=>{update(false);onChange?.();});
    }
  }
  for(const group of groups){
    const node=el('fieldset','config-section'),button=el('button','',group);button.type='button';button.onclick=()=>select(group);nav.append(button);
    node.append(el('legend','',group));const fields=el('div','config-fields');node.append(fields);body.append(node);sections.push({group,node,button});
    build(fields,Object.fromEntries(Object.entries(schema).filter(([,f])=>(f.group||'插件配置')===group)),draft);
  }
  function update(strict){
    for(const {control,f,values,key} of controls){
      let value=f.type==='bool'?control.checked:f.type==='list'?control.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):f.type==='int'||f.type==='float'?control.valueAsNumber:control.value;
      if(strict&&!control.checkValidity()||strict&&(f.type==='int'||f.type==='float')&&!Number.isFinite(value)){
        const section=sections.find(s=>s.node.contains(control));select(section.group);control.focus();control.reportValidity();throw new Error('请检查“'+(f.description||key)+'”。');
      }
      values[key]=value;
    }
    return structuredClone(draft);
  }
  select(groups[0]);return {read:()=>update(true),value:()=>update(false),search:query=>{
    const term=query.trim().toLowerCase();nav.hidden=!!term;
    for(const s of sections)s.node.hidden=term?!s.node.textContent.toLowerCase().includes(term):s.button.getAttribute('aria-current')!=='true';
    for(const item of controls)item.field.hidden=!!term&&!item.field.textContent.toLowerCase().includes(term);
  }};
}
`;
