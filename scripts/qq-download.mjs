import { readFile, writeFile, mkdir, stat, rename, readdir } from 'node:fs/promises';
import { existsSync, createWriteStream, createReadStream } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { bundleQQ, discoverQQ } from '../src/qq/kernel/runtime.mjs';

const CONFIG = 'https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json';
const SIGN = 'https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign';
function officialURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'qqdl.gtimg.cn' || url.username || url.password) throw new Error('Unexpected official QQ download URL');
  return url;
}
async function sha256(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function verifyPublisher(file) {
  const code = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $s = Get-AuthenticodeSignature -LiteralPath $env:QQ_VERIFY_FILE; [pscustomobject]@{ status=$s.Status.ToString(); subject=$s.SignerCertificate.Subject; thumbprint=$s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress';
  const environment = { ...process.env, QQ_VERIFY_FILE: file }; delete environment.PSModulePath;
  const modernShell = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  const result = execFileSync(existsSync(modernShell) ? modernShell : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    env: environment, windowsHide: true, encoding: 'utf8', timeout: 30000
  });
  const signature = JSON.parse(result.trim());
  if (signature.status !== 'Valid' || !/Tencent Technology/.test(signature.subject || '')) throw new Error('QQ installer does not have a valid Tencent Authenticode signature');
  return signature;
}
async function findQQ(directory, depth = 0) {
  if (depth > 8) return null;
  const executable = join(directory, 'QQ.exe');
  if (existsSync(executable)) { try { return discoverQQ(executable); } catch {} }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) { const found = await findQQ(join(directory, entry.name), depth + 1); if (found) return found; }
  }
  return null;
}
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Official QQ preparation currently supports Windows x64');
  const release = await fetch(CONFIG, { signal: AbortSignal.timeout(20000) }).then(r => { if (!r.ok) throw new Error('Official QQ release configuration unavailable'); return r.json(); });
  const windows = release.Windows;
  if (!windows || !/^\d+\.\d+\.\d+$/.test(windows.version)) throw new Error('Invalid official QQ release metadata');
  const url = officialURL(windows.ntDownloadX64Url), name = basename(url.pathname);
  if (!/^[\w.-]+\.exe$/.test(name)) throw new Error('Invalid QQ installer filename');
  const downloads = resolve('runtime/downloads'); await mkdir(downloads, { recursive: true });
  const file = join(downloads, name), partial = file + '.partial';
  if (!existsSync(file)) {
    const signed = await fetch(SIGN, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-oidb': JSON.stringify({ uint32_command: '0x9b8e', uint32_service_type: 1 }), Referer: 'https://im.qq.com/' },
      body: JSON.stringify({ url: url.toString() }), signal: AbortSignal.timeout(20000) }).then(r => r.json());
    if (signed.retcode !== 0 || !signed.data?.url) throw new Error('Official QQ download signing failed');
    const signedURL = officialURL(signed.data.url);
    let complete = false;
    for (let attempt = 0; attempt < 3 && !complete; attempt++) {
      try {
        const offset = await stat(partial).then(s => s.size).catch(() => 0);
        const response = await fetch(signedURL, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(300000) });
        if (!response.ok) throw new Error(`QQ download HTTP ${response.status}`);
        if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Unexpected QQ download range');
        process.stdout.write(`Downloading official QQ ${windows.version} (${response.headers.get('content-length') || '?'} bytes)\n`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: response.status === 206 ? 'a' : 'w' }));
        await rename(partial, file); complete = true;
      } catch (error) { if (attempt === 2) throw error; }
    }
  }
  const signature = verifyPublisher(file);
  const provenance = { version: windows.version, update_date: windows.updateDate, source_config: CONFIG, url: url.toString(),
    sha256: await sha256(file), bytes: (await stat(file)).size, signature, verified_at: new Date().toISOString() };
  await writeFile(file + '.json', JSON.stringify(provenance, null, 2) + '\n');
  process.stdout.write(`Tencent signature verified; SHA256 ${provenance.sha256}\n`);
  if (process.argv.includes('--prepare')) {
    const unpacked = resolve(`runtime/unpacked-${windows.version}`), target = resolve(`runtime/qq-${windows.version}`);
    if (!existsSync(target)) {
      let installation = existsSync(unpacked) ? await findQQ(unpacked) : null;
      if (!installation) {
        const sevenZip = process.env.QQ_7ZIP || 'C:\\Program Files\\7-Zip\\7z.exe';
        const extraction = spawnSync(sevenZip, ['x', '-y', '-bd', `-o${unpacked}`, file], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
        if (extraction.error || extraction.status !== 0) throw new Error('7-Zip extraction failed; set QQ_7ZIP to 7z.exe');
        installation = await findQQ(unpacked);
      }
      if (!installation) throw new Error('Official package layout is unsupported; no QQNT application found');
      await bundleQQ({ source: installation.executable, destination: target });
    }
    const kernel = resolve(`runtime/kernel-${windows.version}`);
    const build = spawnSync(process.execPath, [resolve('scripts/qq-build.mjs')], { windowsHide: true, stdio: 'inherit',
      env: { ...process.env, QQ_RUNTIME_DIR: target, QQ_KERNEL_DIR: kernel } });
    if (build.status !== 0) throw new Error('QQ native host adaptation failed');
    if (process.argv.includes('--activate')) {
      if (!existsSync('.env')) throw new Error('Run npm run init before activating the QQ runtime');
      let env = await readFile('.env', 'utf8');
      for (const [key, value] of Object.entries({ QQ_DRIVER: 'kernel', QQ_RUNTIME_DIR: target, QQ_KERNEL_DIR: kernel })) {
        const pattern = new RegExp(`^${key}=.*$`, 'm'); env = pattern.test(env) ? env.replace(pattern, `${key}=${value}`) : env + `\n${key}=${value}\n`;
      }
      await writeFile('.env', env, { mode: 0o600 });
    }
    process.stdout.write(JSON.stringify({ version: windows.version, runtime: target, kernel, activated: process.argv.includes('--activate'), restart_required: true }, null, 2) + '\n');
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
