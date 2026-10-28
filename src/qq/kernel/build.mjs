import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRuntime } from './runtime.mjs';
import { adaptKernelToNode } from './pe.mjs';
import { buildBridgeImage } from './bridge-image.mjs';
import { sdkAppId } from './profile.mjs';

// Generated host files depend on the local Node executable and absolute
// runtime paths. Rebuild them on this computer instead of shipping stale ones.
export async function buildKernel({ runtimeDirectory = './runtime/qq', directory = './runtime/kernel' } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('QQ kernel host currently supports Windows x64 only');
  const runtime = await verifyRuntime(runtimeDirectory);
  const original = await readFile(join(runtime.appPath, 'wrapper.node')), host = await readFile(process.execPath);
  const adaptation = adaptKernelToNode(original, host);
  const major = await readFile(join(runtime.appPath, 'major.node'));
  const target = resolve(directory); await mkdir(target, { recursive:true });
  await writeFile(join(target, 'QQNT.def'), adaptation.definition);
  await writeFile(join(target, 'QQNT.dll'), buildBridgeImage(adaptation.imports));
  await writeFile(join(target, 'wrapper.node'), adaptation.adapted);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const metadata = { schema:1, version:runtime.version, host_version:process.versions.node, host_sha256:sha(host),
    official_kernel_sha256:sha(original), adapted_kernel_sha256:sha(adaptation.adapted),
    bridge_sha256:sha(await readFile(join(target,'QQNT.dll'))), runtime_root:runtime.root,
    app_path:runtime.appPath, version_path:dirname(dirname(runtime.appPath)),
    changes:adaptation.changes, required_exports:adaptation.required_exports,
    major_sha256:sha(major), sdk_app_id:sdkAppId(major),
    validation:{loaded:false,qr_received:false,authenticated:false,messages_received:false,messages_sent:false} };
  // Write the readiness marker last, after all generated binaries exist.
  await writeFile(join(target,'adapter.json'), JSON.stringify(metadata,null,2)+'\n');
  return { path:target, version:runtime.version, required_exports:metadata.required_exports };
}
