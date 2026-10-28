import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// A dedicated SQLite file supplies an OS-backed exclusive lock. It is never
// deleted or replaced, so stale-PID recovery cannot unlink another owner's lock.
export function lockData(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(directory, 'runtime-lock.sqlite'));
  const path = join(directory, 'runtime.lock');
  const owner = JSON.stringify({ schema: 2, pid: process.pid, token: randomUUID() }) + '\n';
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (error) {
    database.close();
    if ([5, 6].includes(error.errcode & 255) || /database.*locked/i.test(error.message)) throw new Error('Another QQ bot instance owns DATA_DIR');
    throw error;
  }
  try {
    // Older running versions only hold this PID marker. Respect their owner
    // during upgrades; all new versions serialize recovery under the DB lock.
    let previous;
    try { previous = readFileSync(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read runtime lock'); }
    if (previous !== undefined) {
      let marker;
      try { marker = JSON.parse(previous); } catch {}
      const currentFormat = marker?.schema === 2 && Number.isSafeInteger(marker.pid) && marker.pid > 0 &&
        typeof marker.token === 'string' && /^[a-f0-9-]{36}$/i.test(marker.token);
      // A v2 owner must hold the SQLite lock. Acquiring it proves that marker
      // stale even when the OS reuses its PID (common after container restarts).
      if (!currentFormat) {
        const pid = Number(previous);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid runtime.lock; inspect it before removing it');
        let live = true;
        try { process.kill(pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') live = false;
          else throw new Error('Cannot verify runtime.lock ownership');
        }
        if (live) throw new Error('Another QQ bot instance owns DATA_DIR');
      }
    }
    writeFileSync(temporary, owner, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    database.close(); throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (readFileSync(path, 'utf8') === owner) unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { database.close(); }
  };
}
