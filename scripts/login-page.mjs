import { createLoginServer } from '../src/web/login-server.mjs';
const page = await createLoginServer({ backend: `http://127.0.0.1:${process.env.PORT || 5700}`, token: process.env.ADMIN_ACCESS_TOKEN });
process.stdout.write(`${page.url}\n`);
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => page.close().catch(() => { process.exitCode = 1; }));
