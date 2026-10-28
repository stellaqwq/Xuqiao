import { BotError } from '../../errors.mjs';

export const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
export const cat = (...values) => Buffer.concat(values.map(bytes));
export function uint(value, width = 4) {
  const out = Buffer.alloc(width);
  if (width === 8) out.writeBigUInt64BE(BigInt(value));
  else out.writeUIntBE(value, 0, width);
  return out;
}
export const sized = (value, width = 4, inclusive = true) => {
  const data = bytes(value);
  return cat(uint(data.length + (inclusive ? width : 0), width), data);
};
export const tlv = (tag, value) => cat(uint(tag, 2), sized(value, 2, false));
export const tlvs = entries => cat(uint(entries.length, 2), ...entries.map(([tag, value]) => tlv(tag, value)));

// Every network-controlled length is checked before a slice or allocation.
export class Reader {
  constructor(data) { this.data = bytes(data); this.offset = 0; }
  get remaining() { return this.data.length - this.offset; }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new BotError('Malformed QQ packet length', 1500);
    }
    const result = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  skip(length) { this.take(length); return this; }
  u(width = 4) { return this.take(width).readUIntBE(0, width); }
  i32() { return this.take(4).readInt32BE(); }
  sized(width = 4, inclusive = true) { return this.take(this.u(width) - (inclusive ? width : 0)); }
  rest() { return this.take(this.remaining); }
  tlvs() {
    const result = new Map();
    const count = this.u(2);
    if (count > 1024) throw new BotError('Too many QQ TLV fields', 1500);
    for (let i = 0; i < count; i++) {
      const tag = this.u(2);
      if (result.has(tag)) throw new BotError('Duplicate QQ TLV field', 1500);
      result.set(tag, this.sized(2, false));
    }
    return result;
  }
}
