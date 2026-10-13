// 插件入口：注册文案、左侧开关、设置页区块。

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-peak-valley-router: copy dictionaries')

  const connection = ctx.get('connection')
  const t = ctx.locale.bind(NS)
  const api = rpc(connection)

  // 左侧「启用避峰岗」开关（实现见 10-toggle.js）。
  registerToggle(ctx, { rpc: api, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'peak-valley-router',
    order: 95,
    label: () => t('nav'),
    inject: () => ({ rpc: api, t }),
  }, PolicySettingsSection))
}

exports.apply = apply
exports.inject = inject
