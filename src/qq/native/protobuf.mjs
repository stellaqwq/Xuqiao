import { BotError } from '../../errors.mjs';
import { cat, Reader } from './binary.mjs';

export function varint(value) {
  let n = BigInt.asUintN(64, BigInt(value));
  const out = [];
  do { out.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(out);
}
function readVarint(reader) {
  let result = 0n;
  for (let i = 0; i < 10; i++) {
    const byte = reader.u(1);
    if (i === 9 && byte > 1) throw new BotError('Invalid protobuf varint', 1500);
    result |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return result;
  }
  throw new BotError('Invalid protobuf varint', 1500);
}

// Objects represent nested messages. Arrays represent repeated fields; byte
// fields are always Buffer so decoding never guesses a string/message type.
export function encode(fields, depth = 0) {
  if (depth > 24) throw new BotError('Protobuf nesting limit', 1400);
  const out = [];
  for (const [key, values] of Object.entries(fields)) {
    const field = Number(key);
    if (!Number.isInteger(field) || field < 1 || field > 536870911) throw new BotError('Invalid protobuf field', 1400);
    for (let value of Array.isArray(values) ? values : [values]) {
      if (value === undefined || value === null) continue;
      const numeric = ['number', 'bigint', 'boolean'].includes(typeof value);
      out.push(varint(field * 8 + (numeric ? 0 : 2)));
      if (numeric) {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new BotError('Unsafe protobuf integer', 1400);
        out.push(varint(typeof value === 'boolean' ? Number(value) : value));
      } else {
        value = typeof value === 'string' ? Buffer.from(value) : Buffer.isBuffer(value) ? value : encode(value, depth + 1);
        out.push(varint(value.length), value);
      }
    }
  }
  return cat(...out);
}
export function decode(data) {
  const reader = new Reader(data);
  const result = new Map();
  let count = 0;
  while (reader.remaining) {
    if (++count > 50000) throw new BotError('Protobuf field limit', 1500);
    const tag = readVarint(reader);
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (field < 1 || field > 536870911) throw new BotError('Invalid protobuf tag', 1500);
    let value;
    if (wire === 0) value = readVarint(reader);
    else if (wire === 2) value = reader.take(Number(readVarint(reader)));
    else if (wire === 1) value = reader.take(8);
    else if (wire === 5) value = reader.take(4);
    else throw new BotError('Unsupported protobuf wire type', 1500);
    if (!result.has(field)) result.set(field, []);
    result.get(field).push(value);
  }
  return result;
}
export const all = (message, field) => message.get(field) ?? [];
export const first = (message, field) => all(message, field)[0];
export const buffer = (message, field) => {
  const value = first(message, field);
  if (value === undefined) return Buffer.alloc(0);
  if (!Buffer.isBuffer(value)) throw new BotError('Invalid protobuf bytes field', 1500);
  return value;
};
export const text = (message, field) => buffer(message, field).toString('utf8');
export const number = (message, field) => {
  const value = first(message, field) ?? 0n;
  if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BotError('Invalid protobuf number field', 1500);
  return Number(value);
};
export const nested = (message, field) => decode(buffer(message, field));
export const packed = values => cat(...values.map(varint));
