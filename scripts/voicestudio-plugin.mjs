import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { voiceStudioTemplate } from '../src/voicestudio/service.mjs';
const output = resolve(process.argv[2] || 'dist/voicestudio.plugin.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(voiceStudioTemplate, null, 2) + '\n');
console.log('Exported ' + output);
