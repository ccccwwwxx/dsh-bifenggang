// 左侧「启用避峰岗」开关。
//
// 契约（由 90-apply.js 调用）：registerToggle(ctx, { rpc, t, narrow })
//   ctx    — 插件 ctx（可用 ctx.slots.inject / ctx.slots.register）
//   rpc    — 见 00-shared.js
//   t      — 文案函数
// 开关状态由 node 端维持：启用后 provider 选择器失效、逻辑切到避峰岗路由。

function registerToggle(ctx, deps) {
  // 占位：插槽名与会话联动方式待客户端侦察结论确认后实现。
  void ctx
  void deps
}
