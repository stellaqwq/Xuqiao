import { BotError } from '../../errors.mjs';

export async function abortable(operation, signal) {
  signal?.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new BotError('QQ kernel operation cancelled', 1502, { retryable: true }));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
  finally { signal?.removeEventListener('abort', abort); }
}

export async function quickLoginAccount(login, account, signal) {
  signal?.throwIfAborted();
  const response = await abortable(() => login.getLoginList(), signal);
  signal?.throwIfAborted();
  if (!response || Number(response.result) !== 0 || !Array.isArray(response.LocalLoginInfoList)) {
    throw new BotError('QQ local login records are unavailable', 1501, { retryable: true });
  }
  const candidates = response.LocalLoginInfoList.filter(entry => /^[1-9]\d*$/.test(entry.uin) &&
    Number.isSafeInteger(Number(entry.uin)) && (entry.isQuickLogin || entry.isAutoLogin) && (!account || Number(entry.uin) === account));
  // Never choose arbitrarily between two accounts sharing a data directory.
  if (candidates.length !== 1) return null;
  const selected = candidates[0];
  const result = await abortable(() => login.quickLoginWithUin(selected.uin), signal);
  signal?.throwIfAborted();
  if (!result || Number(result.result) !== 0) throw new BotError('QQ saved login requires fresh QR authentication', 1401);
  return Number(selected.uin);
}

export async function shutdownKernel({ tracker, requests, startup, login, engine }) {
  for (const controller of requests.values()) controller.abort();
  tracker.close();
  // Preserve the SDK's own credential store and let services close their DBs.
  let failure;
  for (const [owner, method] of [[startup, 'stop'], [login, 'destroy'], [engine, 'destroy']]) {
    try { if (typeof owner?.[method] === 'function') await owner[method](); }
    catch (error) { failure ||= error; }
  }
  if (failure) throw new BotError('QQ kernel shutdown failed', 1500);
}
