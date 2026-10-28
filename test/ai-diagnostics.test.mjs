import { replyBody } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AIClient, describeAIFailure } from '../src/ai.mjs';
import { createLogger } from '../src/logger.mjs';
import { ReplyWorker } from '../src/worker.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { config, withTestTimeout } from './helpers.mjs';

const successful = () => new Response(JSON.stringify({ choices: [{ message: { content: '正常回复' } }] }));

test('reasoning effort is opt-in, validated, and forwarded without changing user or system messages', async () => {
  const original = globalThis.fetch, seen = [];
  try {
    globalThis.fetch = async (_, options) => { seen.push(JSON.parse(options.body)); return successful(); };
    const cfg = config('unused', { AI_REASONING_EFFORT: 'none' }).ai;
    assert.equal(await new AIClient(cfg).reply('question', []), '正常回复');
    assert.equal(seen[0].reasoning_effort, 'none');
    assert.deepEqual(seen[0].messages, [{ role: 'system', content: cfg.systemPrompt }, { role: 'user', content: 'question' }]);
    await new AIClient(config('unused').ai).reply('question', []);
    assert.equal(Object.hasOwn(seen[1], 'reasoning_effort'), false);
    assert.throws(() => config('unused', { AI_REASONING_EFFORT: 'unknown' }), /Invalid AI_REASONING_EFFORT/);
  } finally { globalThis.fetch = original; }
});

test('provider errors retain safe HTTP status and retry policy without recording provider bodies', async () => {
  const original = globalThis.fetch, cfg = config('unused').ai;
  try {
    for (const status of [400, 401, 429, 503]) {
      globalThis.fetch = async () => new Response('private prompt and credential', { status });
      await assert.rejects(new AIClient(cfg).reply('question', []), error => {
        assert.deepEqual(describeAIFailure(error), { reason: 'ai_http_error', http_status: status });
        assert.equal(error.retryable, status === 429 || status >= 500);
        assert.ok(!error.message.includes('private')); return true;
      });
    }
  } finally { globalThis.fetch = original; }
});

test('high reasoning and optional generation controls are forwarded independently without changing prompts', async () => {
  const original = globalThis.fetch, seen = [];
  try {
    globalThis.fetch = async (_, options) => { seen.push(JSON.parse(options.body)); return successful(); };
    const cfg = config('unused', { AI_REASONING_EFFORT: 'high', AI_MAX_OUTPUT_TOKENS: '16384',
      AI_TEMPERATURE: '1', AI_TOP_P: '0.95', AI_PRESENCE_PENALTY: '1.5' }).ai;
    const history = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }];
    await new AIClient(cfg).reply('question', history);
    assert.equal(seen[0].reasoning_effort, 'high'); assert.equal(seen[0].max_tokens, 16384);
    assert.equal(seen[0].temperature, 1); assert.equal(seen[0].top_p, 0.95); assert.equal(seen[0].presence_penalty, 1.5);
    assert.deepEqual(seen[0].messages, [{ role: 'system', content: cfg.systemPrompt }, ...history, { role: 'user', content: 'question' }]);
    await new AIClient(config('unused').ai).reply('question', []);
    for (const key of ['max_tokens', 'temperature', 'top_p', 'presence_penalty']) assert.equal(Object.hasOwn(seen[1], key), false);
    await new AIClient(config('unused', { AI_TEMPERATURE: '0', AI_TOP_P: '0', AI_PRESENCE_PENALTY: '-2' }).ai).reply('question', []);
    assert.equal(seen[2].temperature, 0); assert.equal(seen[2].top_p, 0); assert.equal(seen[2].presence_penalty, -2);
  } finally { globalThis.fetch = original; }
});

test('generation settings validate ranges and persist decimal sampling values atomically', async () => {
  for (const [key, invalid] of Object.entries({ AI_MAX_OUTPUT_TOKENS: ['-1', '1.5', '131073'],
    AI_TEMPERATURE: ['-0.1', '2.1', 'NaN', 'Infinity', ' ', '0x1'], AI_TOP_P: ['-0.1', '1.1'], AI_PRESENCE_PENALTY: ['-2.1', '2.1'] })) {
    for (const value of invalid) assert.throws(() => config('unused', { [key]: value }), new RegExp('Invalid ' + key));
  }
  const settings = new Settings(config('unused', { AI_REASONING_EFFORT: 'high' }));
  const before = await settings.snapshot();
  const after = await settings.save({ AI_MAX_OUTPUT_TOKENS: '16384', AI_TEMPERATURE: '1', AI_TOP_P: '0.95', AI_PRESENCE_PENALTY: '1.5' }, before.revision);
  assert.equal(after.values.AI_TOP_P, '0.95'); assert.equal(after.values.AI_REASONING_EFFORT, 'high');
  await assert.rejects(settings.save({ AI_PRESENCE_PENALTY: 'secret' }, after.revision), /Invalid AI_PRESENCE_PENALTY/);
  assert.equal((await settings.snapshot()).revision, after.revision);
});

