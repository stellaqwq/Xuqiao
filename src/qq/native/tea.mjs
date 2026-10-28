import { randomBytes } from 'node:crypto';
import { BotError } from '../../errors.mjs';

// QQ uses 16-round TEA with its own two-block chaining and random padding.
function block(input, key, decrypt = false) {
  let left = input.readUInt32BE(0), right = input.readUInt32BE(4);
  const k = [0, 4, 8, 12].map(offset => key.readUInt32BE(offset));
  const mix = (v, sum, a, b) => (((v << 4) + a) ^ (v + sum) ^ ((v >>> 5) + b));
  let sum = decrypt ? 0xe3779b90 : 0;
  for (let round = 0; round < 16; round++) {
    if (decrypt) {
      right = (right - mix(left, sum, k[2], k[3])) >>> 0;
      left = (left - mix(right, sum, k[0], k[1])) >>> 0;
      sum = (sum - 0x9e3779b9) >>> 0;
    } else {
      sum = (sum + 0x9e3779b9) >>> 0;
      left = (left + mix(right, sum, k[0], k[1])) >>> 0;
      right = (right + mix(left, sum, k[2], k[3])) >>> 0;
    }
  }
  const out = Buffer.alloc(8);
  out.writeUInt32BE(left); out.writeUInt32BE(right, 4);
  return out;
}
const xor = (a, b) => Buffer.from(a.map((value, index) => value ^ b[index]));
function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new BotError('QQ TEA requires a 16-byte key', 1400);
}
export function encrypt(data, key, entropy = randomBytes) {
  checkKey(key);
  const padding = (8 - (data.length + 10) % 8) % 8;
  const plain = Buffer.concat([entropy(padding + 3), data, Buffer.alloc(7)]);
  plain[0] = (plain[0] & 0xf8) | padding;
  const out = Buffer.alloc(plain.length);
  let previousCipher = Buffer.alloc(8), previousMixed = Buffer.alloc(8);
  for (let offset = 0; offset < plain.length; offset += 8) {
    const mixed = xor(plain.subarray(offset, offset + 8), previousCipher);
    const cipher = xor(block(mixed, key), previousMixed);
    cipher.copy(out, offset);
    previousCipher = cipher; previousMixed = mixed;
  }
  return out;
}
export function decrypt(data, key) {
  checkKey(key);
  if (data.length < 16 || data.length % 8) throw new BotError('Invalid QQ TEA ciphertext length', 1500);
  const out = Buffer.alloc(data.length);
  let previousCipher = Buffer.alloc(8), previousMixed = Buffer.alloc(8);
  for (let offset = 0; offset < data.length; offset += 8) {
    const cipher = data.subarray(offset, offset + 8);
    const mixed = block(xor(cipher, previousMixed), key, true);
    xor(mixed, previousCipher).copy(out, offset);
    previousCipher = cipher; previousMixed = mixed;
  }
  const start = (out[0] & 7) + 3;
  if (start > out.length - 7 || !out.subarray(-7).equals(Buffer.alloc(7))) throw new BotError('QQ TEA padding check failed', 1500);
  return out.subarray(start, -7);
}
