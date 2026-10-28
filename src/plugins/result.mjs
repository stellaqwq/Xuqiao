export function pluginResult(value) {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid_result');
  if (value?.reply !== undefined && (typeof value.reply !== 'string' || value.reply.length > 2000)) throw new Error('invalid_result');
  if (value?.handled !== undefined && typeof value.handled !== 'boolean') throw new Error('invalid_result');
  const reply = value?.reply || '', message = value?.message;
  if (message !== undefined && (!Array.isArray(message) || !message.length || message.length > 5 || message.some(segment =>
    !segment || !segment.data || (segment.type === 'text' ? typeof segment.data.text !== 'string' || segment.data.text.length > 2000 :
      segment.type === 'image' ? typeof segment.data.file !== 'string' || !segment.data.file || segment.data.file.length > 8 * 1024 * 1024 : true)))) throw new Error('invalid_result');
  return { reply, ...(message ? { message: message.map(segment => ({ type: segment.type,
    data: segment.type === 'text' ? { text: segment.data.text } : { file: segment.data.file } })) } : {}), handled: !!reply || !!message || value?.handled === true };
}
