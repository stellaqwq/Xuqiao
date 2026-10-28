import { QQDriver } from './driver.mjs';
import { BotError } from '../errors.mjs';

// Opt-in fixture only: no QQ network connection or authentic account exists.
export class DemoDriver extends QQDriver {
  constructor(options) { super(options); this.messages = new Map(); this.nextId = 1; }
  get mode() { return 'demo'; }
  get capabilities() { return ['message.send', 'message.at', 'message.reply', 'message.get', 'message.delete', 'account.get', 'friend.list', 'group.list']; }
  async connect() { this.online = true; this.emit('state', { online: true, account: this.account }); }
  async invoke(command, params) {
    if (!this.online) throw new BotError('Demo driver is offline', 1501, { retryable: true });
    switch (command) {
      case 'account.get': return { user_id: this.account, nickname: 'DEMO（模拟账号）' };
      case 'friend.list': return [{ user_id: 10001, nickname: 'DEMO 用户', remark: '' }];
      case 'group.list': return [];
      case 'message.send': {
        const id = this.nextId++;
        const message = { message_id: id, real_id: id, time: Math.floor(Date.now() / 1000),
          message_type: params.kind, message: params.message, sender: { user_id: this.account },
          ...(params.kind === 'group' ? { group_id: params.target } : { user_id: params.target }) };
        this.messages.set(id, message);
        return { message_id: id };
      }
      case 'message.get': {
        const message = this.messages.get(params.messageId);
        if (!message) throw new BotError('Message not found in demo memory', 1404);
        return message;
      }
      case 'message.delete': this.messages.delete(params.messageId); return null;
      default: throw new BotError('Command is not supported by demo driver', 1404);
    }
  }
  inject(message) { this.emit('message', message); }
}
