export class BotError extends Error {
  constructor(message, code = 1500, options = {}) {
    super(message, options);
    this.code = code;
    this.uncertain = options.uncertain ?? false;
    this.retryable = options.retryable ?? false;
  }
}

export function ok(data = null) { return { status: 'ok', retcode: 0, data }; }
export function failure(error) {
  return { status: 'failed', retcode: error instanceof BotError ? error.code : 1500,
    data: null, message: error instanceof BotError ? error.message : 'Internal error' };
}

// On a mutation timeout the server cannot know whether QQ accepted the request.
// Never automatically retry an ambiguous mutation.
export async function deadline(fn, ms, { mutation = false, signal } = {}) {
  const controller = new AbortController();
  let timer;
  let abortListener;
  const cancelled = new Promise((_, reject) => {
    const abort = () => {
      controller.abort();
      reject(new BotError('Operation cancelled', 1502, { uncertain: mutation }));
    };
    abortListener = abort;
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new BotError('Driver operation timed out', 1502, { uncertain: mutation }));
    }, ms);
  });
  try { return await Promise.race([cancelled, Promise.resolve().then(() => fn(controller.signal))]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abortListener); }
}
