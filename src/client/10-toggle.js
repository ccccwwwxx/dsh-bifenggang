// 「启用避峰岗」开关 —— 左侧侧边栏主入口 + composer 备用入口（移动端/窄屏可达）。
//
// 契约（由 90-apply.js 调用）：registerToggle(ctx, { rpc, t })
//   ctx  — 插件 ctx（ctx.slots.inject / ctx.slots.register）
//   rpc  — 见 00-shared.js：get() / toggle(enabled)
//   t    — 文案函数，key 全部来自 lib/text.js（本文件不新增 key）
// 开关状态由 node 端维持（启用后会话模型选择器功能性失效，由 W1 在 node 端实现），
// 客户端只负责呈现与写回。
//
// 入口与共享状态：
//   1) sidebar.footer.action   —— list / root（.recon/sidebar.client.js:406、:523-526），
//      渲染在侧边栏 footArea 的 footerActions 里，接收 owner props { wide }。
//   2) conversation.input.left —— list / session（.recon/conversation.client.js:18340-18343，
//      渲染于 :17543 composer 输入区），侧边栏不可达时仍随会话显示。
//   两个入口共用 registerToggle 里创建的同一个 store（00-shared.js），只发一次 rpc.get()。

const PEAK_ROUTING_ATTR = 'data-dsh-peak-routing'
const PEAK_ROUTING_STYLE_ID = 'dsh-peak-routing-style'

// 注入样式：
//   a) 开关自身的类（dsh-peak-* 前缀，非构建哈希，稳定）；
//   b) 视觉接管规则 —— 只在 html[data-dsh-peak-routing="on"] 下生效。
// 接管选择器以语义选择器为主：composer 卡片容器（.recon/conversation.client.js:17457
// 的 data-composer-card）内的菜单型触发器按钮；当前唯一占用者是会话模型选择器
// （.recon/model-selection.client.js:839-845 的 trigger button，:426 的 CSS-module 前缀
// 在本构建为 _7KE1Ra_）。哈希类名只作补充匹配，DSH 升级换哈希后本条自然失配并静默降级。
const PEAK_ROUTING_CSS = [
  '.dsh-peak-toggle{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;margin:2px 0;padding:6px 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}',
  '.dsh-peak-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
  '.dsh-peak-toggle:disabled{opacity:.6;cursor:default}',
  '.dsh-peak-toggle[data-on="true"]{color:var(--dsw-alias-state-business-primary,#4c8dff);background:var(--dsw-alias-interactive-bg-hover,rgba(76,141,255,.14));border-color:currentColor}',
  '.dsh-peak-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}',
  '.dsh-peak-label{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-peak-state{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dsh-peak-toggle[data-on="true"] .dsh-peak-state{color:currentColor;opacity:.85}',
  '.dsh-peak-hint{display:block;margin-top:1px;font-size:11px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dsh-peak-warn{margin-left:4px;font-weight:700;color:var(--dsw-alias-state-error-primary,#e5484d)}',
  '.dsh-peak-track{position:relative;flex:none;width:28px;height:16px;border-radius:8px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.45));transition:background .12s ease}',
  '.dsh-peak-toggle[data-on="true"] .dsh-peak-track{background:currentColor}',
  '.dsh-peak-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:transform .12s ease}',
  '.dsh-peak-toggle[data-on="true"] .dsh-peak-knob{transform:translateX(12px)}',
  // 收起态（56px 轨道，内容宽 36px）：32px 方形图标按钮，不撑破轨道。
  '.dsh-peak-rail{position:relative;width:32px;height:32px;margin:0 auto;padding:0;gap:0;justify-content:center}',
  '.dsh-peak-dot{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:currentColor}',
  // composer 备用入口：28px 高，与模型触发器同高，不撑破输入行。
  '.dsh-peak-chip{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;height:28px;max-width:100%;padding:0 8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
  '.dsh-peak-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
  '.dsh-peak-chip:disabled{opacity:.6;cursor:default}',
  '.dsh-peak-chip[data-on="true"]{color:var(--dsw-alias-state-business-primary,#4c8dff);border-color:currentColor}',
  '.dsh-peak-chip-label{max-width:84px;overflow:hidden;text-overflow:ellipsis}',
  '@media (max-width:420px){.dsh-peak-chip-label{display:none}}',
  'html[' + PEAK_ROUTING_ATTR + '="on"] [data-composer-card] button[aria-haspopup="menu"],',
  'html[' + PEAK_ROUTING_ATTR + '="on"] button[class*="_7KE1Ra_trigger"]{',
  'opacity:.45;filter:grayscale(1);pointer-events:none !important;cursor:not-allowed;',
  '}',
].join('\n')

