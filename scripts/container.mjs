// This image is Linux. The default Windows DLL host cannot run inside it.
if (!['native', 'demo', 'scaffold'].includes(process.env.QQ_DRIVER)) {
  process.stderr.write('Linux container: set QQ_DRIVER=native (experimental, requires a matching signer), or demo/scaffold for tests. The official kernel must run on Windows x64.\n');
  process.exitCode = 1;
} else await import('../src/main.mjs');
