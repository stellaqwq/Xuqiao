import { BotError } from '../../errors.mjs';

// Small PE32+ reader for an explicit N-API host adaptation. No executable code,
// signature verifier, or account data is patched.
export function readPE(bytes) {
  const fail = () => { throw new BotError('Unsupported or malformed Windows kernel image', 1501); };
  const check = (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) fail(); };
  const u16 = p => { check(p, 2); return bytes.readUInt16LE(p); };
  const u32 = p => { check(p, 4); return bytes.readUInt32LE(p); };
  const u64 = p => { check(p, 8); return bytes.readBigUInt64LE(p); };
  if (u16(0) !== 0x5a4d) fail();
  const pe = u32(60), optional = pe + 24;
  if (u32(pe) !== 0x4550 || u16(pe + 4) !== 0x8664 || u16(optional) !== 0x20b) fail();
  const sections = [];
  for (let i = 0; i < u16(pe + 6); i++) {
    const p = optional + u16(pe + 20) + 40 * i;
    sections.push({ virtualSize: u32(p + 8), rva: u32(p + 12), size: u32(p + 16), raw: u32(p + 20) });
  }
  const offset = rva => {
    const section = sections.find(s => rva >= s.rva && rva < s.rva + Math.max(s.virtualSize, s.size));
    if (!section || rva - section.rva >= section.size) fail();
    const p = section.raw + rva - section.rva; check(p, 1); return p;
  };
  const string = p => {
    check(p, 1); const end = bytes.indexOf(0, p);
    if (end < p || end - p > 4096) fail();
    return { value: bytes.subarray(p, end).toString('ascii'), offset: p, length: end - p };
  };
  const imports = [];
  const importRva = u32(optional + 120);
  if (importRva) {
    let p = offset(importRva);
    for (let count = 0; count < 4096 && u32(p + 12); count++, p += 20) {
      const library = string(offset(u32(p + 12))), names = [];
      let thunk = offset(u32(p) || u32(p + 16));
      for (let count = 0; count < 65536 && u64(thunk); count++, thunk += 8) {
        const rva = u64(thunk);
        if (rva & (1n << 63n)) names.push({ ordinal: Number(rva & 0xffffn) });
        else names.push(string(offset(Number(rva)) + 2));
      }
      imports.push({ library, names });
    }
  }
  const exports = new Set(), exportRva = u32(optional + 112);
  if (exportRva) {
    const p = offset(exportRva), count = u32(p + 24), names = offset(u32(p + 32));
    if (count > 1000000) fail();
    for (let i = 0; i < count; i++) exports.add(string(offset(u32(names + i * 4))).value);
  }
  return { imports, exports };
}

export function adaptKernelToNode(original, nodeExecutable) {
  const image = readPE(original), host = readPE(nodeExecutable);
  const dependency = image.imports.find(i => i.library.value.toLowerCase() === 'qqnt.dll');
  if (!dependency) throw new BotError('QQ kernel has no supported QQNT N-API import table', 1501);
  const stop = '?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z';
  const names = dependency.names.map(n => n.value === 'qq_magic_napi_register' ? 'napi_module_register' : n.value);
  if (names.some(n => !n || (n !== stop && !host.exports.has(n)))) throw new BotError('Node executable is missing exports required by this QQ kernel', 1501);
  const registration = dependency.names.find(n => n.value === 'qq_magic_napi_register');
  if (!registration) throw new BotError('Unsupported QQ kernel module registration', 1501);
  const adapted = Buffer.from(original), changes = [];
  const definitions = dependency.names.map(entry => {
    const source = entry.value;
    const target = source === stop ? 'qq_is_environment_stopping' :
      `node.exe.${source === 'qq_magic_napi_register' ? 'napi_module_register' : source}`;
    if (!/^[\w?@$]+$/.test(source)) throw new BotError('Unsupported kernel import name', 1501);
    return `  "${source}"="${target}"`;
  });
  return { adapted, changes, required_exports: names.length,
    imports: dependency.names.map(entry => entry.value),
    definition: 'LIBRARY QQNT\nEXPORTS\n' + definitions.join('\n') + '\n' };
}
