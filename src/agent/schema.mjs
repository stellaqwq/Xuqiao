// A deliberately bounded JSON Schema subset shared by plugins and the runtime.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const bad = () => Object.assign(new Error('工具参数或 JSON Schema 无效。'), { status: 400 });
export function validateSchema(schema, depth = 0) {
  if (!object(schema) || depth > 6 || !types.includes(schema.type)) throw bad();
  const supported = new Set(['type','description','properties','required','additionalProperties','items','enum','minimum','maximum','minLength','maxLength','minItems','maxItems']);
  if (Object.keys(schema).some(key => !supported.has(key))) throw bad();
  if (schema.description !== undefined && (typeof schema.description !== 'string' || schema.description.length > 1000)) throw bad();
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 100 || schema.enum.some(v => v !== null && typeof v === 'object'))) throw bad();
  for (const key of ['minimum','maximum','minLength','maxLength','minItems','maxItems']) if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || (key !== 'minimum' && key !== 'maximum' && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)))) throw bad();
  if (schema.type === 'object') {
    if (!object(schema.properties) || Object.keys(schema.properties).length > 30 || schema.additionalProperties !== false ||
        Object.keys(schema.properties).some(key => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) ||
        schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties, key)))) throw bad();
    Object.values(schema.properties).forEach(child => validateSchema(child, depth + 1));
  }
  if (schema.type === 'array') validateSchema(schema.items, depth + 1);
  return schema;
}
export function validateArguments(schema, value, depth = 0) {
  if (depth > 6) throw bad();
  const valid = schema.type === 'object' ? object(value) : schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'null' ? value === null : typeof value === schema.type;
  if (!valid || schema.enum && !schema.enum.includes(value)) throw bad();
  if (schema.type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => !Object.hasOwn(schema.properties,key))) throw bad();
    for (const [key, child] of Object.entries(value)) validateArguments(schema.properties[key], child, depth + 1);
  }
  if (schema.type === 'array') {
    if (value.length > (schema.maxItems ?? 100) || value.length < (schema.minItems ?? 0)) throw bad();
    value.forEach(item => validateArguments(schema.items,item,depth + 1));
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw bad();
  if (typeof value === 'string' && (Array.from(value).length > (schema.maxLength ?? 8000) || Array.from(value).length < (schema.minLength ?? 0))) throw bad();
}
export function normalizeTools(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw bad();
  const names = new Set();
  return value.map(tool => {
    if (!object(tool) || typeof tool.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(tool.name) || names.has(tool.name) ||
        typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 500 || !['read','write'].includes(tool.effect ?? 'write')) throw bad();
    names.add(tool.name);
    if (tool.parameters?.type !== 'object') throw bad();
    return { name: tool.name, description: tool.description, effect: tool.effect ?? 'write', parameters: structuredClone(validateSchema(tool.parameters)) };
  });
}
export const parameters = properties => ({ type: 'object', properties, additionalProperties: false });
