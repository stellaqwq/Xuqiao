import { qzoneToolDefinitions } from '../src/qzone/tools.mjs';

// Register each tool's name/description/inputSchema with your AI framework and
// dispatch its tool calls to execute(). Keep adminToken in the host process.
export function createQzoneTools({ baseUrl = 'http://127.0.0.1:5700', adminToken }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid bot URL');
  if (typeof adminToken !== 'string' || adminToken.length < 24) throw new Error('ADMIN_ACCESS_TOKEN is required');
  return Object.fromEntries(qzoneToolDefinitions.map(definition => [definition.name, {
    name: definition.name, description: definition.description, inputSchema: definition.inputSchema,
    async execute(params) {
      const url = new URL(definition.endpoint.path, base);
      const post = definition.endpoint.method === 'POST';
      if (!post) url.searchParams.set('request_id', params.request_id);
      let response, result;
      try {
        response = await fetch(url, { method: definition.endpoint.method, redirect: 'error',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          ...(post ? { body: JSON.stringify(params) } : {}), signal: AbortSignal.timeout(35000) });
        result = await response.json();
      } catch {
        throw new Error('请求未完成。请用 get_qzone_post_result 查询原 request_id；不要换编号重复发布。');
      }
      if (!response.ok || result.retcode !== undefined && result.retcode !== 0) throw new Error(result.message || 'QQ 空间接口调用失败。');
      return Object.hasOwn(result, 'retcode') ? result.data : result;
    }
  }]));
}
