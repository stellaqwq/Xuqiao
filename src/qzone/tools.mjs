const requestId = { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$', description: '本次发布的唯一请求编号。重试和查询必须复用同一编号。' };

export const qzoneToolDefinitions = [
  { name: 'send_qzone_post', description: '立即发布 QQ 空间纯文字说说，无需网页确认。提交 content 直接发布；提交 prompt 则由服务生成后自动发布。两者只能选一项。仅在用户要求发布时调用。',
    endpoint: { method: 'POST', path: '/admin/qzone/send' },
    inputSchema: { type: 'object', properties: {
      request_id: requestId, account: { type: 'integer', minimum: 1, description: '目标空间的 QQ 号，必须与服务器保存的空间凭据一致。' },
      content: { type: 'string', minLength: 1, maxLength: 2000, description: 'AI 已写好的说说正文。' },
      prompt: { type: 'string', minLength: 1, maxLength: 4000, description: '交给服务器 AI 生成并直接发布的主题和素材。' },
      visibility: { type: 'string', enum: ['private', 'friends', 'public'], default: 'private', description: '仅自己、QQ 好友或所有人可见。' }
    }, required: ['request_id', 'account'], oneOf: [{ required: ['content'], not: { required: ['prompt'] } }, { required: ['prompt'], not: { required: ['content'] } }], additionalProperties: false } },
  { name: 'get_qzone_post_result', description: '按 request_id 查询空间发布结果。generating/publishing 表示尚未完成；uncertain 需要人工核对，不能换一个请求编号重复发布。',
    endpoint: { method: 'GET', path: '/admin/qzone/request' },
    inputSchema: { type: 'object', properties: { request_id: requestId }, required: ['request_id'], additionalProperties: false } }
];
