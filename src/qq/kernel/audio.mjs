import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { BotError } from '../../errors.mjs';
import { ImageCache, DEFAULT_IMAGE_BYTES } from './image.mjs';
import { silkInfo } from './audio-codec.mjs';

export async function readAudio(source, { maxBytes = DEFAULT_IMAGE_BYTES, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof source !== 'string' || !source || source.length > 4 * Math.ceil(maxBytes / 3) + 256) throw new BotError('Invalid voice source or voice exceeds MEDIA_MAX_BYTES', 1400);
  let bytes;
  if (source.startsWith('base64://') || /^data:(?:audio\/[\w.+-]+|application\/octet-stream);base64,/i.test(source)) {
    const value = (source.startsWith('base64://') ? source.slice(9) : source.slice(source.indexOf(',') + 1)).replace(/[\t\r\n ]/g, '').replaceAll('-', '+').replaceAll('_', '/');
    if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BotError('Invalid base64 voice', 1400);
    bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new BotError('Invalid base64 voice', 1400);
  } else if (/^https?:\/\//i.test(source)) {
    let url = new URL(source), response;
    for (let n = 0; n <= 3; n++) {
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new BotError('Voice URL must be HTTP(S) without credentials', 1400);
      response = await fetch(url, { signal, redirect: 'manual', headers: { Accept: 'audio/*,application/octet-stream' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || n === 3) throw new BotError('Too many voice redirects', 1400);
      const next = new URL(location, url);
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new BotError('Voice redirect cannot downgrade HTTPS', 1400);
      url = next;
    }
    if (!response.ok) { await response.body?.cancel(); throw new BotError('Voice download failed', 1400); }
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new BotError('Voice exceeds MEDIA_MAX_BYTES', 1400); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new BotError('Voice exceeds MEDIA_MAX_BYTES', 1400); }
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks, size);
  } else {
    let path = source;
    if (/^file:/i.test(source)) {
      const url = new URL(source);
      if (url.hostname && url.hostname !== 'localhost') throw new BotError('Network voice file URLs are unsupported; use base64', 1400);
      path = fileURLToPath(url);
    } else if (!isAbsolute(path)) throw new BotError('Voice needs an absolute file path, file URL, HTTP(S) URL or base64', 1400);
    let handle;
    try {
      handle = await open(path, 'r'); const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new BotError('Voice is not a regular file or exceeds MEDIA_MAX_BYTES', 1400);
      bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) { signal?.throwIfAborted(); const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new BotError('Voice file was truncated', 1400); offset += read.bytesRead; }
    } catch (error) {
      if (error.code === 'ENOENT') throw new BotError('Voice file not found on the QQ bot host; use base64 in AstrBot', 1400);
      throw error;
    } finally { await handle?.close(); }
  }
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > maxBytes) throw new BotError('Voice is empty or exceeds MEDIA_MAX_BYTES', 1400);
  return bytes;
}

export async function encodeAudio(bytes, signal) {
  signal?.throwIfAborted();
  const start = bytes[0] === 2 ? 1 : 0;
  if (bytes.toString('ascii', start, start + 9) === '#!SILK_V3') return { bytes: start ? bytes : Buffer.concat([Buffer.from([2]),bytes]), ...silkInfo(bytes), waveAmplitudes: Array(32).fill(0) };
  const worker = new Worker(new URL('./audio-worker.mjs', import.meta.url), { workerData: bytes, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(new BotError('Voice conversion cancelled', 1502));
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('error', () => reject(new BotError('Voice encoder failed', 1500)));
      worker.once('exit', () => reject(new BotError('Voice encoder exited before completion', 1500)));
      worker.once('message', result => result.error ? reject(new BotError(result.error, result.code)) : resolve({ ...result, bytes: Buffer.from(result.bytes) }));
      if (signal?.aborted) abort();
    });
  } finally { signal?.removeEventListener('abort', abort); await worker.terminate(); }
}

export class VoiceCache extends ImageCache {
  constructor(directory, options = {}) { super(directory, options); this.timeout = options.timeout || 90000; this.pattern = /^[a-f0-9]{32}\.silk$/; }
  async acquire(source, { signal } = {}) {
    const operation = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeout)]);
    const bytes = await readAudio(source, { maxBytes: this.maxBytes, signal: operation });
    const voice = await encodeAudio(bytes, operation);
    if (voice.bytes.length > this.maxBytes) throw new BotError('Encoded voice exceeds MEDIA_MAX_BYTES', 1400);
    return this.retain({ ...voice, format: 'silk', md5: createHash('md5').update(voice.bytes).digest('hex') }, { signal: operation });
  }
  stage(voice, service, signal) { return super.stage(voice, service, signal, { elementType: 4 }); }
}