test('response timeouts and caller cancellation have distinct diagnostics before headers and during body reads', async () => {
  const original = globalThis.fetch, cfg = { ...config('unused').ai, timeout: 20 };
  try {
    for (const body of [false, true]) {
      globalThis.fetch = async (_, options) => body ? new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
      } })) : new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      await withTestTimeout(() => assert.rejects(new AIClient(cfg).reply('question', []), error => {
        assert.equal(describeAIFailure(error).reason, 'ai_timeout'); assert.equal(error.retryable, true); return true;
      }));
      const controller = new AbortController();
      const pending = new AIClient({ ...cfg, timeout: 1000 }).reply('question', [], controller.signal);
      setTimeout(() => controller.abort(), 1);
      await assert.rejects(pending, error => {
        assert.equal(describeAIFailure(error).reason, 'ai_cancelled'); assert.equal(error.retryable, false); return true;
      });
    }
  } finally { globalThis.fetch = original; }
});

test('reasoning-only responses never become QQ replies and invalid JSON is classified separately', async () => {
  const original = globalThis.fetch, cfg = config('unused').ai;
  try {
    for (const field of ['reasoning_content', 'reasoning']) {
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '', [field]: 'private reasoning' } }] }));
      await assert.rejects(new AIClient(cfg).reply('question', []), error => {
        assert.deepEqual(describeAIFailure(error), { reason: 'ai_reasoning_only', finish_reason: 'length' });
        assert.equal(error.retryable, true); assert.ok(!error.message.includes('private')); return true;
      });
    }
    globalThis.fetch = async () => new Response('invalid');
    await assert.rejects(new AIClient(cfg).reply('question', []), error => describeAIFailure(error).reason === 'ai_invalid_json');
    globalThis.fetch = async () => new Response('null');
    await assert.rejects(new AIClient(cfg).reply('question', []), error => describeAIFailure(error).reason === 'ai_empty_reply');
  } finally { globalThis.fetch = original; }
});

test('reasoning-only retry keeps high, logs safe usage, and sends only the final reply once', async () => {
  const original = globalThis.fetch, store = new Store(':memory:'), logs = [], requests = [], sent = [];
  try {
    globalThis.fetch = async (_, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1 ? new Response(JSON.stringify({ choices: [{ finish_reason: 'length',
        message: { content: null, reasoning_content: 'private reasoning' } }],
        usage: { prompt_tokens: 100, completion_tokens: 16384, completion_tokens_details: { reasoning_tokens: 16384 } } })) : successful();
    };
    const cfg = config('unused', { AI_ENABLED: 'true', AI_MODEL: 'fixture', AI_ALLOWED_USERS: '10001', AI_REASONING_EFFORT: 'high', AI_MAX_OUTPUT_TOKENS: '16384' });
    const worker = new ReplyWorker({ adapter: { status: () => ({ online: true }), action: async (name, params) => { sent.push(params.message); } },
      store, ai: new AIClient(cfg.ai), config: cfg, log: createLogger(line => logs.push(JSON.parse(line))) });
    worker.ingest({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 10001, message_id: 1, message: 'private prompt' });
    await worker.step();
    assert.equal(store.get(1).status, 'queued'); assert.equal(store.get(1).reply, null); assert.equal(sent.length, 0);
    const failure = logs.find(entry => entry.event === 'ai_generation_failed');
    assert.equal(failure.reason, 'ai_reasoning_only'); assert.equal(failure.finish_reason, 'length');
    assert.equal(failure.completion_tokens, 16384); assert.equal(failure.reasoning_tokens, 16384); assert.equal(failure.prompt_tokens, 100);
    store.db.prepare('UPDATE jobs SET next_at=0 WHERE id=1').run();
    await worker.step(); await worker.step();
    assert.equal(store.get(1).status, 'done'); assert.equal(sent.length, 1); assert.equal(replyBody(sent[0])[0].data.text, '正常回复');
    assert.ok(requests.every(body => body.reasoning_effort === 'high' && body.max_tokens === 16384));
    assert.ok(!JSON.stringify(logs).includes('private')); assert.ok(!JSON.stringify(requests).includes('private reasoning'));
  } finally { globalThis.fetch = original; store.close(); }
});

