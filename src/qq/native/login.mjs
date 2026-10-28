import { createECDH, createHash, randomBytes } from 'node:crypto';
import { BotError } from '../../errors.mjs';
import { cat, uint, sized, tlvs, Reader } from './binary.mjs';
import { encode, decode, nested, text } from './protobuf.mjs';
import { encrypt, decrypt } from './tea.mjs';

const publicKey = '04EBCA94D733E399B2DB96EACDD3F69A8BB0F74224E2B44E3357812211D2E62EFBC91BB553098E25E33A799ADC7F76FEB208DA7C6522CDB0719A305180CC54A82E';
export class LoginCodec {
  constructor() {
    this.ecdh = createECDH('prime256v1'); this.ecdh.generateKeys();
    this.key = createHash('md5').update(this.ecdh.computeSecret(Buffer.from(publicKey, 'hex')).subarray(0, 16)).digest();
    this.randomKey = randomBytes(16);
  }
  wrap(account, command, body) {
    const header = cat(uint(2, 1), uint(0, 2), uint(8001, 2), uint(command, 2), uint(1, 2), uint(account),
      Buffer.from([3, 0x87, 0]), uint(2), uint(0), uint(0), Buffer.from([2, 1]), this.randomKey,
      uint(0x131, 2), uint(1, 2), sized(this.ecdh.getPublicKey(), 2, false));
    const packet = cat(header, encrypt(body, this.key), uint(3, 1));
    packet.writeUInt16BE(packet.length, 1);
    return packet;
  }
  unwrap(packet) {
    const reader = new Reader(packet);
    if (reader.u(1) !== 2 || reader.u(2) !== packet.length) throw new BotError('Invalid QQ login envelope', 1500);
    reader.skip(11);
    const method = reader.u(1); reader.skip(1);
    const cipher = reader.take(reader.remaining - 1);
    if (reader.u(1) !== 3 || method !== 0) throw new BotError('Unsupported QQ login encryption', 1500);
    try { return decrypt(cipher, this.key); }
    catch { return decrypt(cipher, this.randomKey); }
  }
  qrEnvelope(session, profile, command, body) {
    const length = body.length;
    return this.wrap(session.account, 2066, cat(uint(0, 1), uint(length + 53, 2), uint(profile.app_id), uint(0x72),
      Buffer.alloc(3), uint(Math.floor(Date.now() / 1000)), uint(2, 1), uint(length + 49, 2), uint(command, 2),
      Buffer.alloc(21), uint(3, 1), uint(50), Buffer.alloc(14), uint(profile.app_id), body));
  }
  qrRequest(session, profile) {
    const guid = Buffer.from(session.guid, 'hex');
    const fields = [
      [0x16, cat(uint(0), uint(profile.app_id), uint(profile.sub_app_id), guid,
        sized(profile.package_name, 2, false), sized(profile.pt_version, 2, false), sized(profile.package_name, 2, false))],
      [0x1b, cat(...[0, 0, 3, 4, 72, 2, 2].map(n => uint(n)), uint(0, 2))],
      [0x1d, cat(uint(1, 1), uint(profile.misc_bitmap), uint(0), uint(0, 1))],
      [0x33, guid], [0x35, uint(profile.pt_os_version)], [0x66, uint(profile.pt_os_version)],
      [0xd1, encode({ 1: { 1: profile.os, 2: session.deviceName }, 4: { 6: 1 } })]
    ];
    return this.qrEnvelope(session, profile, 0x31, cat(Buffer.alloc(11), tlvs(fields), uint(3, 1)));
  }
  parseQr(packet) {
    const reader = new Reader(this.unwrap(packet)).skip(54);
    const code = reader.u(1), signature = reader.sized(2, false), fields = reader.tlvs();
    const image = fields.get(0x17);
    if (code !== 0 || !signature.length || !image?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new BotError(`QQ QR request rejected or invalid (${code})`, 1500);
    }
    return { signature, image };
  }
  qrPoll(session, profile, signature) {
    return this.qrEnvelope({ ...session, account: 0 }, profile, 0x12,
      cat(sized(signature, 2, false), Buffer.alloc(13), uint(0x83, 1)));
  }
  parseQrPoll(packet) {
    const reader = new Reader(this.unwrap(packet)).skip(54);
    const code = reader.u(1);
    const state = new Map([[0, 'confirmed'], [17, 'expired'], [48, 'waiting_scan'], [53, 'waiting_confirm'], [54, 'cancelled']]).get(code);
    if (!state) return { state: 'failed', protocol_code: code };
    if (code !== 0) return { state };
    reader.skip(4); const account = reader.u(); reader.skip(4);
    const fields = reader.tlvs();
    const credential = fields.get(0x18), noPic = fields.get(0x19), key = fields.get(0x1e);
    if (!account || !credential?.length || !noPic?.length || key?.length !== 16) {
      throw new BotError('QQ QR confirmation lacks credentials', 1500);
    }
    return { state, account, credential, noPic, key };
  }
  loginRequest(session, profile, confirmation) {
    const guid = Buffer.from(session.guid, 'hex');
    const device = tlvs([
      [0x16e, Buffer.from(session.deviceName)],
      [0x147, cat(uint(profile.app_id), sized(profile.pt_version, 2, false), sized(profile.package_name, 2, false))],
      [0x128, cat(Buffer.from([0, 0, 0, 1, 0]), uint(0), sized(profile.os, 2, false), sized(guid, 2, false), uint(0, 2))],
      [0x124, Buffer.alloc(12)]
    ]);
    const fields = [
      [0x106, confirmation.credential], [0x144, encrypt(device, confirmation.key)],
      [0x116, cat(uint(0, 1), uint(12058620), uint(profile.sub_sigmap), uint(0, 1))],
      [0x142, cat(uint(0, 2), sized(profile.package_name, 2, false))], [0x145, guid],
      [0x18, cat(uint(0, 2), uint(5), uint(0), uint(profile.app_client_version), uint(session.account), uint(0))],
      [0x141, cat(sized('Unknown', 4, false), sized('', 4, false))],
      [0x177, cat(uint(1, 1), uint(0), sized(profile.wtlogin_sdk, 2, false))], [0x191, uint(0, 1)],
      [0x100, cat(uint(0, 2), ...[5, profile.app_id, profile.sub_app_id, 8001, profile.main_sigmap].map(n => uint(n)))],
      [0x107, Buffer.from([0, 1, 0x0d, 0, 0, 1])], [0x318, Buffer.alloc(0)],
      [0x16a, confirmation.noPic], [0x166, uint(5, 1)], [0x521, cat(uint(0x13), sized('basicim', 2, false))]
    ];
    return this.wrap(session.account, 2064, cat(uint(9, 2), tlvs(fields)));
  }
  parseLogin(packet, key) {
    const reader = new Reader(this.unwrap(packet)).skip(2);
    const code = reader.u(1), fields = reader.tlvs();
    if (code !== 0) {
      const verification = [2, 160, 162, 204, 239].includes(code);
      return { state: verification ? 'verification_required' : 'failed', protocol_code: code };
    }
    const payload = fields.get(0x119);
    if (!payload) throw new BotError('QQ authentication missing session', 1500);
    const credentials = new Reader(decrypt(payload, key)).tlvs();
    const d2 = credentials.get(0x143), d2key = credentials.get(0x305), tgt = credentials.get(0x10a);
    if (!d2?.length || d2key?.length !== 16 || !tgt?.length) throw new BotError('QQ authentication credentials incomplete', 1500);
    let nickname = '', uid = '';
    if (credentials.has(0x11a)) nickname = new Reader(credentials.get(0x11a)).skip(4).sized(1, false).toString();
    if (credentials.has(0x543)) uid = text(nested(nested(decode(credentials.get(0x543)), 9), 11), 1);
    return { state: 'authenticated', d2, d2key, tgt, nickname, uid };
  }
}

export const registerRequest = (session, profile) => encode({
  1: session.guid.toUpperCase(), 2: 0, 3: profile.current_version, 4: 0, 5: 2052,
  6: { 1: session.deviceName, 2: profile.kernel, 3: session.systemKernel, 4: '', 5: profile.vendor_os },
  7: 0, 8: 0, 9: 1
});
export function assertRegistered(packet) {
  if (text(decode(packet), 2) !== 'register success') {
    const error = new BotError('QQ session registration rejected; scan again', 1501);
    error.authExpired = true; throw error;
  }
}