// 注入与属性都是全局副作用：用引用计数让两个入口共存，最后一个卸载时才清理。
// 任何 DOM 异常都吞掉（降级），绝不影响侧边栏渲染。
const peakRoutingVisual = (() => {
  let refs = 0
  let styleEl = null

  const doc = () => (typeof document === 'undefined' ? null : document)

  const ensureStyle = () => {
    const d = doc()
    if (d === null || d.head === null) return
    if (styleEl !== null && styleEl.isConnected === true) return
    const existing = typeof d.getElementById === 'function' ? d.getElementById(PEAK_ROUTING_STYLE_ID) : null
    if (existing !== null && existing !== undefined) {
      styleEl = existing
      return
    }
    const el = d.createElement('style')
    el.id = PEAK_ROUTING_STYLE_ID
    el.textContent = PEAK_ROUTING_CSS
    d.head.appendChild(el)
    styleEl = el
  }

  const apply = (enabled) => {
    const d = doc()
    if (d === null || d.documentElement === null) return
    if (enabled === true) d.documentElement.setAttribute(PEAK_ROUTING_ATTR, 'on')
    else d.documentElement.removeAttribute(PEAK_ROUTING_ATTR)
  }

  return {
    mount(enabled) {
      try {
        refs += 1
        ensureStyle()
        apply(enabled)
      } catch (err) {
        console.error('[peak-valley-router] toggle style injection failed', err)
      }
    },
    apply(enabled) {
      try {
        ensureStyle()
        apply(enabled)
      } catch (err) {
        console.error('[peak-valley-router] toggle style apply failed', err)
      }
    },
    unmount() {
      try {
        refs = Math.max(0, refs - 1)
        if (refs > 0) return // 另一个入口仍在挂载：保持属性与样式
        apply(false)
        if (styleEl !== null && styleEl.isConnected === true) styleEl.remove()
        styleEl = null
      } catch (err) {
        console.error('[peak-valley-router] toggle style cleanup failed', err)
      }
    },
  }
})()

// 挂载时注入一次样式；enabled 变化时同步 html 属性；卸载时按引用计数清理。
function usePeakRoutingVisual(enabled) {
  useEffect(() => {
    peakRoutingVisual.mount(enabled)
    return () => {
      peakRoutingVisual.unmount()
    }
  }, [])
  useEffect(() => {
    peakRoutingVisual.apply(enabled)
  }, [enabled])
}