test('persistent reasoning-only failures exhaust bounded attempts and filtered responses are never retried', async () => {
  const original = globalThis.fetch, store = new Store(':memory:'); let requests = 0, sends = 0;
  try {
    globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '', reasoning: 'private' } }] })); };
    const cfg = config('unused', { AI_ENABLED: 'true', AI_MODEL: 'fixture', AI_ALLOWED_USERS: '10001', AI_MAX_ATTEMPTS: '2' });
    const worker = new ReplyWorker({ adapter: { status: () => ({ online: true }), action: async () => { sends++; } }, store,
      ai: new AIClient(cfg.ai), config: cfg, log: () => {} });
    worker.ingest({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 10001, message_id: 1, message: 'question' });
    await worker.step(); store.db.prepare('UPDATE jobs SET next_at=0 WHERE id=1').run();
    await worker.step(); await worker.step();
    assert.equal(store.get(1).status, 'failed'); assert.equal(store.get(1).attempts, 2); assert.equal(requests, 2); assert.equal(sends, 0);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { reasoning: 'private' } }] }));
    await assert.rejects(new AIClient(cfg.ai).reply('question', []), error => error.retryable === false && describeAIFailure(error).finish_reason === 'content_filter');
  } finally { globalThis.fetch = original; store.close(); }
});

test('worker failure logs explain timeouts and elapsed time while leaving failed generation unsent', async () => {
  const original = globalThis.fetch, store = new Store(':memory:'), logs = [];
  let sends = 0;
  try {
    globalThis.fetch = async (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    const cfg = config('unused', { AI_ENABLED: 'true', AI_MODEL: 'fixture', AI_ALLOWED_USERS: '10001', AI_TIMEOUT_MS: '20', AI_MAX_ATTEMPTS: '1' });
    const worker = new ReplyWorker({ adapter: { status: () => ({ online: true }), action: async () => { sends++; } }, store,
      ai: new AIClient(cfg.ai), config: cfg, log: createLogger(line => logs.push(JSON.parse(line))) });
    worker.ingest({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 10001, message_id: 1, message: 'private prompt' });
    await withTestTimeout(() => worker.step());
    const failure = logs.find(entry => entry.event === 'ai_generation_failed');
    assert.equal(failure.reason, 'ai_timeout'); assert.equal(failure.timeout_ms, 20);
    assert.ok(Number.isSafeInteger(failure.duration_ms) && failure.duration_ms >= 0);
    assert.equal(failure.job, 1); assert.equal(failure.attempt, 1);
    assert.equal(store.get(1).status, 'failed'); assert.equal(store.get(1).send_attempts, 0); assert.equal(sends, 0);
    assert.ok(!JSON.stringify(logs).includes('private'));
  } finally { globalThis.fetch = original; store.close(); }
});

test('untrusted errors cannot inject diagnostic text and numeric log metadata is bounded', () => {
  for (const error of [new Error('credential'), { reason: 'credential', http_status: 'credential' }, null]) {
    assert.deepEqual(describeAIFailure(error), { reason: 'ai_unknown_error' });
  }
  const logs = [], log = createLogger(line => logs.push(JSON.parse(line)));
  log('warn', 'ai_generation_failed', { duration_ms: 'credential', timeout_ms: -1, http_status: 999, message: 'credential' });
  assert.ok(!Object.hasOwn(logs[0], 'duration_ms')); assert.ok(!Object.hasOwn(logs[0], 'timeout_ms'));
  assert.ok(!Object.hasOwn(logs[0], 'http_status')); assert.ok(!JSON.stringify(logs).includes('credential'));
  log('warn', 'ai_generation_failed', { duration_ms: 50, timeout_ms: 45000, http_status: 429 });
  assert.equal(logs[1].http_status, 429);
  log('warn', 'ai_generation_failed', { finish_reason: 'credential', prompt_tokens: 'credential', completion_tokens: -1,
    reasoning_tokens: Infinity, reasoning_content: 'credential' });
  assert.ok(!JSON.stringify(logs[2]).includes('credential'));
  assert.ok(!Object.hasOwn(logs[2], 'completion_tokens')); assert.ok(!Object.hasOwn(logs[2], 'reasoning_tokens'));
});
