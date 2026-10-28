// Deliberately exclude message bodies, credentials and driver exception text.
export function createLogger(write = line => process.stdout.write(`${line}\n`)) {
  return (level, event, fields = {}) => {
    const safe = {};
    for (const key of ['job', 'state', 'code', 'count', 'port', 'driver', 'attempt', 'reason']) {
      if (fields[key] !== undefined) safe[key] = fields[key];
    }
    if (typeof fields.plugin === 'string' && /^[a-f0-9-]{36}$/.test(fields.plugin)) safe.plugin = fields.plugin;
    for (const key of ['duration_ms', 'timeout_ms', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens']) {
      if (Number.isSafeInteger(fields[key]) && fields[key] >= 0) safe[key] = fields[key];
    }
    if (['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(fields.finish_reason)) safe.finish_reason = fields.finish_reason;
    if (Number.isInteger(fields.http_status) && fields.http_status >= 100 && fields.http_status <= 599) safe.http_status = fields.http_status;
    write(JSON.stringify({ time: new Date().toISOString(), level, event, ...safe }));
  };
}
