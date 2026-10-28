import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const input=await new Promise(resolve=>process.once('message',resolve));
const {kind,maxChars,maxPages}=input,bytes=new Uint8Array(input.bytes);
const reply=value=>process.send(value,()=>process.disconnect());
const list=value=>value===undefined?[]:Array.isArray(value)?value:[value];
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:true,htmlEntities:false});
function text(value) {
  if(value===undefined||value===null)return '';
  if(typeof value!=='object')return String(value);
  return Object.entries(value).filter(([key])=>!key.startsWith('@_')).map(([,v])=>Array.isArray(v)?v.map(text).join(''):text(v)).join('');
}
function office() {
  let expanded=0,entries=0;
  const files=unzipSync(bytes,{filter:entry=>{
    if(++entries>2000||entry.originalSize>16*1024*1024||(expanded+=entry.originalSize)>32*1024*1024)throw Error('archive_limit');
    return /^(?:word\/document\.xml|xl\/(?:sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml))$/.test(entry.name);
  }});
  const xml=path=>{if(!files[path])throw Error('missing_xml');const value=strFromU8(files[path]);if(/<!DOCTYPE|<!ENTITY/i.test(value))throw Error('xml_entities');return parser.parse(value);};
  if(kind==='docx') {
    // Preserve paragraph/run order, including mixed table and paragraph content.
    const raw=strFromU8(files['word/document.xml']||new Uint8Array());
    if(!raw||/<!DOCTYPE|<!ENTITY/i.test(raw))throw Error('invalid_docx');
    const ordered=new XMLParser({preserveOrder:true,ignoreAttributes:true,parseTagValue:false}).parse(raw);
    let result='';
    const walk=nodes=>{for(const node of nodes){for(const [key,value] of Object.entries(node)){
      if(key==='w:t')result+=text(value);else if(key==='w:tab')result+='\t';else if(key==='w:br'||key==='w:cr')result+='\n';
      else if(Array.isArray(value)){walk(value);if(key==='w:p'||key==='w:tr')result+='\n';}
    }if(result.length>maxChars+1000)return;}};walk(ordered);
    return {text:result,truncated:result.length>maxChars};
  }
  const strings=files['xl/sharedStrings.xml']?list(xml('xl/sharedStrings.xml').sst?.si).map(text):[];
  const workbook=xml('xl/workbook.xml'),relationships=list(xml('xl/_rels/workbook.xml.rels').Relationships?.Relationship);
  let result='',sheets=0,truncated=false;
  for(const sheet of list(workbook.workbook?.sheets?.sheet)){
    if(++sheets>20){truncated=true;break;}
    const target=relationships.find(r=>r['@_Id']===sheet['@_r:id'])?.['@_Target'];
    const path=typeof target==='string'?target.startsWith('/xl/')?target.slice(1):'xl/'+target.replace(/^\.\//,''):'';
    if(!/^xl\/worksheets\/sheet\d+\.xml$/.test(path))continue;
    result+='\n工作表：'+String(sheet['@_name']||sheets)+'\n';
    for(const row of list(xml(path).worksheet?.sheetData?.row)){
      result+=list(row.c).map(cell=>String(cell['@_r']||'')+'='+(
        cell['@_t']==='s'?strings[Number(cell.v)]||'':cell['@_t']==='inlineStr'?text(cell.is):cell.v??(cell.f?'[公式没有缓存值]':''))).join('\t')+'\n';
      if(result.length>maxChars){truncated=true;break;}
    }
    if(truncated)break;
  }
  return {text:result,truncated};
}
try {
  let result;
  if(kind==='pdf'){
    const {PDFParse}=await import('pdf-parse');const pdf=new PDFParse({data:bytes});
    try {const info=await pdf.getInfo(),output=await pdf.getText({first:maxPages});result={text:output.text,truncated:info.total>maxPages||output.text.length>maxChars};}
    finally {await pdf.destroy();}
  } else if(['docx','xlsx'].includes(kind)) result=office();
  else {
    let value;
    if(bytes[0]===255&&bytes[1]===254)value=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);
    else if(bytes[0]===254&&bytes[1]===255)value=new TextDecoder('utf-16be',{fatal:true}).decode(bytes);
    else {try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{value=new TextDecoder('gb18030',{fatal:true}).decode(bytes);}}
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw Error('binary');
    result={text:value,truncated:value.length>maxChars};
  }
  const value=result.text.trim().slice(0,maxChars);
  reply(value?{text:value,truncated:result.truncated}:{error:'文档没有可提取的文字；扫描版 PDF 请将相关页面作为图片发送。'});
}catch{reply({error:'无法读取该文件。请检查文件是否损坏、加密或过于复杂，或转为文本后重发。'});}
