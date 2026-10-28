import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { renderPage } from './page.mjs';

export async function createLoginServer({ backend, token, port = 0, connection, restart }) {
  if (!token) throw new Error('ADMIN_ACCESS_TOKEN is missing; run npm run init first');
  const prefix = `/login/${randomBytes(24).toString('hex')}`, nonce = randomBytes(24).toString('base64');
  let qr, inFlight, closing;
  const controller = new AbortController();
  async function call(path, params) {
    const current = connection ? connection() : { backend, token };
    const base = new URL(current.backend);
    const response = await fetch(new URL(path, base), { method: params === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'application/json' },
      body: params === undefined ? undefined : JSON.stringify(params),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) });
    const value = await response.json();
    if ((path.startsWith('/admin/plugins') || path.startsWith('/admin/memes')) && response.status === 404 && value.retcode === 1404) {
      throw Object.assign(new Error('当前机器人服务仍为旧版本，尚未加载新增的插件或图库接口。请在原启动窗口按 Ctrl+C 退出机器人，再重新运行 start.cmd，然后刷新此页面；只关闭网页或打开第二个工作台不会更新旧服务。'), { status: 409 });
    }
    if (!response.ok || value.status === 'failed') throw Object.assign(new Error(value.message || '无法连接机器人服务'), { status:response.status });
    return value.data ?? value;
  }
  async function snapshot() {
    let status = await call('/admin/status');
    const current = qr;
    let login;
    if (!status.online && current?.handle) {
      try { login = await call('/admin/login/poll', { handle: current.handle }); }
      catch { /* Restarting the host can invalidate an earlier QR handle. */ }
      if (login?.state === 'online') status = await call('/admin/status');
    }
    return { online: status.online === true,
      state: status.online ? 'online' : login?.state || status.kernel?.login_state || status.native?.login_state || 'idle',
      account: status.account || 0, driver: status.driver, simulated: status.simulated === true,privacy:status.privacy,
      ai_enabled: status.ai_enabled === true, jobs: status.jobs || {}, version: status.kernel?.version || null,
      endpoint: new URL(connection ? connection().backend : backend).origin, can_restart:!!restart,
      expires_at: current === qr ? login?.expires_at ?? qr?.expires_at ?? null : null,
      handle: qr?.handle || null, checked_at: Date.now() };
  }
  const html = renderPage(nonce);
  const server = createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; img-src 'self' data:; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` };
    function reply(code, data, type = 'application/json') {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(code, { ...headers, 'Content-Type': `${type}; charset=utf-8` }); res.end(type === 'text/html' ? data : JSON.stringify(data));
    }
    const address = server.address(), origin = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null;
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.slice(prefix.length);
    const routes = ['', '/qr','/state','/settings','/settings/reveal','/models','/telemetry','/jobs','/job-conversations','/job','/resolve','/logout','/restart'];
    routes.push('/qzone/status','/qzone/posts','/qzone/session','/qzone/clear','/qzone/check','/qzone/draft','/qzone/generate','/qzone/publish','/qzone/resolve');
    routes.push('/plugins/reload','/plugins/groupchat','/plugins/groupchat/action','/plugins','/plugins/detail','/plugins/save','/plugins/toggle','/plugins/delete','/plugins/test','/plugins/install');
    routes.push('/voicestudio/voices');
    routes.push('/agent','/agent/chat','/agent/chat/stream','/agent/attachments','/agent/memories','/agent/memory/update','/agent/persona','/agent/persona/delete','/agent/bind','/agent/reset','/agent/forget');
    routes.push('/memes','/memes/image','/memes/install','/memes/upload','/memes/edit','/memes/preview','/memes/category/save','/memes/category/delete','/memes/settings');
    if (!origin || req.headers.host !== new URL(origin).host || !url.pathname.startsWith(prefix) || !routes.includes(route)) { reply(404, { message: 'Not found' }); return; }
    try {
      if (req.method === 'POST' && req.headers.origin !== origin) { reply(403, { message: 'Origin rejected' }); return; }
      if (req.method === 'GET' && route === '') { reply(200, html, 'text/html'); return; }
      if (req.method === 'GET' && route === '/state') { reply(200, await snapshot()); return; }
      if (req.method === 'GET' && route === '/agent/chat/stream') {
        const session=url.searchParams.get('session');
        if(!/^[a-f0-9-]{36}$/.test(session||'')){reply(400,{message:'网页会话编号无效。'});return;}
        const client=new AbortController(),current=connection?connection():{backend,token};
        res.once('close',()=>client.abort());
        try {
          const response=await fetch(new URL('/admin/agent/chat/stream?session='+encodeURIComponent(session),current.backend),{
            headers:{Authorization:`Bearer ${current.token}`},signal:AbortSignal.any([controller.signal,client.signal])});
          if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream')){
            await response.body?.cancel();reply(502,{message:'实时对话连接失败。'});return;
          }
          res.writeHead(200,{...headers,'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'});res.flushHeaders();
          for await(const chunk of response.body){
            if(res.destroyed)break;
            if(res.writableLength>1024*1024){res.destroy();break;}
            res.write(chunk);
          }
          res.end();
        } finally {client.abort();}
        return;
      }
      if (req.method === 'GET' && ['/agent','/agent/chat','/agent/memories'].includes(route)) { reply(200,await call('/admin'+route+url.search)); return; }
      if (req.method === 'GET' && route === '/settings') { reply(200, await call('/admin/settings')); return; }
      if(req.method==='GET'&&route==='/plugins/groupchat'){reply(200,await call('/admin/plugins/groupchat'+url.search));return;}
      if (req.method === 'GET' && route === '/plugins') { reply(200, await call('/admin/plugins')); return; }
      if (req.method === 'GET' && route === '/memes') { reply(200, await call('/admin/memes' + url.search)); return; }
      if (req.method === 'GET' && route === '/memes/image') {
        const id = url.searchParams.get('id');
        if (!/^[a-f0-9]{64}$/.test(id || '')) { reply(400, { message: '无效表情编号。' }); return; }
        const current = connection ? connection() : { backend, token };
        const response = await fetch(new URL('/admin/memes/image?id=' + id, current.backend), {
          headers: { Authorization: `Bearer ${current.token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        const type = response.headers.get('content-type');
        if (!response.ok || !['image/png','image/jpeg','image/gif','image/webp'].includes(type)) {
          await response.body?.cancel(); reply(response.status === 404 ? 404 : 502, { message: '表情文件不可用，请刷新图库。' }); return;
        }
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 5 * 1024 * 1024) throw new Error('表情超过预览大小限制。'); chunks.push(chunk); }
        if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': size }); res.end(Buffer.concat(chunks)); }
        return;
      }
      if (req.method === 'GET' && route === '/plugins/detail') {
        const id = url.searchParams.get('id');
        if (!/^[a-f0-9-]{36}$/.test(id || '')) { reply(400, { message: '无效插件编号。' }); return; }
        reply(200, await call('/admin/plugins/detail?id=' + encodeURIComponent(id))); return;
      }
      if (req.method === 'GET' && ['/qzone/status','/qzone/posts'].includes(route)) { reply(200, await call('/admin' + route)); return; }
      if (req.method === 'GET' && route === '/jobs') { reply(200, await call('/admin/jobs'+url.search)); return; }
      if (req.method === 'GET' && route === '/job-conversations') { reply(200, await call('/admin/jobs/conversations')); return; }
      if (req.method === 'GET' && route === '/job') {
        const id = url.searchParams.get('id');
        if (!/^[1-9]\d{0,14}$/.test(id||'')) { reply(400, { message:'无效任务编号。' }); return; }
        reply(200, await call('/admin/jobs/'+id)); return;
      }
      if (req.method === 'GET' && route === '/telemetry') {
        const after = url.searchParams.get('after') || '0';
        if (!/^\d{1,16}$/.test(after)) { reply(400, { message:'无效的监听游标。' }); return; }
        reply(200, await call('/admin/telemetry?after=' + after)); return;
      }
      if (req.method === 'POST' && route === '/qr') {
        if (!inFlight) inFlight = call('/admin/login/start', {}).then(value => { qr = value; return value; }).finally(() => { inFlight = null; });
        reply(200, await inFlight); return;
      }
      if (req.method === 'POST' && route === '/restart') {
        if (!restart) { reply(409, { message:'此工作台复用了其他进程的服务。请在原服务窗口重新启动。' }); return; }
        reply(200, await restart()); qr = null; return;
      }
      if (req.method === 'POST' && route === '/logout') { reply(200, await call('/admin/login/logout', {})); qr = null; return; }
      if (req.method === 'POST' && ['/plugins/reload','/plugins/groupchat/action','/agent/chat','/agent/attachments','/agent/memory/update','/agent/persona','/agent/persona/delete','/agent/bind','/agent/reset','/agent/forget','/settings','/settings/reveal','/resolve','/models','/qzone/session','/qzone/clear','/qzone/check','/qzone/draft','/qzone/generate','/qzone/publish','/qzone/resolve','/plugins/save','/plugins/toggle','/plugins/delete','/plugins/test','/plugins/install','/voicestudio/voices','/memes/install','/memes/upload','/memes/edit','/memes/preview','/memes/category/save','/memes/category/delete','/memes/settings'].includes(route)) {
        const chunks = []; let size = 0;
        const maxSize = route === '/agent/attachments' ? 15*1024*1024 : route === '/memes/upload' ? 8 * 1024 * 1024 : 262144;
        for await (const chunk of req) { size += chunk.length; if (size > maxSize) { reply(413, { message:'请求超过大小限制。' }); return; } chunks.push(chunk); }
        const text = Buffer.concat(chunks).toString('utf8');
        let params;
        try { params = JSON.parse(text); } catch { reply(400, { message:'无效 JSON。' }); return; }
        if (!params || typeof params !== 'object' || Array.isArray(params)) { reply(400, { message:'请求必须是对象。' }); return; }
        if (route === '/resolve') {
          if (!Number.isSafeInteger(params.id) || params.id < 1 || !['sent','discard'].includes(params.outcome)) { reply(400, { message:'无效任务操作。' }); return; }
          reply(200, await call(`/admin/jobs/${params.id}/resolve`, { outcome:params.outcome })); return;
        }
        reply(200, await call('/admin' + route, params)); return;
      }
      reply(405, { message: 'Method not allowed' });
    } catch (error) { reply([400,409,413].includes(error.status) ? error.status : 502, { message:error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}`, close() {
    if (!closing) closing = new Promise((resolve, reject) => { controller.abort(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); });
    return closing;
  } };
}