// 盾牌 + 对勾（非 emoji；纯装饰，语义由 aria-label / title 承担）。
function PeakRoutingIcon(props) {
  const h = React.createElement
  const size = props && props.size ? props.size : 16
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    'aria-hidden': 'true',
    focusable: 'false',
    style: { flex: 'none' },
  }, [
    h('path', { key: 'shield', d: 'M8 1.6 13.2 3.7v3.9c0 3.1-2.1 5.6-5.2 6.8-3.1-1.2-5.2-3.7-5.2-6.8V3.7L8 1.6Z' }),
    h('path', { key: 'check', d: 'M5.6 8.1 7.3 9.8l3.1-3.4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ])
}

// 开关行为（两个入口共用）：状态来自共享 store，点击写回 node 端。
function usePeakToggle(deps) {
  const store = deps ? deps.store : null
  const t = deps && typeof deps.t === 'function' ? deps.t : (key) => key
  const { view, toggle } = usePeakRouting(store)
  usePeakRoutingVisual(Boolean(view && view.enabled))

  if (!view) return null

  const enabled = view.enabled === true
  const failed = view.failed === true
  const label = t('toggleLabel')
  const stateText = enabled ? t('toggleOn') : t('toggleOff')
  const hint = t('toggleHint')
  const errorText = failed && view.error ? String(view.error) : ''
  const title = errorText === '' ? hint : hint + ' — ' + errorText
  const ariaLabel = label + ' · ' + stateText

  const onClick = () => {
    const pending = toggle()
    // store.toggle 内部已 try/catch，这里只兜底未处理的 rejection。
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  }

  return { enabled, failed, errorText, label, stateText, hint, title, ariaLabel, busy: view.busy === true, onClick }
}

// 侧边栏入口：wide=true 展开态显示标签+开关+状态（开启时加一行提示），
// wide=false 是 56px 轨道，只显示 32px 图标按钮 + 状态点。
function PeakSidebarToggle(props) {
  const h = React.createElement
  const wide = props.wide !== false
  const state = usePeakToggle(props)
  if (state === null) return null

  const switchProps = {
    type: 'button',
    role: 'switch',
    'aria-checked': state.enabled ? 'true' : 'false',
    'aria-label': state.ariaLabel,
    title: state.title,
    'data-on': state.enabled ? 'true' : 'false',
    disabled: state.busy,
    onClick: state.onClick,
  }

  if (!wide) {
    return h('button', { ...switchProps, className: 'dsh-peak-toggle dsh-peak-rail' }, [
      h(PeakRoutingIcon, { key: 'icon', size: 18 }),
      state.enabled ? h('span', { key: 'dot', className: 'dsh-peak-dot', 'aria-hidden': 'true' }) : null,
    ])
  }

  const labelRow = h('span', { key: 'label-row', className: 'dsh-peak-label' }, [
    state.label,
    state.failed ? h('span', { key: 'warn', className: 'dsh-peak-warn', title: state.errorText }, '!') : null,
  ])

  return h('button', { ...switchProps, className: 'dsh-peak-toggle dsh-peak-toggle-wide' }, [
    h('span', { key: 'text', className: 'dsh-peak-text' }, [
      labelRow,
      h('span', { key: 'state', className: 'dsh-peak-state' }, state.stateText),
      state.enabled ? h('span', { key: 'hint', className: 'dsh-peak-hint', title: state.hint }, state.hint) : null,
    ]),
    h('span', { key: 'track', className: 'dsh-peak-track', 'aria-hidden': 'true' }, h('span', { className: 'dsh-peak-knob' })),
  ])
}

// composer 备用入口（conversation.input.left，会话内恒在）：紧凑 chip，28px 高。
function PeakComposerToggle(props) {
  const h = React.createElement
  const state = usePeakToggle(props)
  if (state === null) return null

  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': state.enabled ? 'true' : 'false',
    'aria-label': state.ariaLabel,
    title: state.title,
    'data-on': state.enabled ? 'true' : 'false',
    disabled: state.busy,
    onClick: state.onClick,
    className: 'dsh-peak-chip',
  }, [
    h(PeakRoutingIcon, { key: 'icon', size: 14 }),
    h('span', { key: 'label', className: 'dsh-peak-chip-label' }, t0(props, 'nav')),
    state.failed ? h('span', { key: 'warn', className: 'dsh-peak-warn' }, '!') : null,
  ])
}

// 文案取值兜底：t 缺失或抛错时退回 key，绝不因文案问题中断渲染。
function t0(props, key) {
  try {
    const value = props && typeof props.t === 'function' ? props.t(key) : key
    return typeof value === 'string' && value !== '' ? value : key
  } catch (err) {
    return key
  }
}

function registerToggle(ctx, deps) {
  const api = deps ? deps.rpc : null
  const t = deps && typeof deps.t === 'function' ? deps.t : null
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return
  if (!api || typeof api.get !== 'function' || typeof api.toggle !== 'function' || t === null) return

  // 两个入口共享的唯一状态源（一次 rpc.get()）。
  const store = createPeakRoutingStore(api)
  const inject = () => ({ rpc: api, t, store })

  // 主入口：侧边栏底部（list / root），owner 传入 { wide }。
  // 注：ctx.slots.register 内部已用 ctx.effect 包裹（.recon/renderer.client.js:1788-1791），
  // 这里不再包一层；list 槽必须有唯一 id（.recon/slots.index.js:181-186）。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'peak-valley-router-toggle',
    order: 50,
    inject,
  }, PeakSidebarToggle))

  // 备用入口：composer 输入区左侧（list / session）。窄屏（<1024px，layout.client.js:13/:236）
  // 或 Windows 收起态（collapsedWidth=0，layout.client.js:241；footArea display:none，
  // sidebar.client.js:91）时侧边栏入口不可达，此入口仍在。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'peak-valley-router-toggle',
    order: 40,
    inject,
  }, PeakComposerToggle))
}
