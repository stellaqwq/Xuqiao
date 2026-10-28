import { BotError } from './errors.mjs';

export class SendLimiter {
  constructor(globalMs, sessionMs, { concurrency = 4, maxPending = 1000 } = {}) {
    this.globalMs = globalMs; this.sessionMs = sessionMs;
    this.concurrency = concurrency; this.maxPending = maxPending;
    this.lastGlobal = -Infinity; this.lastSession = new Map();
    this.queue = []; this.sessions = new Set(); this.active = 0; this.closed = false;
  }
  run(session, fn, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(this.cancelled());
    if (this.queue.length >= this.maxPending) return Promise.reject(new BotError('Send queue is full', 1503, { retryable: true }));
    return new Promise((resolve, reject) => {
      const entry = { session, fn, signal, resolve, reject };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1); signal.removeEventListener('abort', entry.abort);
        reject(this.cancelled()); this.pump();
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry); this.pump();
    });
  }
  cancelled() { return new BotError('Send cancelled before submission', 1502); }
  pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true; clearTimeout(this.timer); this.timer = null;
    try {
      while (this.active < this.concurrency) {
        let selected = -1, next = Infinity;
        const now = Date.now();
        for (let index = 0; index < this.queue.length; index++) {
          const entry = this.queue[index];
          if (entry.signal?.aborted) { entry.abort(); index--; continue; }
          if (this.sessions.has(entry.session)) continue;
          const wait = Math.max(0, this.lastGlobal + this.globalMs - now,
            (this.lastSession.get(entry.session) ?? -Infinity) + this.sessionMs - now);
          if (!wait) { selected = index; break; }
          next = Math.min(next, wait);
        }
        if (selected < 0) {
          if (next < Infinity) this.timer = setTimeout(() => this.pump(), next);
          break;
        }
        const [entry] = this.queue.splice(selected, 1);
        entry.signal?.removeEventListener('abort', entry.abort);
        this.active++; this.sessions.add(entry.session);
        this.lastGlobal = Date.now(); this.lastSession.set(entry.session, this.lastGlobal);
        for (const [key, timestamp] of this.lastSession) {
          if (timestamp < this.lastGlobal - Math.max(this.sessionMs, 60000)) this.lastSession.delete(key);
        }
        const finish = () => { this.active--; this.sessions.delete(entry.session); this.pump(); };
        let operation;
        try { operation = entry.fn(); } catch (error) { operation = Promise.reject(error); }
        Promise.resolve(operation).then(value => { finish(); entry.resolve(value); }, error => { finish(); entry.reject(error); });
      }
    } finally { this.pumping = false; }
  }
  close() {
    this.closed = true; clearTimeout(this.timer);
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener('abort', entry.abort); entry.reject(this.cancelled());
    }
  }
}
