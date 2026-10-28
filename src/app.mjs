import { join } from 'node:path';
import { lockData } from './data-lock.mjs';
import { Store } from './store.mjs';
import { SessionVault } from './qq/session-vault.mjs';
import { loadDriver } from './qq/driver.mjs';
import { QQAdapter } from './qq/adapter.mjs';
import { AIClient } from './ai.mjs';
import { ReplyWorker } from './worker.mjs';
import { OneBotServer } from './onebot.mjs';
import { createLogger } from './logger.mjs';
import { MessageIdMap } from './qq/message-ids.mjs';
import { Settings } from './settings.mjs';
import { Telemetry } from './telemetry.mjs';
import { QzoneService } from './qzone/service.mjs';
import { describeDriverFault } from './qq/faults.mjs';
import { PluginService } from './plugins/service.mjs';
import { MemeService } from './memes/service.mjs';
import { VoiceStudioService } from './voicestudio/service.mjs';
import { AgentRuntime } from './agent/runtime.mjs';
import { AttachmentService } from './attachments/service.mjs';
import { GroupContext } from './group-context.mjs';
import { GroupChatPlus } from './group-chat-plus/service.mjs';

export async function createApp(config, overrides = {}) {
  const telemetry = overrides.telemetry || new Telemetry();
  const sink = overrides.log || createLogger();
  const sanitize = createLogger(line => {
    const { time, level, event, ...fields } = JSON.parse(line);
    telemetry.add('log', { level, event, fields });
  });
  const log = (level, event, fields) => { sanitize(level, event, fields); sink(level, event, fields); };
  const settings = new Settings(config, { path:overrides.settingsPath, lockedKeys:overrides.lockedKeys });
  const unlock = lockData(config.dataDir);
  let store, adapter, worker, server, qzone, plugins, memes, voicestudio,groupChatPlus;
  try {
    store = new Store(join(config.dataDir, 'bot.sqlite'),{retainIgnoredContent:config.retainIgnoredContent,
      onRedaction:fields=>log('info','ignored_job_content_redacted',fields)});
    const vault = new SessionVault(join(config.dataDir, 'sessions'), config.sessionKey);
    const ids = new MessageIdMap(store.db);
    const driver = overrides.driver || await loadDriver(config, vault, log, ids);
    adapter = new QQAdapter(driver, config);
    const groupContext=new GroupContext({store,config});
    const observe=event=>{telemetry.message(event);try{groupContext.observe(event);groupChatPlus?.observe(event);}catch{log('warn','group_context_failed');}};
    adapter.on('event', observe);
    adapter.on('outgoing', observe);
    adapter.on('state', () => log('info', 'qq_connection_changed', { state:adapter.status().online ? 'online' : 'offline' }));
    adapter.on('fault', error => log('warn', 'qq_driver_fault', describeDriverFault(error)));
    const ai = overrides.ai || new AIClient(config.ai);
    const attachments = new AttachmentService({store,adapter,config});
    memes = new MemeService({ store, adapter, config, log });
    voicestudio = new VoiceStudioService({ store, config, log });
    groupChatPlus=new GroupChatPlus({store,adapter,config,log,groupContext,ai,decisionAI:overrides.groupChatDecisionAI,imageAI:overrides.groupChatImageAI,
      ...(overrides.groupChatRandom?{random:overrides.groupChatRandom}:{}),...(overrides.groupChatNow?{now:overrides.groupChatNow}:{})});
    groupChatPlus.attachments=attachments;
    plugins = new PluginService({ store, adapter, log, config, retentionDays: config.retentionDays, memes, voicestudio,groupChatPlus });
    groupChatPlus.pluginFor=event=>plugins.findGroupChat(event);
    memes.pluginFor = event => plugins.findMeme(event);
    voicestudio.pluginFor = event => plugins.findVoice(event);
    qzone = new QzoneService({ store, config, log, transport: overrides.qzoneTransport, ai: overrides.qzoneAI });
    const agent = new AgentRuntime({ ai, store, config, log, plugins, memes, voicestudio, qzone, adapter, attachments,groupChatPlus });
    worker = new ReplyWorker({ adapter, store, ai:agent, config, log, memes, voicestudio, attachments, groupContext,groupChatPlus });
    server = new OneBotServer({ adapter, worker, store, config, log, telemetry, settings, qzone, plugins, memes, voicestudio, agent });
    // QR login may still be pending, but a broken driver must fail startup.
    await adapter.start();
    await server.start();
    store.cleanup(config.retentionDays, config.uncertainRetentionDays, config.jobMaxAge);
    agent.state.cleanup(config.retentionDays);
    await attachments.cleanup();
    worker.start();
    groupChatPlus.start();
    log('info', 'service_started', { port:server.server.address().port, driver:config.driver });
    const cleanup = setInterval(() => {
      try { store.cleanup(config.retentionDays, config.uncertainRetentionDays, config.jobMaxAge); groupContext.cleanup(); agent.state.cleanup(config.retentionDays); qzone.cleanup(); plugins.cleanup(); memes.cleanup(); voicestudio.cleanup().catch(()=>log('error','retention_cleanup_failed')); attachments.cleanup().catch(()=>log('error','retention_cleanup_failed')); } catch { log('error', 'retention_cleanup_failed'); }
    }, 3600000);
    let closing;
    return { config, adapter, store, worker, server, telemetry, settings, qzone, plugins, memes, voicestudio, agent, attachments, groupContext,groupChatPlus, address: server.server.address(),
      close() {
        if (!closing) closing = (async () => {
          clearInterval(cleanup);
          try {
            await server.close();
            await Promise.all([plugins.close(), memes.close(), voicestudio.close(), worker.close(),groupChatPlus.close()]);
            await qzone.close();
            await adapter.close();
          } finally { store.close(); unlock(); }
        })();
        return closing;
      }
    };
  } catch (error) {
    await server?.close().catch(() => {});
    await plugins?.close().catch(() => {});
    await groupChatPlus?.close().catch(()=>{});
    await voicestudio?.close().catch(() => {});
    await memes?.close().catch(() => {});
    await qzone?.close().catch(() => {});
    await worker?.close().catch(() => {});
    await adapter?.close().catch(() => {});
    store?.close(); unlock(); throw error;
  }
}
