import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {groupChatTemplate} from '../src/group-chat-plus/config.mjs';
const output=resolve(process.argv[2]||'dist/group-chat-plus.plugin.json');
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(groupChatTemplate,null,2)+'\n');
console.log('Exported '+output);
