import { BotError } from '../../errors.mjs';

// QQ's initialization callback runs before all service wrappers can be read.
// Yield back to the SDK before looking up services; do not fail that callback
// merely because a wrapper is still being installed in its native context.
export function waitForMessageService({ session, makeListener, onMessages, onMediaUpload = () => {}, onMediaDownload = () => {}, onKickedOffline = () => {}, timeout = 15000, signal, bind = true }) {
  let timer, retry, stopped = false, stage = 'service creation';
  return new Promise((resolve, reject) => {
    const finish = (error, service) => {
      if (stopped) return; stopped = true; clearTimeout(timer); clearTimeout(retry);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(service);
    };
    const abort = () => finish(new BotError('QQ message service binding cancelled', 1502));
    const attempt = () => {
      if (stopped) return;
      try {
        stage = 'transport readiness';
        if (Number(session.getMSFService().getMsfStatus()) !== 1) { retry = setTimeout(attempt, 25); return; }
        stage = 'message service creation'; const service = session.getMsgService();
        if (!service) { retry = setTimeout(attempt, 25); return; }
        stage = 'message listener binding';
        if (bind) service.addKernelMsgListener(makeListener({ onRecvMsg: value => onMessages(value, true),
          onMsgInfoListUpdate: value => onMessages(value, false), onRichMediaUploadComplete: onMediaUpload,
          onRichMediaDownloadComplete:onMediaDownload, onKickedOffLine: onKickedOffline }));
        finish(null, service);
      } catch (error) {
        if (error instanceof TypeError && /undefined|null|object/i.test(error.message)) retry = setTimeout(attempt, 25);
        else finish(new BotError(`QQ ${stage} failed`, 1500));
      }
    };
    timer = setTimeout(() => finish(new BotError(`QQ ${stage} timed out`, 1502)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else setImmediate(attempt);
  });
}
