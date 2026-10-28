import { BotError } from '../../errors.mjs';

const invalid = () => new BotError('Invalid audio; use a PCM/float WAV or Tencent SILK file', 1400);
export function silkInfo(bytes, maxSeconds = 300) {
  const start = bytes[0] === 2 ? 1 : 0;
  if (bytes.toString('ascii', start, start + 9) !== '#!SILK_V3') throw invalid();
  let position = start + 9, frames = 0;
  while (position < bytes.length) {
    if (position + 2 > bytes.length) throw invalid();
    const size = bytes.readInt16LE(position); position += 2;
    if (size === -1 && position === bytes.length) break;
    if (size < 1 || size > 1250 || position + size > bytes.length) throw invalid();
    position += size; frames++;
    if (frames * 20 > maxSeconds * 1000) throw new BotError('Voice exceeds the 300 second duration limit', 1400);
  }
  if (!frames) throw invalid();
  return { durationMs: frames * 20, duration: Math.max(1, Math.ceil(frames / 50)) };
}

export function wavToPCM(bytes, maxSeconds = 300) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 44) throw invalid();
  let format, data;
  for (let p = 12; p + 8 <= end;) {
    const name = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4), begin = p + 8;
    if (begin + size > end) throw invalid();
    if (name === 'fmt ' && !format) {
      if (size < 16) throw invalid();
      let kind = bytes.readUInt16LE(begin);
      if (kind === 65534 && size >= 40) kind = bytes.readUInt16LE(begin + 24);
      format = { kind, channels: bytes.readUInt16LE(begin + 2), rate: bytes.readUInt32LE(begin + 4),
        align: bytes.readUInt16LE(begin + 12), bits: bytes.readUInt16LE(begin + 14) };
    }
    if (name === 'data' && !data) data = bytes.subarray(begin, begin + size);
    p = begin + size + (size & 1);
  }
  if (!format || !data?.length) throw invalid();
  const { kind, channels, rate, align, bits } = format;
  if (![1, 3].includes(kind) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000 ||
      !(kind === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) || align !== channels * bits / 8 || data.length % align) throw invalid();
  const frames = data.length / align, seconds = frames / rate;
  if (seconds > maxSeconds) throw new BotError('Voice exceeds the 300 second duration limit', 1400);
  const count = Math.max(1, Math.round(seconds * 24000));
  const output = Buffer.alloc(Math.ceil(count / 480) * 480 * 2), amplitudes = Array(32).fill(0), totals = Array(32).fill(0);
  const sample = frame => {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const offset = frame * align + channel * bits / 8;
      let value;
      if (kind === 3) value = bits === 32 ? data.readFloatLE(offset) : data.readDoubleLE(offset);
      else if (bits === 8) value = (data[offset] - 128) / 128;
      else value = data.readIntLE(offset, bits / 8) / 2 ** (bits - 1);
      if (!Number.isFinite(value)) throw invalid();
      sum += Math.max(-1, Math.min(1, value));
    }
    return sum / channels;
  };
  for (let i = 0; i < count; i++) {
    const position = i * rate / 24000, lower = Math.min(frames - 1, Math.floor(position)), upper = Math.min(frames - 1, lower + 1);
    const weight = position - lower, value = sample(lower) * (1 - weight) + sample(upper) * weight;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
    const bin = Math.min(31, Math.floor(i * 32 / count)); amplitudes[bin] += value * value; totals[bin]++;
  }
  return { pcm: output, waveAmplitudes: amplitudes.map((value, i) => Math.round(Math.sqrt(value / (totals[i] || 1)) * 100)) };
}
