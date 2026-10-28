import { BotError } from './errors.mjs';
import { readCompletionStream } from './ai-stream.mjs';

const failures = new WeakMap();
const completions = new WeakMap();
const finishReasons = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
function completionMetadata(result) {
  const metadata = {}, finish = result?.choices?.[0]?.finish_reason;
  if (finishReasons.has(finish)) metadata.finish_reason = finish;
  for (const [key, value] of Object.entries({ prompt_tokens: result?.usage?.prompt_tokens,
    completion_tokens: result?.usage?.completion_tokens,
    reasoning_tokens: result?.usage?.completion_tokens_details?.reasoning_tokens })) {
    if (Number.isSafeInteger(value) && value >= 0) metadata[key] = value;
  }
  return metadata;
}
function aiError(message, reason, { retryable = false, cause, httpStatus, metadata } = {}) {
  const error = new BotError(message, 1500, { retryable, cause });
  failures.set(error, { reason, ...(httpStatus === undefined ? {} : { http_status: httpStatus }), ...metadata });
  return error;
}

// Provider error bodies and exception text can contain prompts or credentials.
export function describeAIFailure(error) {
  return { ...(failures.get(error) || { reason: 'ai_unknown_error' }) };
}

export class AIClient {
  constructor(config) { this.config = config; }
  async reply(input, history, signal, options = {}) {
    let content=options.userContent||input;
    if(options.backgroundContent){
      const boundary='\n\n当前用户请求（只回答这一条）：\n';
      content=Array.isArray(content)?[{type:'text',text:options.backgroundContent+boundary},...content]:options.backgroundContent+boundary+content;
    }
    // Keep one user turn per request, including local models whose templates
    // require alternating roles. Existing multimodal parts stay intact.
    const messages = [{ role: 'system', content: this.config.systemPrompt + (options.systemPromptSuffix || '') }, ...history,
      { role: 'user', content }];
    const allowed = new Set((options.tools || []).map(tool => tool.function.name));
    const required = options.requiredTool;
    if (required !== undefined && (typeof required !== 'string' || !allowed.has(required))) throw aiError('Invalid required AI tool', 'ai_invalid_tool_call');
    const maxSteps = options.maxSteps ?? 4;
    let calls = 0, visible = '';
    const publish = async text => {
      const next = Array.from(visible + text).slice(0, this.config.maxReplyChars).join('');
      const delta = next.slice(visible.length); visible = next;
      if (delta) await options.onDelta?.(delta, visible);
    };
    for (let round = 0; round < maxSteps; round++) {
      signal?.throwIfAborted();
      // String "required" plus one definition also supports local providers
      // that reject the OpenAI named-function tool_choice object.
      const force = round === 0 && required;
      const done = options.onModelStep?.(round + 1);
      let message;
      try {
        const previous = visible.length;
        message = await this.completion(messages, signal, force ? options.tools.filter(t => t.function.name === required) : options.tools, force ? 'required' : 'auto',
          { onContent: options.onDelta && !force ? publish : undefined });
        options.onCompletion?.({...(completions.get(message)||{})});
        if (options.onDelta && !force && visible.length === previous && typeof message?.content === 'string') await publish(message.content);
        done?.('succeeded');
      } catch (error) { done?.('failed'); throw error; }
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
        const ids = new Set();
        if (!options.invokeTool || message.tool_calls.length > (options.maxParallelTools ?? 2) || calls + message.tool_calls.length > (options.maxToolCalls ?? 8)) throw aiError('Unsupported AI tool call', 'ai_tool_limit');
        // Validate the entire batch before the first side effect.
        const parsed = message.tool_calls.map(call => {
          if (!allowed.has(call.function?.name) || round === 0 && required && call.function.name !== required || typeof call.id !== 'string' || !call.id.length || call.id.length > 200 || ids.has(call.id) || typeof call.function.arguments !== 'string' || call.function.arguments.length > 8000) throw aiError('Invalid AI tool call', 'ai_invalid_tool_call');
          ids.add(call.id);
          try { const args = JSON.parse(call.function.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error(); return args; }
          catch { throw aiError('Invalid tool arguments', 'ai_invalid_tool_call'); }
        });
        messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
        for (const [index,call] of message.tool_calls.entries()) {
          signal?.throwIfAborted(); calls++;
          const outcome = await options.invokeTool(call.function.name, parsed[index]);
          if (outcome.finish) {
            const text = String(outcome.reply);
            return Array.from(visible ? visible + '\n' + text : text).slice(0, this.config.maxReplyChars).join('');
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) });
        }
        continue;
      }
      if (round === 0 && required) throw aiError('AI did not call the required tool', 'ai_tool_not_called');
      const content = message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        const reasoning = message?.reasoning_content || message?.reasoning;
        const hasReasoning = typeof reasoning === 'string' && !!reasoning.trim();
        const metadata = completions.get(message) || {};
        // Retry through the existing bounded queue; do not send or store thoughts
        // as reply text or silently downgrade the configured reasoning effort.
        throw aiError('Empty AI reply', hasReasoning ? 'ai_reasoning_only' : 'ai_empty_reply', {
          retryable: metadata.finish_reason !== 'content_filter' && (hasReasoning || metadata.finish_reason === 'length'), metadata
        });
      }
      return Array.from((visible || content).trim()).slice(0, this.config.maxReplyChars).join('');
    }
    throw aiError('AI tool limit reached', 'ai_tool_limit');
  }
  async completion(messages, signal, tools, toolChoice = 'auto', options = {}) {
    const config = this.config;
    const timeout = AbortSignal.timeout(config.timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const interrupted = (message, cause, fallback) => aiError(message,
      signal?.aborted ? 'ai_cancelled' : timeout.aborted ? 'ai_timeout' : fallback,
      { retryable: !signal?.aborted, cause });
    let response;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, stream: config.stream !== false,
          ...(config.stream!==false&&config.includeUsage===true?{stream_options:{include_usage:true}}:{}),
          ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          ...(config.maxOutputTokens ? { max_tokens: config.maxOutputTokens } : {}),
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
          ...(config.topP === undefined ? {} : { top_p: config.topP }),
          ...(config.presencePenalty === undefined ? {} : { presence_penalty: config.presencePenalty }),
          messages }),
        signal: requestSignal
      });
    } catch (cause) { throw interrupted('AI network error', cause, 'ai_network_error'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw aiError('AI provider rejected request', 'ai_http_error',
        { retryable: response.status === 429 || response.status >= 500, httpStatus: response.status });
    }
    let raw = '', result;
    try {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        result = await readCompletionStream(response.body, { onContent: options.onContent,
          invalid: reason => aiError('Invalid or interrupted AI stream', reason, { retryable: reason === 'ai_response_interrupted' || reason === 'ai_stream_error' }) });
      } else {
        // Some compatible providers ignore stream=true and return JSON.
        for await (const chunk of response.body) {
          raw += Buffer.from(chunk).toString('binary');
          if (raw.length > 2 * 1024 * 1024) throw aiError('AI response exceeded size limit', 'ai_response_too_large');
        }
      }
    } catch (cause) {
      if (cause instanceof BotError) throw cause;
      throw interrupted('AI response interrupted', cause, 'ai_response_interrupted');
    }
    if (!result) {
      try { result = JSON.parse(Buffer.from(raw, 'binary').toString('utf8')); }
      catch { throw aiError('Invalid AI response JSON', 'ai_invalid_json'); }
    }
    const message = result?.choices?.[0]?.message;
    if (message && typeof message === 'object') completions.set(message, completionMetadata(result));
    return message;
  }
}
