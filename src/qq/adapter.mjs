import { EventEmitter } from 'node:events';
import { BotError, deadline } from '../errors.mjs';
import { id, boolean, parseMessage, toCQ } from '../messages.mjs';
import { SendLimiter } from '../limiter.mjs';
import { hasMedia } from './kernel/elements.mjs';
import { PROJECT_ID } from '../brand.mjs';

export class QQAdapter extends EventEmitter {
  constructor(driver, config) {
    super(); this.driver = driver; this.config = config;
    this.controller = new AbortController();
    this.limiter = new SendLimiter(config.sendInterval, config.sessionInterval,
      { concurrency: config.sendConcurrency, maxPending: config.maxPendingSends });
    driver.on('message', m => {
      try {
        const user = id(m.sender?.user_id, 'sender.user_id');
        if (!['private', 'group'].includes(m.kind)) throw new BotError('Invalid driver message kind', 1400);
        const message = parseMessage(m.message);
        const event = { time: m.time ?? Math.floor(Date.now() / 1000), self_id: id(driver.account, 'account'),
          post_type: user === driver.account ? 'message_sent' : 'message', message_type: m.kind,
          sub_type: m.subType || (m.kind === 'group' ? 'normal' : 'friend'),
          message_id: id(m.id, 'message id', { signed: true }), user_id: user,
          message, raw_message: toCQ(message), font: 0, sender: { ...m.sender, user_id: user } };
        if (m.kind === 'group') { event.group_id = id(m.groupId, 'group ID'); event.anonymous = m.anonymous ?? null; }
        this.emit('event', event);
      } catch (e) { this.emit('fault', e); }
    });
    for (const type of ['notice', 'request']) driver.on(type, fields => {
      // These fields must already follow the documented OneBot event schemas.
      this.emit('event', { ...fields, time: fields.time ?? Math.floor(Date.now() / 1000),
        self_id: driver.account, post_type: type });
    });
    this.reconnectAttempt = 0; this.reconnectEnabled = true;
    driver.on('state', state => {
      if (driver.online) { this.reconnectAttempt = 0; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      else if (state.reconnect === true) this.scheduleReconnect();
      else if (state.reconnect === false) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.emit('state');
    });
    driver.on('fault', error => this.emit('fault', error));
  }
  status() { return { online: this.driver.online === true, good: this.driver.online === true,
    driver: this.driver.mode, simulated: this.driver.mode === 'demo',
    ...(this.driver.diagnostics ? { [this.driver.mode === 'kernel' ? 'kernel' : 'native']: this.driver.diagnostics() } : {}) }; }
  async start() {
    try {
      await deadline(signal => this.driver.connect({ signal }), this.config.rpcTimeout, { signal: this.controller.signal });
    } catch (error) {
      if (error.retryable) this.scheduleReconnect();
      throw error;
    }
  }
  scheduleReconnect() {
    if (this.controller.signal.aborted || this.reconnectTimer || !this.reconnectEnabled) return;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5)) + Math.floor(Math.random() * 300);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch(error => this.emit('fault', error));
    }, wait);
  }
  async close() { clearTimeout(this.reconnectTimer); this.limiter.close(); this.controller.abort(); await this.driver.close(); }
  async invoke(command, params = {}, { mutation = false, signal } = {}) {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    if (!this.driver.online && !command.startsWith('auth.')) throw new BotError('QQ driver is offline or not implemented', 1501, { retryable: true });
    const timeout=command==='message.get'||command==='image.get'||command==='message.send'&&hasMedia(params.message)?this.config.media?.timeout||90000:this.config.rpcTimeout;
    return deadline(s => this.driver.invoke(command, params, { signal: s }), timeout, { mutation, signal: combined });
  }
  async action(action, params = {}, context = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new BotError('params must be an object', 1400);
    switch (action) {
      case 'get_status': return this.status();
      case 'get_version_info': return { app_name: PROJECT_ID, app_version: '0.1.0', protocol_version: 'v11' };
      case 'can_send_image': return { yes: this.driver.capabilities.includes('media.image') };
      case 'can_send_record': return { yes: this.driver.capabilities.includes('media.record') };
      case 'get_login_info': return this.invoke('account.get', {}, context);
      case 'get_friend_list': return this.invoke('friend.list', {}, context);
      case 'get_group_list': return this.invoke('group.list', {}, context);
      case 'get_stranger_info': return this.invoke('user.get', { userId: id(params.user_id, 'user_id'), noCache: boolean(params.no_cache) }, context);
      case 'get_group_info': return this.invoke('group.get', { groupId: id(params.group_id, 'group_id'), noCache: boolean(params.no_cache) }, context);
      case 'get_group_member_list': return this.invoke('group.members', { groupId: id(params.group_id, 'group_id') }, context);
      case 'get_group_member_info': return this.invoke('group.member', { groupId: id(params.group_id, 'group_id'),
        userId: id(params.user_id, 'user_id'), noCache: boolean(params.no_cache) }, context);
      case 'get_msg': return this.invoke('message.get', { messageId: id(params.message_id, 'message_id', { signed: true }) }, context);
      case 'get_image': return this.invoke('image.get',{file:params.file},context);
      case 'delete_msg': return this.invoke('message.delete', { messageId: id(params.message_id, 'message_id', { signed: true }) }, { ...context, mutation: true });
      case 'send_msg':
      case 'send_private_msg':
      case 'send_group_msg': {
        const kind = action === 'send_private_msg' ? 'private' : action === 'send_group_msg' ? 'group' :
          (params.message_type ?? (params.group_id !== undefined ? 'group' : 'private'));
        if (!['private', 'group'].includes(kind)) throw new BotError('Invalid message_type', 1400);
        const target = id(kind === 'group' ? params.group_id : params.user_id, `${kind} target`);
        const message = parseMessage(params.message, boolean(params.auto_escape));
        const signal = context.signal ? AbortSignal.any([context.signal, this.controller.signal]) : this.controller.signal;
        const result = await this.limiter.run(`${kind}:${target}`, () => this.invoke('message.send', { kind, target, message },
          { ...context, mutation: true, signal }), signal);
        this.emit('outgoing', { time:Math.floor(Date.now()/1000), self_id:this.driver.account,
          post_type:'message_sent', message_type:kind, message_id:result?.message_id,
          user_id:this.driver.account, target_id:target, ...(kind==='group'?{group_id:target}:{}),
          sender:{user_id:this.driver.account}, message, raw_message:toCQ(message) });
        return result;
      }
      default: throw new BotError('OneBot action is not implemented', 1404);
    }
  }
  async login(command, params) {
    if (!['start', 'poll', 'logout'].includes(command)) throw new BotError('Unknown login operation', 1404);
    if (command === 'logout') {
      this.reconnectEnabled = false; clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    } else if (command === 'start') this.reconnectEnabled = true;
    return this.invoke(`auth.${command}`, params, { mutation: true });
  }
}
