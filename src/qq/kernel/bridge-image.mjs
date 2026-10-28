import { BotError } from '../../errors.mjs';

// A reproducible PE32+ image for the tiny bridge in native/qq-host/bridge.c.
// No compiler or third-party loader is needed. Three x64 functions implement
// an atomic lifetime flag and register a Node environment cleanup hook.
// Everything else is an ordinary PE forwarded export to the running node.exe.
export function buildBridgeImage(forwarders) {
  const stopName = '?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z';
  const exports = new Map(forwarders.map(name => [name, name === stopName ? null :
    `node.exe.${name === 'qq_magic_napi_register' ? 'napi_module_register' : name}`]));
  exports.set('napi_register_module_v1', null);
  if (!exports.has(stopName) || exports.size > 1000 || [...exports.keys()].some(n => !/^[\w?@$]+$/.test(n))) {
    throw new BotError('Unsupported QQ bridge export set', 1501);
  }
  const align = (n, a) => Math.ceil(n / a) * a;
  const textRva = 0x1000, dataRva = 0x2000, readRva = 0x3000;
  const rdata = Buffer.alloc(0x20000); let cursor = 0;
  const allocate = (size, alignment = 1) => { cursor = align(cursor, alignment); const p = cursor; cursor += size; if (cursor > rdata.length) throw new Error('Bridge image too large'); return p; };
  const string = value => { const p = allocate(Buffer.byteLength(value) + 1); rdata.write(value, p, 'ascii'); return p; };
  const imports = allocate(40, 8), lookup = allocate(16, 8), importName = allocate(2);
  const importedSymbol = string('napi_add_env_cleanup_hook');
  if (importedSymbol !== importName + 2) throw new Error('Invalid bridge import layout');
  const nodeName = string('node.exe');
  rdata.writeBigUInt64LE(BigInt(readRva + importName), lookup);
  rdata.writeUInt32LE(readRva + lookup, imports);
  rdata.writeUInt32LE(readRva + nodeName, imports + 12);
  rdata.writeUInt32LE(dataRva + 8, imports + 16);
  const exception = allocate(12, 4), unwind = allocate(8, 4);
  // UNWIND_INFO: push rbx; allocate 32-byte Windows shadow space.
  Buffer.from([1, 5, 2, 0, 5, 0x32, 1, 0x30]).copy(rdata, unwind);
  const exportStart = allocate(40, 4), names = [...exports.keys()].sort();
  const functions = allocate(names.length * 4, 4), nameTable = allocate(names.length * 4, 4), ordinals = allocate(names.length * 2, 2);
  const libraryName = string('QQNT.dll');
  rdata.writeUInt32LE(readRva + libraryName, exportStart + 12);
  rdata.writeUInt32LE(1, exportStart + 16);
  rdata.writeUInt32LE(names.length, exportStart + 20); rdata.writeUInt32LE(names.length, exportStart + 24);
  rdata.writeUInt32LE(readRva + functions, exportStart + 28);
  rdata.writeUInt32LE(readRva + nameTable, exportStart + 32);
  rdata.writeUInt32LE(readRva + ordinals, exportStart + 36);
  for (let i = 0; i < names.length; i++) {
    const name = names[i], target = exports.get(name);
    const address = target ? readRva + string(target) : name === stopName ? textRva : textRva + 32;
    rdata.writeUInt32LE(address, functions + i * 4);
    rdata.writeUInt32LE(readRva + string(name), nameTable + i * 4); rdata.writeUInt16LE(i, ordinals + i * 2);
  }
  const exportSize = cursor - exportStart;
  const text = Buffer.alloc(0x200), data = Buffer.alloc(0x200);
  // bool isStopping(void*): return flag != 0.
  Buffer.from([0x0f, 0xb6, 0x05, 0, 0, 0, 0, 0xc3]).copy(text);
  text.writeInt32LE(dataRva - (textRva + 7), 3);
  // cleanup(void*): flag = 1. Aligned byte accesses are atomic on x64.
  Buffer.from([0xc6, 0x05, 0, 0, 0, 0, 1, 0xc3]).copy(text, 16);
  text.writeInt32LE(dataRva - (textRva + 16 + 7), 18);
  // napi_register_module_v1(env, exports): register cleanup, return exports.
  const init = Buffer.from([0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x89, 0xd3,
    0x48, 0x8d, 0x15, 0, 0, 0, 0, 0x45, 0x31, 0xc0,
    0xff, 0x15, 0, 0, 0, 0, 0x48, 0x89, 0xd8, 0x48, 0x83, 0xc4, 0x20, 0x5b, 0xc3]);
  init.writeInt32LE((textRva + 16) - (textRva + 32 + 15), 11);
  init.writeInt32LE((dataRva + 8) - (textRva + 32 + 24), 20); init.copy(text, 32);
  rdata.writeUInt32LE(textRva + 32, exception); rdata.writeUInt32LE(textRva + 32 + init.length, exception + 4);
  rdata.writeUInt32LE(readRva + unwind, exception + 8);
  data.writeBigUInt64LE(BigInt(readRva + importName), 8);
  const readSize = align(cursor, 0x200), relocRva = align(readRva + cursor, 0x1000), relocRaw = 0x800 + readSize;
  const image = Buffer.alloc(relocRaw + 0x200);
  image.writeUInt16LE(0x5a4d, 0); image.writeUInt32LE(0x80, 60); image.writeUInt32LE(0x4550, 0x80);
  image.writeUInt16LE(0x8664, 0x84); image.writeUInt16LE(4, 0x86); image.writeUInt16LE(240, 0x94); image.writeUInt16LE(0x2022, 0x96);
  const optional = 0x98;
  image.writeUInt16LE(0x20b, optional); image.writeUInt32LE(0x200, optional + 4); image.writeUInt32LE(readSize + 0x400, optional + 8);
  image.writeUInt32LE(textRva, optional + 20); image.writeBigUInt64LE(0x180000000n, optional + 24);
  image.writeUInt32LE(0x1000, optional + 32); image.writeUInt32LE(0x200, optional + 36);
  image.writeUInt16LE(6, optional + 40); image.writeUInt16LE(6, optional + 48);
  image.writeUInt32LE(relocRva + 0x1000, optional + 56); image.writeUInt32LE(0x400, optional + 60);
  image.writeUInt16LE(3, optional + 68); image.writeUInt16LE(0x160, optional + 70);
  for (const p of [72, 88]) image.writeBigUInt64LE(0x100000n, optional + p);
  for (const p of [80, 96]) image.writeBigUInt64LE(0x1000n, optional + p);
  image.writeUInt32LE(16, optional + 108);
  function directory(index, rva, size) { image.writeUInt32LE(rva, optional + 112 + 8 * index); image.writeUInt32LE(size, optional + 116 + 8 * index); }
  directory(0, readRva + exportStart, exportSize); directory(1, readRva + imports, 40);
  directory(3, readRva + exception, 12); directory(5, relocRva, 8); directory(12, dataRva + 8, 16);
  function section(index, name, size, rva, rawSize, raw, flags) {
    const p = optional + 240 + 40 * index; image.write(name, p, 'ascii');
    for (const [offset, n] of [[8, size], [12, rva], [16, rawSize], [20, raw], [36, flags]]) image.writeUInt32LE(n, p + offset);
  }
  section(0, '.text', 32 + init.length, textRva, 0x200, 0x400, 0x60000020);
  section(1, '.data', 24, dataRva, 0x200, 0x600, 0xc0000040);
  section(2, '.rdata', cursor, readRva, readSize, 0x800, 0x40000040);
  section(3, '.reloc', 8, relocRva, 0x200, relocRaw, 0x42000040);
  text.copy(image, 0x400); data.copy(image, 0x600); rdata.copy(image, 0x800, 0, cursor);
  image.writeUInt32LE(textRva, relocRaw); image.writeUInt32LE(8, relocRaw + 4);
  return image;
}
