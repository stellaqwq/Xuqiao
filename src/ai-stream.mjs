// Chat Completions SSE frames may span arbitrary UTF-8/network boundaries.
export async function readCompletionStream(body, { onContent, invalid, limit = 2 * 1024 * 1024 }) {
  const decoder = new TextDecoder(), message = { content: '' }, calls = new Map();
  let buffer = '', bytes = 0, finished = false, terminal = false, metadata = {};
  async function frame(value) {
    const data = value.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { finished = true; return; }
    let result;
    try { result = JSON.parse(data); } catch { throw invalid('ai_invalid_stream'); }
    if (result.error) throw invalid('ai_stream_error');
    if (result.usage) metadata.usage = result.usage;
    const choice = result.choices?.find(c => c.index === 0 || c.index === undefined);
    if (!choice) return;
    if (choice.finish_reason) { metadata.finish_reason = choice.finish_reason; terminal = true; }
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') {
      message.content += delta.content;
      await onContent?.(delta.content);
    }
    for (const key of ['reasoning_content', 'reasoning']) if (typeof delta[key] === 'string') message[key] = 'present';
    for (const part of delta.tool_calls || []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 64) throw invalid('ai_invalid_stream');
      const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id += part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(part.index, call);
    }
  }
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw invalid('ai_response_too_large');
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      const value = buffer.slice(0, end.index); buffer = buffer.slice(end.index + end[0].length);
      await frame(value);
      if (finished) break;
    }
    if (finished) break;
  }
  if (!finished) {
    buffer += decoder.decode();
    if (buffer.trim()) await frame(buffer);
  }
  if (!finished && !terminal) throw invalid('ai_response_interrupted');
  if (calls.size) message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return { choices: [{ message, finish_reason: metadata.finish_reason }], usage: metadata.usage };
}
