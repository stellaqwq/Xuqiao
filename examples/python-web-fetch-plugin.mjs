import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// The exporter embeds the accompanying Python script in the JSON plugin.
const pythonSource = '__PYTHON_WEB_FETCH_SOURCE_BASE64__';

export default async function () { return null; }

export async function findPython(config = {}) {
  if (config.python_path) return { command: config.python_path, args: [] };
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'Programs', 'Python');
    const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of directories.filter(e => e.isDirectory() && /^Python\d+$/.test(e.name)).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}))) {
      const file = join(root, entry.name, 'python.exe');
      try { await access(file); return { command:file, args:[] }; } catch {}
    }
  }
  return process.platform === 'win32' ? { command:'py', args:['-3'] } : { command:'python3', args:[] };
}

export async function invokeTool({ tool, arguments: args, config = {} }) {
  if (tool !== 'fetch_webpage') return { ok:false, error:'unknown_tool', message:'未知网页工具。' };
  let url;
  try {
    url = new URL(args.url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || args.url.length > 2048) throw Error();
  } catch { return { ok:false, error:'invalid_url', message:'请提供完整的 HTTP 或 HTTPS 网页地址。' }; }
  const timeout = Math.min(7000, Math.max(500, Number(config.timeout_ms) || 6000));
  const runtime = await findPython(config);
  const input = { url:url.href, timeout_ms:timeout, max_bytes:Math.min(2097152, Math.max(1024, Number(config.max_bytes) || 1048576)),
    max_chars:Math.min(5000, Math.max(100, Number(args.max_chars ?? config.max_chars) || 4000)),
    max_links:Math.min(10, Math.max(0, Number(args.max_links ?? config.max_links ?? 6))), use_proxy:config.use_proxy !== false };
  return new Promise(resolve => {
    let output='',bytes=0,settled=false,timer;
    const child = spawn(runtime.command,[...runtime.args,'-I','-X','utf8','-u','-c',Buffer.from(pythonSource,'base64').toString('utf8')],{
      shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']
    });
    const finish = result => { if(settled)return;settled=true;clearTimeout(timer);child.kill();resolve(result); };
    timer=setTimeout(()=>finish({ok:false,error:'timeout',message:'网页抓取超时，请稍后重试或换用其他来源。'}),timeout+1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>28000)finish({ok:false,error:'result_too_large',message:'抓取结果超过大小限制。'});else output+=chunk;});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('error',()=>finish({ok:false,error:'python_unavailable',message:'未找到可运行的 Python 3。请在插件配置 python_path 填写 python.exe 的绝对路径。'}));
    child.once('close',code=>{
      if(settled)return;
      if(code===124)return finish({ok:false,error:'timeout',message:'网页抓取超时。'});
      try {
        const result=JSON.parse(output);
        if(!result || typeof result!=='object' || typeof result.ok!=='boolean')throw Error();
        finish(result);
      } catch {finish({ok:false,error:'python_failed',message:'Python 抓取进程未返回有效结果，请检查 Python 路径与网络环境。'});}
    });
    child.stdin.end(JSON.stringify(input));
  });
}
