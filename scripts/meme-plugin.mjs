import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { memePluginTemplate } from '../src/memes/service.mjs';
const output = resolve(process.argv[2] || 'dist/meme-manager.plugin.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(memePluginTemplate, null, 2) + '\n');
console.log('Exported ' + output);
