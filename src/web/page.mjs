import {configStyles} from './config-ui.mjs';
import {PROJECT_NAME} from '../brand.mjs';
import {groupChatPanel,groupChatStyles} from './group-chat.mjs';
import { styles, touchStyles } from './styles.mjs';
import { client } from './client.mjs';
import { qzonePanel, qzoneStyles } from './qzone.mjs';
import { pluginsPanel, pluginsStyles } from './plugins.mjs';
import { memesPanel, memesStyles } from './memes.mjs';
import { agentPanel, agentStyles } from './agent.mjs';
const icons = {
  chat:'M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z',
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  log:'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',
  tasks:'M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1',
  settings:'M9 4V2h6v2l3 2 2-1 3 5-2 2v3l2 2-3 5-2-1-3 2v2H9v-2l-3-2-2 1-3-5 2-2v-3l-2-2 3-5 2 1z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  arrow:'M5 12h14 m-5-5 5 5-5 5',
  chevron:'m9 5 7 7-7 7',
  search:'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  shield:'m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z m-4 10 3 3 5-6',
  user:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3',
  refresh:'M20 7a9 9 0 1 0 1 9 M20 2v6h-6',
  copy:'M9 9h12v12H9z M15 5V3H3v12h2',
  qr:'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h2v2h-2z M21 15v6h-6 M12 3v3 M3 12h3 M12 12h3 M12 21v-3',
  bolt:'m13 2-9 12h7l-1 8 10-13h-8z',
  send:'m22 2-7 20-4-9-9-4z M22 2 11 13',
  menu:'M4 6h16 M4 12h16 M4 18h16',
  download:'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  pause:'M8 4v16 M16 4v16',
  check:'m5 12 4 4L19 6',
  picture:'M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5 M16 7h.01',
  plugin:'M8 3v4H4v6h4v4h6v-4h4V7h-4V3z M8 21h6 M21 7v6',
};
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const symbols = Object.entries(icons).map(([name,path])=>`<symbol id="i-${name}" viewBox="0 0 24 24"><path d="${path}"/></symbol>`).join('');
export function renderPage(nonce) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${PROJECT_NAME} · 机器人管理</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23272936'/%3E%3Cpath d='M8 10h16v11H14l-6 4z' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E"><style nonce="${nonce}">${styles}
${qzoneStyles}${pluginsStyles}${memesStyles}${agentStyles}${configStyles}${groupChatStyles}${touchStyles}</style></head><body>
<a href="#main" class="skip">跳到主要内容</a><svg class="sprite" aria-hidden="true">${symbols}</svg>
<button class="mobile-shade" id="shade" aria-label="关闭导航" hidden></button>
<aside class="sidebar" id="sidebar"><button class="nav-close" id="nav-close" aria-label="关闭导航">${icon('chevron')}</button><a class="brand" href="#overview"><span class="brand-mark">${icon('chat')}</span><span><strong>${PROJECT_NAME}</strong><small>本机机器人管理</small></span></a>
<nav class="nav" aria-label="主要导航">
<span class="nav-label">机器人管理</span>
<button data-view="overview" aria-current="page">${icon('grid')}运行概览</button>
<button data-view="agent">${icon('bolt')}Agent 管理</button>
<button data-view="plugins">${icon('plugin')}插件管理</button>
<button data-view="groupchat">${icon('chat')}群聊增强</button>
<span class="nav-label">内容与运行</span>
<button data-view="monitor">${icon('log')}运行监控</button>
<button data-view="qzone">${icon('send')}QQ 空间</button>
<button data-view="memes">${icon('picture')}表情图库</button>
<span class="nav-label">配置</span>
<button data-view="settings">${icon('settings')}全部设置</button>
</nav><div class="sidebar-foot"><span class="local-label">${icon('shield')}仅本机访问</span><p>QQNT 内核 · OneBot v11</p><p>你的机器人，由你掌控。</p></div></aside>
<div class="shell"><header class="topbar"><div class="breadcrumb"><button class="menu-toggle" id="menu" aria-label="打开导航" aria-expanded="false">${icon('menu')}</button><span>工作台</span><span class="divider">/</span><span id="breadcrumb">运行概览</span></div><div class="top-actions"><button class="mode-switch" id="test-chat-entry" type="button" aria-pressed="false" aria-label="切换到测试对话">${icon('chat')}<span>测试对话</span></button><label class="search-global">${icon('search')}<input id="global-search" type="search" placeholder="查找配置…" aria-label="查找配置，按回车搜索"></label><span class="connection" id="connection-wrap"><i class="dot"></i><span id="connection">正在连接</span></span></div></header>
<main class="content" id="main" tabindex="-1"><div id="demo" class="banner" hidden>演示模式：使用独立模拟账号与数据，不会登录真实 QQ 或发送真实消息。设置仅在本次演示期间保存。</div>
<div class="page-head"><div><h1 id="page-title">运行概览</h1><p id="page-description">连接你的 QQ，查看助手的实时运行情况。</p></div><button class="button" id="manual-refresh">${icon('refresh')}刷新状态</button></div>
<div class="banner error" id="service-error" role="alert" hidden></div>
<section id="view-overview" aria-label="运行概览"><div class="overview-actions"><button class="button" data-go="settings" data-group="ai">${icon('settings')}配置模型与回复</button><button class="button" data-go="plugins">${icon('plugin')}管理插件</button><button class="button" data-go="jobs">${icon('tasks')}检查任务队列</button></div><div class="overview-grid">
<div class="panel"><div class="panel-head"><h2>QQ 连接</h2><span class="tag" id="driver">读取中</span></div><div class="panel-body"><div class="account-line"><span class="avatar">${icon('user')}</span><div><strong id="account">正在读取账号</strong><p id="account-hint">等待服务响应</p></div><div class="account-controls"><button class="button danger" id="logout" hidden>退出登录</button></div></div>
<dl class="facts"><div><dt>连接状态</dt><dd id="state" role="status">正在检查</dd></div><div><dt>AI 自动回复</dt><dd id="ai-status">读取中</dd></div><div><dt>内核版本</dt><dd id="kernel-version">—</dd></div><div><dt>最近同步</dt><dd id="checked">—</dd></div></dl>
<div class="login-area" id="login-area" hidden><div class="qr-frame"><img id="qr" alt="QQ 登录二维码，请使用手机 QQ 扫描" hidden><div class="qr-placeholder" id="qr-placeholder">${icon('qr')}点击按钮获取二维码</div></div><div class="login-text"><h3>用手机 QQ 扫码登录</h3><p>打开手机 QQ 扫一扫，并在手机上确认登录。</p><button class="button primary" id="refresh">${icon('qr')}获取二维码</button><small id="qr-expiry"></small><p id="error" class="error" role="alert" hidden></p></div></div>
</div></div>
<div class="panel"><div class="panel-head"><h2>服务状态</h2><span class="tag ok" id="service-tag">检查中</span></div><div class="panel-body"><dl class="status-list"><div><dt>机器人服务</dt><dd id="backend-state">正在连接</dd></div><div><dt>待处理任务</dt><dd><span id="pending">—</span> 项</dd></div><div><dt>已完成回复</dt><dd><span id="completed">—</span> 项</dd></div><div><dt>需要核对</dt><dd><span id="uncertain">—</span> 项</dd></div></dl><p class="review-note" id="queue-note">任务统计来自当前数据库。</p></div></div>
<div class="panel wide"><div class="panel-head"><h2>消息处理流程</h2><button class="text-button" data-go="settings">配置回复规则 ${icon('chevron')}</button></div><div class="pipeline"><button data-go="messages"><span class="step-mark">${icon('chat')}</span><strong>接收消息</strong><small id="pipe-in">等待连接 QQ</small></button>${icon('arrow')}<button data-go="settings" data-group="ai"><span class="step-mark">${icon('bolt')}</span><strong>AI 生成</strong><small id="pipe-ai">读取配置</small></button>${icon('arrow')}<button data-go="jobs"><span class="step-mark">${icon('send')}</span><strong>发送回复</strong><small id="pipe-out">读取队列</small></button></div></div>
<div class="panel recent-panel"><div class="panel-head"><h2>最近活动</h2><button class="text-button" data-go="logs">查看日志 ${icon('chevron')}</button></div><div id="recent-activity" class="activity-list"><div class="empty"><p>服务启动后，这里将展示最近的运行事件。</p></div></div></div>
<div class="panel"><div class="panel-head"><h2>连接与配置</h2><span class="tag">OneBot v11</span></div><div class="panel-body"><p class="help-text">插件接入地址</p><div class="endpoint"><code id="endpoint">正在读取…</code><button class="button small" id="copy" aria-label="复制 OneBot 接入地址">${icon('copy')}</button></div><p class="help-text">插件使用 OneBot Token。可在设置中查看或更换独立的接口凭据。</p><div class="link-list"><button data-go="settings" data-group="ai">配置模型与系统提示词 ${icon('chevron')}</button><button data-go="settings" data-group="access">设置好友与群聊白名单 ${icon('chevron')}</button><button data-go="settings" data-group="connection">管理接口与事件推送 ${icon('chevron')}</button></div></div></div>
</div></section>
<section id="view-monitor" aria-label="运行监控" hidden>
<div class="monitor-tabs" role="tablist" aria-label="运行监控分区"><button id="monitor-tab-messages" type="button" role="tab" aria-controls="view-messages" aria-selected="true" data-monitor-tab="messages">消息监听</button><button id="monitor-tab-jobs" type="button" role="tab" aria-controls="view-jobs" aria-selected="false" tabindex="-1" data-monitor-tab="jobs">任务队列</button><button id="monitor-tab-logs" type="button" role="tab" aria-controls="view-logs" aria-selected="false" tabindex="-1" data-monitor-tab="logs">运行日志</button></div>
<section id="view-messages" role="tabpanel" aria-labelledby="monitor-tab-messages" tabindex="0"><div class="toolbar"><input id="message-search" type="search" placeholder="搜索消息、QQ 号、群号…" aria-label="搜索消息"><label class="filter-control"><span>会话类型</span><select id="message-type" aria-label="消息类型"><option value="all">全部会话</option><option value="private">私聊消息</option><option value="group">群聊消息</option></select></label><label class="filter-control"><span>消息方向</span><select id="message-direction" aria-label="消息方向"><option value="all">全部方向</option><option value="in">收到的消息</option><option value="out">发送的消息</option></select></label><button class="button" id="pause-messages">暂停显示</button><button class="button" id="clear-messages">清空显示</button><button class="button" id="export-messages">${icon('download')}导出</button></div><p id="message-error" class="stream-error" role="status" hidden></p><div class="panel"><div class="panel-head"><h2>会话消息 <span id="message-count" class="muted">0</span></h2><span class="live-label" id="message-live"><i class="dot"></i>正在监听</span></div><div id="message-feed" class="feed"></div><div class="table-footer"><p id="memory-retention">当前页面使用进程内缓冲，消息与日志合计最多 1000 条；机器人服务进程退出后清空。暂停只冻结显示。</p><p id="disk-retention">磁盘保留策略正在读取…</p><button class="text-button" data-go="settings" data-group="storage">查看磁盘保留设置</button></div></div></section>
<section id="view-jobs" role="tabpanel" aria-labelledby="monitor-tab-jobs" tabindex="0" hidden><div class="toolbar job-toolbar"><label class="filter-control job-session-filter"><span>会话</span><select id="job-conversation"><option value="">全部会话</option></select></label><label class="filter-control"><span>任务状态</span><select id="job-filter"><option value="all">全部状态</option><option value="pending">待处理</option><option value="uncertain">需要核对</option><option value="done">已完成</option><option value="failed">失败</option><option value="ignored">已忽略</option></select></label><span class="help-text" id="job-range" role="status">最新 50 项任务 · 自动更新</span><span class="spacer"></span><button class="button" id="refresh-jobs">${icon('refresh')}刷新队列</button></div><div class="banner" id="uncertain-help" hidden>“结果未知”表示消息可能已经送达。请先在 QQ 中核对，再标记为已发送或放弃，系统不会自动重发。</div><p id="job-error" class="stream-error" role="status" hidden></p><div class="retention-summary"><p id="job-retention">正在读取正文保留策略…</p><button class="text-button" data-go="settings" data-group="storage">管理正文与磁盘保留</button><details id="privacy-audit"><summary id="privacy-summary">正文脱敏记录</summary><ul id="privacy-records"></ul></details></div><div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>任务</th><th>状态</th><th>生成 / 发送次数</th><th>更新时间</th><th>原因 / 操作</th></tr></thead><tbody id="job-body"></tbody></table></div><div id="job-empty"></div></div></section>
<section id="view-logs" role="tabpanel" aria-labelledby="monitor-tab-logs" tabindex="0" hidden><div class="toolbar"><input id="log-search" type="search" placeholder="搜索事件、任务编号、错误码…" aria-label="搜索日志"><select id="log-level" aria-label="日志级别"><option value="all">全部级别</option><option value="error">ERROR 错误</option><option value="warn">WARN 警告</option><option value="info">INFO 信息</option><option value="debug">DEBUG 调试</option></select><button class="button" id="pause-logs">暂停显示</button><button class="button" id="clear-logs">清空显示</button><button class="button" id="export-logs">${icon('download')}导出</button></div><p id="log-error" class="stream-error" role="status" hidden></p><div class="panel"><div class="panel-head"><h2>服务事件 <span class="muted" id="log-count">0</span></h2><span class="live-label" id="log-live"><i class="dot"></i>实时更新</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>级别</th><th>事件</th><th>详细信息</th></tr></thead><tbody id="log-body"></tbody></table></div><div id="log-empty"></div><div class="table-footer"><p>日志仅包含运行事件与诊断字段，不记录消息正文或密钥。导出为 JSON。</p><p id="log-retention">页面消息与日志共享最多 1000 条进程内缓冲；磁盘保留策略在“数据与保留”中单独设置。</p><button class="text-button" data-go="settings" data-group="storage">查看磁盘保留设置</button></div></div></section>
</section>


