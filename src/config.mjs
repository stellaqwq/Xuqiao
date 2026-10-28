import { resolve } from 'node:path';
const environments = new WeakMap();
export const environmentOf = config => environments.get(config);
export const encodedPrefix = 'qqai-base64:v1:';
export function decodeEnvironment(source) {
  const env = { ...source };
  for (const [key,value] of Object.entries(env)) {
    if (typeof value!=='string' || !value.startsWith(encodedPrefix)) continue;
    const encoded=value.slice(encodedPrefix.length), bytes=Buffer.from(encoded,'base64');
    if (bytes.toString('base64')!==encoded) throw new Error('Invalid encoded configuration: '+key);
    env[key]=bytes.toString('utf8');
  }
  return env;
}

function number(env, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
  return n;
}
function optionalDecimal(env, key, min, max) {
  const value = env[key];
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
  return n;
}
function bool(env, key, fallback = false) {
  if (env[key] === undefined || env[key] === '') return fallback;
  if (!['true', 'false'].includes(env[key])) throw new Error(`${key} must be true or false`);
  return env[key] === 'true';
}
function ids(value = '', label = '') {
  const values = value.split(',').map(s => s.trim()).filter(Boolean);
  if (values.some(s => !/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s)))) {
    throw new Error(label === 'BOT_ADMIN_IDS' ? 'BOT_ADMIN_IDS 必须为逗号分隔的有效 QQ 号。' : 'Allowlist entries must be positive safe integer QQ IDs');
  }
  return new Set(values.map(String));
}
function groupBlockedUsers(value = '') {
  const rules = value.replaceAll('：', ':').split(/[\n\r,，;；]+/).map(s => s.trim()).filter(Boolean);
  if (rules.length > 500) throw new Error('GROUP_BLOCKED_USERS 最多填写 500 条屏蔽规则。');
  const result = new Map();
  for (const rule of rules) {
    const match = /^(\*|[1-9]\d*)\s*:\s*([1-9]\d*)$/.exec(rule);
    if (!match || !Number.isSafeInteger(Number(match[2])) || match[1] !== '*' && !Number.isSafeInteger(Number(match[1]))) {
      throw new Error('GROUP_BLOCKED_USERS 请按“群号:QQ号”填写，每行一条；所有群使用“*:QQ号”。');
    }
    const [,group,user] = match;
    if (!result.has(group)) result.set(group, new Set());
    result.get(group).add(user);
  }
  return result;
}
function url(value, schemes) {
  const parsed = new URL(value);
  if (!schemes.includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Invalid endpoint URL (credentials in URLs are not allowed)');
  }
  return parsed.toString();
}
export function loadConfig(env = process.env) {
  env = decodeEnvironment(env);
  const token = env.ONEBOT_ACCESS_TOKEN ?? '';
  if (token.length < 24) throw new Error('ONEBOT_ACCESS_TOKEN must contain at least 24 characters; run npm run init');
  const adminToken = env.ADMIN_ACCESS_TOKEN ?? '';
  if (adminToken.length < 24) throw new Error('ADMIN_ACCESS_TOKEN must contain at least 24 characters; run npm run init');
  if (adminToken === token) throw new Error('ADMIN_ACCESS_TOKEN must differ from ONEBOT_ACCESS_TOKEN; run npm run init');
  const reverseToken = env.REVERSE_WS_TOKEN || token;
  if (adminToken === reverseToken) throw new Error('ADMIN_ACCESS_TOKEN must differ from REVERSE_WS_TOKEN; run npm run init');
  const sessionKey = env.SESSION_KEY ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(sessionKey)) throw new Error('SESSION_KEY must be a random 32-byte hex key; run npm run init');
  const enabled = bool(env, 'AI_ENABLED');
  const allowedUsers = ids(env.AI_ALLOWED_USERS);
  const allowedGroups = ids(env.AI_ALLOWED_GROUPS);
  if (enabled && !allowedUsers.size && !allowedGroups.size) throw new Error('AI requires an explicit user/group allowlist');
  if (enabled && !env.AI_MODEL?.trim()) throw new Error('AI_MODEL is required when AI_ENABLED=true');
  const reasoningEffort = env.AI_REASONING_EFFORT || '';
  if (!['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error('Invalid AI_REASONING_EFFORT');
  const driver = env.QQ_DRIVER || 'kernel';
  let mediaBaseUrl='';
  if(env.MEDIA_BASE_URL){
    const parsed=new URL(url(env.MEDIA_BASE_URL,['http:','https:']));
    if(parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('MEDIA_BASE_URL must be an HTTP(S) origin without a path, query or fragment');
    mediaBaseUrl=parsed.origin;
  }
  const config = {
    host: env.HOST || '127.0.0.1', port: number(env, 'PORT', 5700, 0, 65535), token, adminToken, sessionKey,
    dataDir: resolve(env.DATA_DIR || './data'), driver, adminIds: ids(env.BOT_ADMIN_IDS, 'BOT_ADMIN_IDS'),
    blockedGroupUsers: groupBlockedUsers(env.GROUP_BLOCKED_USERS),
    qzone: { allowCookieExport: bool(env, 'QZONE_ALLOW_COOKIE_EXPORT') },
    reply: { atSender: bool(env, 'REPLY_AT_SENDER', true), quoteMessage: bool(env, 'REPLY_QUOTE_MESSAGE', true) },
    account: number(env, 'QQ_ACCOUNT', 0), rpcTimeout: number(env, 'QQ_RPC_TIMEOUT_MS', 15000, 10),
    maxRequestBytes:number(env,'ONEBOT_MAX_REQUEST_BYTES',16*1024*1024,1024*1024,128*1024*1024),
    media:{baseUrl:mediaBaseUrl,maxBytes:number(env,'MEDIA_MAX_BYTES',10*1024*1024,1024,50*1024*1024),
      timeout:number(env,'MEDIA_TIMEOUT_MS',90000,1000,300000),retentionDays:number(env,'MEDIA_CACHE_DAYS',7,1,365)},
    kernel: { runtime: resolve(env.QQ_RUNTIME_DIR || './runtime/qq'), directory: resolve(env.QQ_KERNEL_DIR || './runtime/kernel'),
      data: resolve(env.QQ_KERNEL_DATA || `${env.DATA_DIR || './data'}/qq-kernel`),
      shutdownTimeout: number(env, 'QQ_SHUTDOWN_TIMEOUT_MS', 5000, 100, 20000) },
    native: {
      host: env.QQ_SERVER_HOST || 'msfwifi.3g.qq.com', port: number(env, 'QQ_SERVER_PORT', 8080, 1, 65535),
      profilePath: env.QQ_PROFILE ? resolve(env.QQ_PROFILE) : '',
      signUrl: env.QQ_SIGN_URL ? url(env.QQ_SIGN_URL, ['http:', 'https:']) : '', signToken: env.QQ_SIGN_TOKEN || ''
    },
    heartbeatMs: number(env, 'HEARTBEAT_MS', 30000, 100),
    reverseUrls: (env.REVERSE_WS_URLS || '').split(',').filter(Boolean).map(s => url(s.trim(), ['ws:', 'wss:'])),
    reverseToken,
    webhookUrl: env.WEBHOOK_URL ? url(env.WEBHOOK_URL, ['http:', 'https:']) : '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    sendInterval: number(env, 'SEND_INTERVAL_MS', 1500),
    sessionInterval: number(env, 'SESSION_INTERVAL_MS', 3000),
    sendConcurrency: number(env, 'SEND_CONCURRENCY', 4, 1, 16),
    maxPendingSends: number(env, 'MAX_PENDING_SENDS', 1000, 1, 10000),
    sendMaxAttempts: number(env, 'SEND_MAX_ATTEMPTS', 5, 1, 16),
    jobMaxAge: number(env, 'JOB_MAX_AGE_MS', 600000, 1000),
    maxPending: number(env, 'MAX_PENDING_JOBS', 1000, 1),
    retentionDays: number(env, 'HISTORY_RETENTION_DAYS', 7, 1),
    retainIgnoredContent:bool(env, 'RETAIN_IGNORED_JOB_CONTENT', false),
    uncertainRetentionDays: number(env, 'UNCERTAIN_RETENTION_DAYS', 30, 1, 3650),
    agent: {
      enabled: bool(env, 'AGENT_ENABLED', true),
      maxSteps: number(env, 'AGENT_MAX_STEPS', 8, 1, 24),
      maxToolCalls: number(env, 'AGENT_MAX_TOOL_CALLS', 16, 1, 64),
      timeout: number(env, 'AGENT_TIMEOUT_MS', 300000, 1000, 600000)
    },
    ai: {
      stripEmoji: bool(env, 'AI_STRIP_EMOJI', true),
      stream: bool(env, 'AI_STREAM_ENABLED', true),
      streamChunkChars: number(env, 'AI_STREAM_CHUNK_CHARS', 240, 40, 1000),
      enabled, baseUrl: url(env.AI_BASE_URL || 'http://127.0.0.1:11434/v1', ['http:', 'https:']),
      apiKey: env.AI_API_KEY || '', model: env.AI_MODEL || '', reasoningEffort, allowedUsers, allowedGroups,
      maxOutputTokens: number(env, 'AI_MAX_OUTPUT_TOKENS', 0, 0, 131072),
      temperature: optionalDecimal(env, 'AI_TEMPERATURE', 0, 2),
      topP: optionalDecimal(env, 'AI_TOP_P', 0, 1),
      presencePenalty: optionalDecimal(env, 'AI_PRESENCE_PENALTY', -2, 2),
      visionEnabled: bool(env, 'AI_VISION_ENABLED', true),
      attachmentMaxChars: number(env, 'AI_ATTACHMENT_MAX_CHARS', 24000, 1000, 100000),
      pdfMaxPages: number(env, 'AI_PDF_MAX_PAGES', 40, 1, 200),
      requireAt: bool(env, 'AI_GROUP_REQUIRE_AT', true),
      groupContextEnabled: bool(env, 'AI_GROUP_CONTEXT_ENABLED', true),
      groupContextMessages: number(env, 'AI_GROUP_CONTEXT_MESSAGES', 30, 1, 200),
      groupContextTtl: number(env, 'AI_GROUP_CONTEXT_TTL_MS', 900000, 1000, 86400000),
      groupContextMaxChars: number(env, 'AI_GROUP_CONTEXT_MAX_CHARS', 8000, 1000, 32000),
      systemPrompt: env.AI_SYSTEM_PROMPT || '你是用户的 QQ AI 助手。简洁、诚实地回答，不要声称自己是人类。',
      timeout: number(env, 'AI_TIMEOUT_MS', 45000, 10), maxAttempts: number(env, 'AI_MAX_ATTEMPTS', 3, 1, 10),
      concurrency: number(env, 'AI_CONCURRENCY', 4, 1, 16),
      contextTurns: number(env, 'AI_CONTEXT_TURNS', 10, 0, 100),
      maxInputChars: number(env, 'AI_MAX_INPUT_CHARS', 8000, 1),
      maxReplyChars: number(env, 'AI_MAX_REPLY_CHARS', 1800, 1)
    }
  };
  environments.set(config, { ...env });
  return config;
}
