// Paste into the plugin manager. Configuration:
// { "keyword": "帮助", "response": "发送 /ping 检查插件是否在线。" }
export default async function ({ text, config }) {
  if (!config.keyword || !text.includes(config.keyword)) return null;
  return { reply: config.response || '你好，有什么可以帮助你的？' };
}