${agentPanel}
${qzonePanel}
${pluginsPanel}
${groupChatPanel}
${memesPanel}
<section id="view-settings" aria-label="全部设置" hidden><div id="settings-loading" class="load-placeholder" aria-label="正在加载设置"></div><div class="banner" id="pending-banner" hidden></div><div id="settings-error" class="banner error" role="alert" hidden></div><div id="settings-content" hidden><div class="settings-layout"><nav id="settings-nav" class="settings-nav" aria-label="设置分组"></nav><div class="settings-main"><div class="settings-search"><input id="setting-search" type="search" placeholder="搜索设置名称、说明或变量名…" aria-label="搜索全部设置"></div><div class="panel settings-panel"><div class="settings-title"><h2 id="settings-title">AI 与回复</h2><p id="settings-description"></p></div><form id="settings-form" autocomplete="off"><div class="form-grid" id="fields"></div></form><div class="settings-tools"><button class="button small" id="read-models">读取可用模型</button><datalist id="model-options"></datalist><button class="button small" id="export-settings">${icon('download')}导出配置</button><button class="button small" id="import-settings">导入配置</button><input id="import-file" type="file" accept=".json,application/json"><button class="button small" id="reload-settings">重新加载</button></div><p class="review-note">导出文件不包含密钥。所有设置在服务重启后生效；Web 管理台始终仅限本机访问。</p></div></div></div><div id="savebar" class="savebar"><div><p id="save-state">正在加载设置…</p><small id="save-detail">配置保存后需重启生效</small></div><div class="inline-actions"><button class="button" id="restart">重启生效</button><button class="button primary" id="save" disabled>保存设置</button></div></div></section>
</main></div><div class="toast" id="toast" role="status" hidden></div><dialog class="dialog" id="confirm-dialog"><h2 id="confirm-title"></h2><p id="confirm-body"></p><div class="inline-actions"><button class="button" id="confirm-cancel">取消</button><button class="button primary" id="confirm-ok">确认</button></div></dialog><noscript><p>管理台需要 JavaScript。请启用后重新加载。</p></noscript><script nonce="${nonce}">${client}</script></body></html>`;
}


