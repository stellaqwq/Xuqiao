import { BotError } from '../../errors.mjs';

export function buddyListArity(bytes) {
  const values = new Set([...bytes.toString('latin1').matchAll(/NodeIKernelBuddyService::getBuddyListV2 needs (\d+) arguments/g)].map(match => Number(match[1])));
  if (values.size !== 1 || ![2, 3].includes([...values][0])) throw new BotError('Unsupported QQ buddy list API signature', 1501);
  return [...values][0];
}

// This is the SDK sub-application ID embedded in this exact signed QQ build,
// distinct from the public desktop platform application ID.
export function sdkAppId(binary) {
  const marker = Buffer.from('QQAppId/');
  const values = new Set(); let offset = 0;
  while ((offset = binary.indexOf(marker, offset)) !== -1) {
    const value = binary.subarray(offset + marker.length, offset + marker.length + 20).toString('ascii').match(/^(\d{6,12})(?!\d)/)?.[1];
    if (value) values.add(value); offset += marker.length;
  }
  if (values.size !== 1) throw new BotError('Official QQ package has no unique SDK application ID', 1501);
  return [...values][0];
}

export function loginOptions({ appid, version, directory, machineId, platformVersion, hostName }) {
  if (!/^\d{6,12}$/.test(appid || '') || !/^\d+\.\d+\.\d+-\d+$/.test(version || '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(machineId || '')) {
    throw new BotError('QQ login profile is incomplete', 1501);
  }
  return { commonPath: directory, clientVer: version, machineId, platVer: platformVersion, hostName, appid, externalVersion: true };
}
