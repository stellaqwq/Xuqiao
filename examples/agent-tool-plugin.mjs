// Copy these exports into a script plugin. Add tools from the accompanying
// example JSON in docs/AGENT.md to its Agent tool definitions editor.
export default async function () { return null; }

export async function invokeTool({ tool, arguments: args, config }) {
  if (tool === 'lookup_order') {
    const item = config.orders?.[args.order_id];
    return item ? { found:true, order_id:args.order_id, ...item } : { found:false };
  }
  throw new Error('Unknown tool');
}
