import { QQDriver } from '../src/qq/driver.mjs';
import { BotError } from '../src/errors.mjs';

// This is an implementation template, not a working QQ network driver.
// Use QQ_DRIVER=./examples/native-driver.mjs to exercise the loading contract.
export function createDriver({ account, vault, ids, log }) {
  return new NativeQQDriver({ account, vault, ids, log });
}

class NativeQQDriver extends QQDriver {
  constructor({ account, vault, ids, log }) {
    super({ account }); Object.assign(this, { vault, ids, log });
  }
  async connect({ signal }) {
    signal.throwIfAborted();
    // TODO: establish an independently implemented QQ connection and restore a
    // validated session. Only mark online after a server-authenticated result.
    this.online = false;
  }
  async invoke(command, params, { signal }) {
    signal.throwIfAborted();
    switch (command) {
      case 'auth.start':
        // TODO: return a real server-issued QR image/handle, never a fake QR.
        throw new BotError('Native QR login is not implemented', 1501);
      case 'auth.poll':
        throw new BotError('Native QR polling is not implemented', 1501);
      case 'auth.logout':
        throw new BotError('Native logout is not implemented', 1501);
      case 'message.send':
        // TODO: encode params.message, send once, correlate the server ACK.
        // Timeout AFTER a write: throw new BotError(...,1502,{uncertain:true}).
        throw new BotError('Native message sending is not implemented', 1501);
      default:
        throw new BotError('Native command is not implemented', 1404);
    }
  }
  // Call this only after a real inbound QQ message has been authenticated and
  // decoded by your core. nativeId must also distinguish conversation/sender.
  onDecodedMessage({ nativeId, kind, sender, message, groupId, time }) {
    const messageId = this.ids.allocate(this.account, nativeId);
    this.emit('message', { id: messageId, kind, sender, message, groupId, time });
  }
}
