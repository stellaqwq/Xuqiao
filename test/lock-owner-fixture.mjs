import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockData } from '../src/data-lock.mjs';

const directory = process.argv[2];
if (process.argv[3] === 'pause-stale-check') {
  const kill = process.kill;
  process.kill = function(pid, signal) {
    if (pid === 2147483646 && signal === 0) {
      writeFileSync(join(directory, 'checking-stale-owner'), '1');
      const deadline = Date.now() + 10000;
      while (!existsSync(join(directory, 'continue-owner-check'))) {
        if (Date.now() > deadline) throw new Error('Lock fixture barrier expired');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return kill.call(process, pid, signal);
  };
}
try {
  const release = lockData(directory);
  process.on('message', packet => { if (packet === 'close') { release(); process.disconnect(); } });
  process.send({ owned: true });
} catch (error) {
  process.send({ error: error.message }, () => process.disconnect());
}
