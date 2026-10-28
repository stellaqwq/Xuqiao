import { parentPort, workerData } from 'node:worker_threads';
import { encode } from 'silk-wasm';
import { wavToPCM, silkInfo } from './audio-codec.mjs';

try {
  const bytes = Buffer.from(workerData), { pcm, waveAmplitudes } = wavToPCM(bytes);
  const encoded = Buffer.from((await encode(pcm, 24000)).data);
  parentPort.postMessage({ bytes: encoded, ...silkInfo(encoded), waveAmplitudes });
} catch (error) {
  parentPort.postMessage({ error: error.code === 1400 ? error.message : 'Audio encoding failed', code: error.code || 1500 });
}
