import { parentPort, workerData } from 'node:worker_threads';
import { pluginResult } from './result.mjs';

// Each invocation has its own module cache and thread. The parent owns the
// deadline and all QQ sends. This isolates faults, not filesystem privileges.
let stage = 'syntax_error';
try {
  const module = await import('data:text/javascript;base64,' + Buffer.from(workerData.source).toString('base64'));
  if (typeof module.default !== 'function' || workerData.tools?.length && typeof module.invokeTool !== 'function') {
    parentPort.postMessage({ error: 'invalid_export' });
  } else if (workerData.mode === 'validate') {
    parentPort.postMessage({ result: null });
  } else {
    stage = 'runtime_error';
    const value = await (workerData.mode === 'tool' ? module.invokeTool(workerData.context) : module.default(workerData.context));
    stage = 'invalid_result';
    if (workerData.mode === 'tool') {
      const encoded = JSON.stringify(value);
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 30000) throw Error();
      parentPort.postMessage({result:JSON.parse(encoded)});
    } else parentPort.postMessage({ result: pluginResult(value) });
  }
} catch { parentPort.postMessage({ error: stage }); }
