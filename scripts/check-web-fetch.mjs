import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { PluginService } from '../src/plugins/service.mjs';

const config=loadConfig(),url=process.argv[2]||'https://www.python.org/';
let database,store,plugins;
try{
  database=new DatabaseSync(join(config.dataDir,'bot.sqlite'),{readOnly:true});
  const row=database.prepare("SELECT definition,enabled FROM plugins WHERE json_extract(definition,'$.name')=?").get('Python 网页抓取');
  database.close();database=null;
  if(!row)throw Error('请先运行 npm run webfetch:install 安装网页抓取插件。');
  store=new Store(':memory:');plugins=new PluginService({store,config,adapter:{},log:()=>{}});
  const result=await plugins.run(JSON.parse(row.definition),{post_type:'message',message_type:'private',self_id:10000,user_id:10001,message:[]},
    'tool',{tool:'fetch_webpage',arguments:{url,max_chars:1000,max_links:3}});
  console.log(JSON.stringify({installed_enabled:!!row.enabled,...result},null,2));
  if(!result.ok)process.exitCode=1;
}catch(error){console.error(error.reason?'网页工具执行失败，请检查插件与 Python 配置。':error.message);process.exitCode=1;}
finally{await plugins?.close();store?.close();database?.close();}
