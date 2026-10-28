import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BotError } from '../../errors.mjs';

export function discoverQQ(path = '') {
  const candidates = path ? [resolve(path)] : [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'QQNT', 'QQ.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', 'QQNT', 'QQ.exe'),
    join(process.env.LOCALAPPDATA || '.', 'Programs', 'Tencent', 'QQNT', 'QQ.exe')
  ];
  for (const executable of candidates) {
    if (!existsSync(executable)) continue;
    const root = dirname(executable), settings = join(root, 'versions', 'config.json');
    const version = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')).curVersion : '';
    if (version && (typeof version !== 'string' || !/^[\w.-]+$/.test(version))) throw new BotError('Invalid QQ version metadata', 1501);
    const versionRoot = version ? join(root, 'versions', version) : root;
    const app = join(versionRoot, 'resources', 'app'), packagePath = join(app, 'package.json');
    if (!existsSync(packagePath) || !existsSync(join(app, 'wrapper.node'))) continue;
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (pkg.name !== 'qq-chat' || !pkg.main || !pkg.version) throw new BotError('Not an official QQNT installation', 1501);
    return { executable, root, versionRoot, app, version: pkg.version, architecture: pkg.eleArch || 'unknown' };
  }
  throw new BotError('Official QQNT not found. Use npm run qq:setup -- --from <QQ.exe>', 1501);
}

function inside(root, path) {
  const r = relative(resolve(root), resolve(path));
  return r !== '' && r !== '..' && !r.startsWith(`..\\`) && !r.startsWith('../') && !isAbsolute(r);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Stage a private copy; installed application and account directories are never edited.
export async function bundleQQ({ source = '', destination = './runtime/qq' } = {}) {
  const installation = discoverQQ(source), target = resolve(destination);
  if (inside(installation.root, target) || inside(target, installation.root) || target === installation.root) {
    throw new BotError('QQ runtime destination must be separate from the installed application', 1400);
  }
  if (existsSync(target)) throw new BotError('Runtime destination already exists; verify it or choose another directory', 1400);
  const stage = `${target}.staging-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  const filter = async path => {
    const { lstat } = await import('node:fs/promises');
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new BotError('QQ program contains a symbolic link; refusing ambiguous bundle', 1400);
    return !/(?:^|[\\/])(?:debug\.log|.*\.log|Crashpad|crash_dumps|nt_qq|User Data)$/i.test(path);
  };
  for (const item of await readdir(installation.root, { withFileTypes: true })) {
    if (item.isFile() && /\.(?:exe|dll)$/i.test(item.name) && !/^uninstall/i.test(item.name)) {
      await cp(join(installation.root, item.name), join(stage, item.name), { filter });
    }
  }
  const versionRelative = relative(installation.root, installation.versionRoot);
  await cp(installation.versionRoot, join(stage, versionRelative), { recursive: true, filter });
  if (versionRelative) {
    for (const name of ['config.json', 'channel.json']) {
      const path = join(installation.root, 'versions', name);
      if (existsSync(path)) await cp(path, join(stage, 'versions', name));
    }
  }
  const appRelative = relative(installation.root, installation.app), app = join(stage, appRelative);
  const files = [];
  async function inventory(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await inventory(path);
      else { const bytes = await readFile(path); files.push({ path: relative(stage, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) }); }
    }
  }
  await inventory(stage);
  const manifest = { schema: 1, version: installation.version, architecture: installation.architecture,
    source: 'official-qq-program-files', source_executable: installation.executable,
    created_at: new Date().toISOString(), executable: 'QQ.exe', app: appRelative.replaceAll('\\', '/'),
    entry_modified: false, binary_modified: false, files,
    validation: { launched: false, qr_received: false, authenticated: false, messages_received: false, messages_sent: false } };
  await writeFile(join(stage, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(stage, target);
  return { path: target, version: manifest.version, files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

export async function verifyRuntime(directory) {
  const root = resolve(directory), path = join(root, 'runtime.json');
  if (!existsSync(path)) throw new BotError('Bundled QQ runtime is missing; run npm run qq:setup', 1501);
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new BotError('Invalid QQ runtime manifest', 1501);
  for (const file of manifest.files) {
    const target = resolve(root, file.path);
    if (!inside(root, target)) throw new BotError('Invalid runtime inventory path', 1501);
    const bytes = await readFile(target);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new BotError(`Bundled QQ integrity mismatch: ${file.path}`, 1501);
  }
  if (!inside(root, resolve(root, manifest.executable)) || !inside(root, resolve(root, manifest.app))) throw new BotError('Invalid QQ runtime paths', 1501);
  return { ...manifest, root, executablePath: resolve(root, manifest.executable), appPath: resolve(root, manifest.app) };
}

export function kernelSymbols(installation) {
  const binary = readFileSync(join(installation.app, 'wrapper.node'));
  const names = ['NodeIQQNTWrapperSession', 'NodeIKernelLoginService', 'getQRCodePicture', 'onQRCodeGetPicture',
    'addKernelLoginListener', 'getMsgService', 'addKernelMsgListener', 'sendMsg', 'generateMsgUniqueId'];
  return Object.fromEntries(names.map(name => [name, binary.includes(Buffer.from(name))]));
}
