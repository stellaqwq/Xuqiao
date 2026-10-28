import { readFileSync } from 'node:fs';

// Public protocol constants, not a claim that this version is still accepted.
// The signer must support the selected profile. See docs/NATIVE.md for sources.
export const linuxProfile = Object.freeze({
  os: 'Linux', kernel: 'Linux', vendor_os: 'linux', current_version: '3.2.26-46494',
  build_version: 46494, misc_bitmap: 32764, pt_version: '2.0.0', pt_os_version: 19,
  package_name: 'com.tencent.qq', wtlogin_sdk: 'nt.wtlogin.0.0.1',
  package_sign: 'V1_LNX_NQ_3.2.26-46494_GW_B', app_id: 1600001615,
  sub_app_id: 537345891, app_client_version: 46494, main_sigmap: 169742560, sub_sigmap: 0
});
export function loadProfile(path) {
  const profile = path ? JSON.parse(readFileSync(path, 'utf8')) : { ...linuxProfile };
  for (const [key, sample] of Object.entries(linuxProfile)) {
    const value = profile[key];
    if (typeof sample === 'number' ? !Number.isInteger(value) || value < 0 || value > 0xffffffff :
      typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256) {
      throw new Error(`Invalid native QQ profile field: ${key}`);
    }
  }
  return profile;
}
