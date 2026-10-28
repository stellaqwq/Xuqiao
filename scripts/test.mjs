import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function saveReport(path, report) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n'); await rename(temporary, path);
}

export async function runTests({ files, patterns = [], reportPath, write = chunk => process.stdout.write(chunk) }) {
  // Replace a previous green report before starting. A killed/incomplete run
  // must not leave a stale successful artifact for CI to consume.
  await saveReport(reportPath, { success: false, complete: false, status: 'running', fail: 1, cancelled: 0 });
  let summary, sawFailure = false;
  const fileSummaries = new Map();
  const stream = run({ files, concurrency: 1, timeout: 15000, isolation: 'process',
    execArgv: ['--experimental-vm-modules'], ...(patterns.length ? { testNamePatterns: patterns } : {}) });
  stream.on('test:fail', () => { sawFailure = true; });
  stream.on('test:summary', value => {
    if (value.file) fileSummaries.set(value.entryFile || value.file, value.counts);
    summary = value;
  });
  for await (const chunk of stream.compose(new spec())) write(chunk);
  // Node can count an empty file as a passing file-level test. Use the child
  // summaries to require actual declared tests, including filtered runs.
  const counts = Object.fromEntries(['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']
    .map(key => [key, [...fileSummaries.values()].reduce((total, value) => total + (value[key] || 0), 0)]));
  const success = summary?.success === true && fileSummaries.size === files.length && !sawFailure && counts.tests > 0 && counts.passed === counts.tests &&
    counts.failed === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
  const report = { success, complete: success, node: process.versions.node,
    tests: counts.tests ?? 0, pass: counts.passed ?? 0,
    fail: Math.max((counts.failed ?? 0) + (counts.cancelled ?? 0), success ? 0 : 1),
    assertionFailures: counts.failed ?? 0, cancelled: counts.cancelled ?? 0,
    skipped: counts.skipped ?? 0, todo: counts.todo ?? 0, selectedFiles: files, patterns, runnerCounts: summary?.counts };
  await saveReport(reportPath, report);
  write(`Strict result: ${JSON.stringify({ success, tests: report.tests, pass: report.pass, fail: report.fail, cancelled: report.cancelled, skipped: report.skipped, todo: report.todo })}\n`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), files = [], patterns = [];
    let reportPath = resolve('dist/test-results.json');
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--report' || arg === '--test-name-pattern') {
        if (!args[i + 1]) throw new Error(`Missing ${arg} value`);
        if (arg === '--report') reportPath = resolve(args[++i]); else patterns.push(args[++i]);
      } else if (arg.startsWith('--test-name-pattern=')) patterns.push(arg.slice('--test-name-pattern='.length));
      else if (arg.startsWith('-')) throw new Error(`Unsupported test option: ${arg}`);
      else files.push(resolve(arg));
    }
    if (!files.length) {
      const directory = fileURLToPath(new URL('../test/', import.meta.url));
      files.push(...(await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort().map(name => resolve(directory, name)));
    }
    const report = await runTests({ files, patterns, reportPath });
    if (!report.success) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
