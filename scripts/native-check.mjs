import { loadConfig } from '../src/config.mjs';
import { loadProfile } from '../src/qq/native/profile.mjs';
import { QQTransport } from '../src/qq/native/transport.mjs';

try {
  const config = loadConfig(), profile = loadProfile(config.native.profilePath);
  const result = { protocol: 'self-developed-ntqq', experimental: true, profile: profile.current_version,
    signer_configured: Boolean(config.native.signUrl), tcp_reachable: null, authenticated_test: false };
  if (process.argv.includes('--connect')) {
    const transport = new QQTransport({ ...config.native, session: {}, profile, timeout: 8000 });
    try { await transport.open(); result.tcp_reachable = true; }
    catch { result.tcp_reachable = false; }
    finally { transport.close(); }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.signer_configured || result.tcp_reachable === false) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
