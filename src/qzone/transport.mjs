import { BotError } from '../errors.mjs';

const origin = 'https://user.qzone.qq.com';
const publishPath = '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6';
export const visibilityRights = { public: 1, friends: 4, private: 64 };

export function parseSession(cookie, token = '') {
  if (typeof cookie !== 'string' || cookie.length > 16384 || /[\r\n\x00-\x1f\x7f]/.test(cookie)) {
    throw new BotError('请输入有效的 QQ 空间 Cookie，不能包含换行。', 1400);
  }
  const fields = new Map();
  const allowed = new Set(['uin', 'p_uin', 'skey', 'p_skey', 'pt4_token']);
  for (const pair of cookie.trim().split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (!allowed.has(name)) continue;
    if (fields.has(name) && fields.get(name) !== value) throw new BotError('Cookie 包含冲突字段，请重新复制。', 1400);
    if (!/^[\x21-\x7e]*$/.test(value)) throw new BotError('Cookie 字段格式无效。', 1400);
    fields.set(name, value);
  }
  const accountOf = value => /^o?0*([1-9]\d{4,11})$/.exec(value || '')?.[1];
  const account = accountOf(fields.get('p_uin') || fields.get('uin'));
  if (!account || !fields.get('p_skey')) throw new BotError('Cookie 需要包含 uin（或 p_uin）和 QQ 空间的 p_skey。', 1400);
  for (const name of ['uin', 'p_uin']) {
    if (fields.has(name) && accountOf(fields.get(name)) !== account) throw new BotError('Cookie 中的 QQ 账号不一致。', 1400);
  }
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{0,256}$/.test(token)) throw new BotError('qzonetoken 格式无效。', 1400);
  return { account: Number(account), cookie: [...fields].map(([k, v]) => `${k}=${v}`).join('; '), token };
}

export function gtk(key) {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = (hash + (hash << 5) + key.charCodeAt(i)) | 0;
  return hash & 0x7fffffff;
}

export function parsePayload(text) {
  const raw = text.trim().replace(/^\uFEFF/, '');
  const wrapper = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(([\s\S]*)\)\s*;?$/.exec(raw);
  const result = JSON.parse(wrapper ? wrapper[1] : raw);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Qzone payload');
  return result;
}

async function readBounded(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Qzone response too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class QzoneTransport {
  constructor({ fetch: fetcher = globalThis.fetch, timeout = 15000 } = {}) { this.fetch = fetcher; this.timeout = timeout; }
  headers(session) {
    const cookie = /(?:^|;\s*)p_uin=/.test(session.cookie) ? session.cookie : `${session.cookie}; p_uin=o${session.account}`;
    return { Cookie: cookie, Referer: `${origin}/${session.account}/infocenter`, Origin: origin,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' };
  }
  async check(session, signal) {
    try {
      const response = await this.fetch(`${origin}/${session.account}`, { redirect: 'error', headers: this.headers(session),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeout)]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Qzone home unavailable'); }
      const text = await readBounded(response);
      const assignment = /(?:window\.)?g_qzonetoken\s*=\s*["']([\w-]+)["']/.exec(text);
      const closure = /(?:window\.)?g_qzonetoken\s*=[\s\S]{0,300}?return\s*["']([\w-]+)["']/.exec(text);
      const token = assignment?.[1] || closure?.[1];
      const login = /\bg_iLoginUin\s*=\s*["']?(\d+)["']?\s*[;,]/.exec(text);
      if (login && Number(login[1]) !== session.account) throw new Error('Qzone login identity does not match');
      if (!token && !login) throw new Error('Qzone session expired or verification required');
      return { token: token || '' };
    } catch {
      throw new BotError('无法验证空间凭据。请先在浏览器登录 QQ 空间、完成验证，再更新 Cookie。', 1501);
    }
  }
  async publish(session, { content, visibility }, signal) {
    // All preparation failures happen before the mutation. After fetch starts,
    // only a well-formed nonzero business code proves rejection.
    const token = session.token || (await this.check(session, signal)).token;
    signal?.throwIfAborted();
    const key = /(?:^|; )p_skey=([^;]+)/.exec(session.cookie)?.[1];
    const endpoint = new URL(publishPath, origin);
    endpoint.search = new URLSearchParams({ g_tk: String(gtk(key)), ...(token ? { qzonetoken: token } : {}) });
    const form = new URLSearchParams({ syn_tweet_verson: '1', paramstr: '1', pic_template: '', richtype: '', richval: '',
      special_url: '', subrichtype: '', who: '1', con: content, feedversion: '1', ver: '1',
      ugc_right: String(visibilityRights[visibility]), to_tweet: '0', to_sign: '0', hostuin: String(session.account),
      code_version: '1', format: 'json', qzreferrer: `${origin}/${session.account}/infocenter` });
    let payload;
    try {
      const response = await this.fetch(endpoint, { method: 'POST', redirect: 'error',
        headers: { ...this.headers(session), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: form.toString(), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeout)]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Ambiguous HTTP response'); }
      payload = parsePayload(await readBounded(response));
      if (!Object.hasOwn(payload, 'code') || !/^-?\d+$/.test(String(payload.code))) throw new Error('No business status');
    } catch {
      throw new BotError('发布结果未知，请先在 QQ 空间核对；系统不会自动重发。', 1502, { uncertain: true });
    }
    if (Number(payload.code) !== 0) throw new BotError('QQ 空间拒绝发布，请检查登录凭据、空间权限或在浏览器完成验证。', 1500);
    const tid = payload.tid || payload.t1_tid || payload.data?.tid || payload.data?.t1_tid;
    if (typeof tid !== 'string' || !/^[\w-]{1,200}$/.test(tid)) {
      throw new BotError('空间返回成功但缺少说说编号，请在 QQ 空间核对。', 1502, { uncertain: true });
    }
    return { tid, url: `${origin}/${session.account}/mood/${encodeURIComponent(tid)}` };
  }
}
