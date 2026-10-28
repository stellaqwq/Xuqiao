import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { cleanup, waitFor } from './helpers.mjs';

// Run the actual host state machine with a synthetic SDK and filesystem. No
// official kernel, account directory, network login or real send is involved.
export async function kernelHost(t, { rpcTimeout = 1600, autoInitialize = true, sendMessage, getUin, getMessages, loginConnectDelay = 0 } = {}) {
  const events = new EventEmitter(), output = new EventEmitter(), packets = [], modules = new Map();
  let loginListener, dependencies, sessionListener, msf = 1, reads = 0, quickLogins = 0, quickLoginAllowed = false;
  let exited, sequence = 0, sends = 0;
  let loginListResponse, quickLoginResponse, loginListCalls = 0, qrRequests = 0;
  let autoLoginConnect = true, loginConnects = 0, qrResponse;
  let loginIsConnected = false, prematureLoginReads = 0;
  const connected = () => { loginIsConnected=true;loginListener.onLoginConnected(); };
  const messageListeners = [];
  const identity = { uin: '10000', uid: 'u_self' };
  const service = {
    getMsgsByMsgId: getMessages || (async () => ({msgList:[]})),
    addKernelMsgListener(value) { messageListeners.push(value); }, generateMsgUniqueId: () => String(++sequence + 1000),
    async sendMsg(id, peer, elements) {
      sends++;
      if (sendMessage) return sendMessage(id, peer, elements, messageListeners.at(-1));
      queueMicrotask(() => messageListeners.at(-1).onMsgInfoListUpdate([{ ...peer, msgId: id, sendStatus: 2, elements }]));
      return { result: 0 };
    }
  };
  const session = {
    getSessionId: () => 'synthetic-session', getMSFService: () => ({ getMsfStatus: () => { reads++; return msf; } }),
    getMsgService: () => service, getBuddyService: () => ({ addKernelBuddyListener() {} }), getGroupService: () => ({ addKernelGroupListener() {} }),
    getUixConvertService: () => ({ getUin: getUin || (async () => new Map()) }),
    init(_, depends, __, listener) {
      dependencies = depends; sessionListener = listener;
      if (autoInitialize) setImmediate(() => listener.onSessionInitComplete(0));
    }
  };
  const login = {
    addKernelLoginListener(value) { loginListener = value; }, initConfig() {},
    connect() { loginConnects++; if(autoLoginConnect){if(loginConnectDelay)setTimeout(connected,loginConnectDelay);else setImmediate(connected);} }, destroy() {},
    getLoginList: async () => {
      if(!loginIsConnected)prematureLoginReads++;
      loginListCalls++;
      return loginListResponse ? loginListResponse() : { result: 0, LocalLoginInfoList: quickLoginAllowed ? [{ uin: '10000', isQuickLogin: true }] : [] };
    },
    quickLoginWithUin: async () => {
      quickLogins++;
      if (quickLoginResponse) return quickLoginResponse();
      queueMicrotask(() => loginListener.onLoginState({ selfInfo: identity })); return { result: 0 };
    },
    getQRCodePicture() {
      qrRequests++;
      if(qrResponse)return qrResponse(loginListener);
      queueMicrotask(() => loginListener.onQRCodeGetPicture({ pngBase64QrcodeData: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), expireTime: 120 }));
    },
    startPolling() {}
  };
  const engine = { initWithDeskTopConfig: () => true, destroy() {} };
  const wrapper = {
    NodeIQQNTWrapperEngine: { get: () => engine }, NodeIKernelLoginService: { get: () => login },
    NodeIQQNTStartupSessionWrapper: { createWithModuleList: () => ({ getSessionIdList: () => new Map([['nt', 'synthetic-session']]), start() {}, stop() {} }) },
    NodeIQQNTWrapperSession: { getNTWrapperSession: () => session }
  };
  const cfg = { dataDir: 'synthetic', appPath: 'synthetic', kernelDir: 'synthetic', account: 10000, version: '9.9.36-53644', appid: '537391628', rpcTimeout };
  const processMock = {
    argv: ['node', 'host.mjs', Buffer.from(JSON.stringify(cfg)).toString('base64url')], connected: true, dlopen() {},
    send(packet, callback) { packets.push(structuredClone(packet)); output.emit('packet', packet); callback?.(); },
    on: events.on.bind(events), once: events.once.bind(events), stderr: { write() {} }, exit(code) { exited = code; }
  };
  const context = vm.createContext({ Buffer, Map, Set, process: processMock, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate });
  async function load(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    // Cache before asynchronous reads: concurrent import branches must share
    // one module instance, including the BotError class used by instanceof.
    const pending = createModule(identifier); modules.set(identifier, pending); return pending;
  }
  async function createModule(identifier) {
    let module;
    if (identifier.startsWith('node:')) {
      let values;
      if (identifier === 'node:module') values = { createRequire: () => () => wrapper };
      else if (identifier === 'node:fs') values = { existsSync: () => true, readFileSync: () => '{"machineId":"00000000-0000-0000-0000-000000000001"}', writeFileSync() {}, mkdirSync() {} };
      else values = await import(identifier);
      module = new vm.SyntheticModule(Object.keys(values), function() { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context, identifier });
    } else {
      let source = await readFile(fileURLToPath(identifier), 'utf8');
      if (identifier === new URL('../src/qq/kernel/host.mjs', import.meta.url).href) {
        source += '\nexport const inspectHost = () => ({ online, state, requests: requests.size, restoring: Boolean(restoring), login_waiters: callbacks.listenerCount("login-connected"), qr_waiters: callbacks.listenerCount("qrcode") });\n';
      }
      module = new vm.SourceTextModule(source, { context, identifier, initializeImportMeta(meta) { meta.url = identifier; } });
    }
    return module;
  }
  const host = await load(new URL('../src/qq/kernel/host.mjs', import.meta.url).href);
  await host.link((specifier, referencing) => load(specifier.startsWith('node:') ? specifier : new URL(specifier, referencing.identifier).href));
  await host.evaluate();
  cleanup(t, async () => { events.emit('message', { event: 'shutdown' }); await waitFor(() => exited !== undefined); });
  await waitFor(() => host.namespace.inspectHost().state === 'login_required');
  return {
    packets, messageListeners, inspect: () => ({ ...host.namespace.inspectHost() }),
    get reads() { return reads; }, get quickLogins() { return quickLogins; }, get sends() { return sends; },
    get loginListCalls() { return loginListCalls; }, get qrRequests() { return qrRequests; },
    get loginConnects() { return loginConnects; },
    get prematureLoginReads() { return prematureLoginReads; },
    setAutoLoginConnect(value) { autoLoginConnect=value; },
    loginDisconnected() { loginIsConnected=false;loginListener.onLoginDisConnected(); },
    loginConnected() { connected(); },
    setQRResponse(handler) { qrResponse=handler; },
    qrPicture(png=Buffer.from('89504e470d0a1a0a','hex').toString('base64')) { loginListener.onQRCodeGetPicture({pngBase64QrcodeData:png,expireTime:120}); },
    qrScanned() { loginListener.onQRCodeSessionUserScaned(); },
    qrFailed() { loginListener.onQRCodeSessionFailed(0,123); },
    setLoginListResponse(handler) { loginListResponse = handler; },
    setQuickLoginResponse(handler) { quickLoginResponse = handler; },
    setTransport(value) { msf = value; dependencies?.onMSFStatusChange(); },
    kick() { messageListeners.at(-1).onKickedOffLine(); },
    initialize() { sessionListener.onSessionInitComplete(0); },
    kickDuringInitialization() { sessionListener.onKickedOffLine(); },
    authenticate() { loginListener.onQRCodeLoginSucceed(identity); },
    savedLoginCallback() { loginListener.onLoginState({ selfInfo: identity }); },
    savedLoginFailed() { loginListener.onLoginFailed(-65534); },
    receive(raw) { messageListeners.at(-1).onRecvMsg([raw]); },
    update(raw) { messageListeners.at(-1).onMsgInfoListUpdate([raw]); },
    allowQuickLogin() { quickLoginAllowed = true; },
    request(command, params = {}) {
      const id = ++sequence;
      const result = new Promise(resolve => {
        const receive = packet => { if (packet.id === id) { output.off('packet', receive); resolve(packet); } };
        output.on('packet', receive);
      });
      events.emit('message', { id, command, params }); return { id, result };
    },
    cancel(id) { events.emit('message', { cancel: id }); }
  };
}
