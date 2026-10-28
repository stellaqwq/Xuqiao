import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const rootFiles = new Set(['package.json', 'package-lock.json', 'README.md', '.env.example', '.gitignore', '.dockerignore', '.npmignore', 'Dockerfile', 'compose.yaml', 'start.cmd']);
const directories = new Set(['src', 'scripts', 'test', 'docs', 'native', 'examples']);
const contextFiles = ['PRODUCT.md','DESIGN.md','.impeccable/design.json','.impeccable/surface-briefs/workspace.md'];
const extensions = /\.(?:mjs|md|c|py)$/;
function inside(root, path) {
  const value = relative(root, path);
  return value === '' || value !== '..' && !value.startsWith('..' + '/') && !value.startsWith('..' + '\\') && !isAbsolute(value);
}
export async function sourceFiles(root) {
  const files = [];
  async function visit(path, name) {
    if (!rootFiles.has(name) && name.split('/').some(part => part.startsWith('.') || ['data', 'runtime', 'node_modules'].includes(part))) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Source export refuses symbolic links: ' + name);
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry), `${name}/${entry}`);
    } else if (stat.isFile() && (rootFiles.has(name) || extensions.test(name))) {
      files.push(name);
    }
  }
  for (const name of [...rootFiles, ...directories]) await visit(join(root, name), name);
  for (const name of contextFiles) {
    try {
      const stat=await lstat(join(root,name));
      if(stat.isSymbolicLink())throw new Error('Source export refuses symbolic links: '+name);
      if(stat.isFile())files.push(name);
    } catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  return files.sort();
}
export async function exportSource(root, destination) {
  root = resolve(root); destination = resolve(destination);
  if (inside(destination, root) || [...directories].some(name => inside(join(root, name), destination))) {
    throw new Error('Source export destination must be separate from source directories');
  }
  // A fresh destination prevents leftover credentials from an earlier export.
  const files = await sourceFiles(root);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  const manifest = [];
  for (const name of files) {
    const bytes = await readFile(join(root, name));
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await writeFile(join(destination, name), bytes, { flag: 'wx' });
    manifest.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(join(destination, 'SOURCE-MANIFEST.json'), JSON.stringify({ schema: 1, files: manifest }, null, 2) + '\n', { flag: 'wx' });
  return { directory: destination, files: files.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const destination = process.argv[2] || join(root, 'dist', `source-${Date.now()}`);
  process.stdout.write(JSON.stringify(await exportSource(root, destination)) + '\n');
}
