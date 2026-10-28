import { bundleQQ } from '../src/qq/kernel/runtime.mjs';
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); if (i === -1) return ''; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`); return args[i + 1]; }
try {
  const result = await bundleQQ({ source: option('--from'), destination: option('--to') || process.env.QQ_RUNTIME_DIR || './runtime/qq' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
