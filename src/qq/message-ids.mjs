import { BotError } from '../errors.mjs';
import { id } from '../messages.mjs';

/** Stable mapping of driver-native IDs to OneBot signed-int32 message IDs. */
export class MessageIdMap {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS native_message_ids (
      onebot_id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, native_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account,native_id)
    )`);
    if (!db.prepare('PRAGMA table_info(native_message_ids)').all().some(column => column.name === 'last_seen')) {
      db.exec('ALTER TABLE native_message_ids ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0');
    }
    // Give pre-migration mappings a full retention window before pruning.
    db.prepare('UPDATE native_message_ids SET last_seen=? WHERE last_seen=0').run(Math.floor(Date.now() / 1000));
    db.exec('CREATE INDEX IF NOT EXISTS native_message_ids_seen ON native_message_ids(last_seen)');
  }
  allocate(account, nativeId) {
    const owner = String(id(account, 'account'));
    if (typeof nativeId !== 'string' || !nativeId.length || nativeId.length > 2048) throw new BotError('Invalid native message ID', 1400);
    // The single runtime lock guarantees allocation cannot race another writer.
    const known = this.db.prepare('SELECT onebot_id,last_seen FROM native_message_ids WHERE account=? AND native_id=?').get(owner, nativeId);
    const now = Math.floor(Date.now() / 1000);
    if (known) {
      if (known.last_seen !== now) this.db.prepare('UPDATE native_message_ids SET last_seen=? WHERE onebot_id=?').run(now, known.onebot_id);
      return known.onebot_id;
    }
    const max = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='native_message_ids'").get()?.seq ?? 0;
    if (max >= 2147483647) throw new BotError('OneBot message ID space exhausted', 1500);
    return Number(this.db.prepare('INSERT INTO native_message_ids(account,native_id,last_seen) VALUES (?,?,?)').run(owner, nativeId, now).lastInsertRowid);
  }
  resolve(account, messageId) {
    return this.db.prepare('SELECT native_id FROM native_message_ids WHERE account=? AND onebot_id=?')
      .get(String(id(account, 'account')), id(messageId, 'message_id', { signed: true }))?.native_id ?? null;
  }
}
