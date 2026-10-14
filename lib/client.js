window.__ModuleLoader__.load({ id: "dsh-peak-valley-router", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require("react");
const { useState, useEffect, useCallback, useMemo, useRef } = require("react");

// ---- locales: 由 lib/text.js 注入（单一维护文件，勿手工复制） ----
const zh = {
  "nav": "避峰岗",
  "title": "模型协同策略（避峰岗）",
  "subtitle": "按时间自动路由：命中策略用主模型（峰时可切副模型）；全部未命中时升维到高级模型支援。",
  "loading": "加载中…",
  "pickProvider": "选择 Provider（API / 订阅）",
  "pickModel": "选择模型",
  "effortDefault": "默认思考档",
  "toggleLabel": "启用避峰岗",
  "toggleHint": "开启后由避峰岗自动路由；会话模型选择器失效。",
  "toggleOn": "已启用",
  "toggleOff": "未启用",
  "strategyName": "策略名称",
  "strategyDescription": "触发条件描述",
  "weekdays": "生效星期",
  "primaryModel": "主模型（谷时）",
  "enablePeak": "启用峰谷（峰时用副模型）",
  "peakWindows": "峰时窗口",
  "peakModel": "副模型（峰时）",
  "addStrategy": "+ 添加策略",
  "advancedSupportTitle": "高级模型支援（升维兜底）",
  "advancedSupportHint": "必要时升维：所有策略都未命中时，用高级模型顶替；设置了策略后必填。",
  "advancedSupportModel": "高级模型",
  "remove": "删除",
  "save": "保存",
  "saving": "保存中…",
  "retry": "重试",
  "loadFailed": "加载配置失败",
  "catalogUnavailable": "Provider / 模型目录暂时不可用，下拉可能为空，仍可保存。",
  "modelsLoading": "模型加载中…",
  "modelsLoadFailed": "模型列表加载失败",
  "pickProviderFirst": "请先选择 Provider",
  "noModels": "该 Provider 暂无可用模型",
  "saved": "已保存 {time}",
  "saveFailed": "保存失败：{detail}",
  "errStrategy": "第 {index} 条策略：{issue}",
  "errNeedBoth": "缺少主模型的 Provider 和模型",
  "errNeedModel": "缺少主模型",
  "errNeedProvider": "缺少主模型的 Provider",
  "errBadStrategy": "不是合法的策略对象",
  "errBadPrimary": "主模型不合法",
  "errAdvancedSupport": "设置了策略后必须填写「高级模型支援」",
  "errSeparator": "；",
  "errMore": "（另有 {count} 条同类问题）",
  "weekdayShort": "一,二,三,四,五,六,日",
  "strategyLabel": "策略 {index}",
  "effortLow": "低",
  "effortMedium": "中",
  "effortHigh": "高",
  "effortXhigh": "极高",
  "effortMax": "最高",
  "windowStart": "开始时间",
  "windowEnd": "结束时间"
}
const en = {
  "nav": "Peak Routing",
  "title": "Model Routing Policy (Peak Avoidance)",
  "subtitle": "Time-based routing: a matching strategy uses its primary model (optional peak secondary); otherwise escalate to advanced support.",
  "loading": "Loading…",
  "pickProvider": "Pick provider (API / subscription)",
  "pickModel": "Pick model",
  "effortDefault": "Default effort",
  "toggleLabel": "Enable peak routing",
  "toggleHint": "When on, peak routing decides the model and the session model picker is ignored.",
  "toggleOn": "On",
  "toggleOff": "Off",
  "strategyName": "Strategy name",
  "strategyDescription": "Trigger condition description",
  "weekdays": "Active weekdays",
  "primaryModel": "Primary model (off-peak)",
  "enablePeak": "Enable peak (use secondary during peak)",
  "peakWindows": "Peak windows",
  "peakModel": "Secondary model (peak)",
  "addStrategy": "+ Add strategy",
  "advancedSupportTitle": "Advanced model support (escalation)",
  "advancedSupportHint": "Escalate when necessary: used when no strategy matches; required once strategies are set.",
  "advancedSupportModel": "Advanced model",
  "remove": "Remove",
  "save": "Save",
  "saving": "Saving…",
  "retry": "Retry",
  "loadFailed": "Failed to load configuration",
  "catalogUnavailable": "Provider/model catalog is temporarily unavailable; dropdowns may be empty. You can still save.",
  "modelsLoading": "Loading models…",
  "modelsLoadFailed": "Failed to load models",
  "pickProviderFirst": "Pick a provider first",
  "noModels": "No models available for this provider",
  "saved": "Saved {time}",
  "saveFailed": "Save failed: {detail}",
  "errStrategy": "Strategy #{index} {issue}",
  "errNeedBoth": "needs a primary provider and model",
  "errNeedModel": "needs a primary model",
  "errNeedProvider": "needs a primary provider",
  "errBadStrategy": "is not a valid strategy object",
  "errBadPrimary": "has an invalid primary model",
  "errAdvancedSupport": "advanced model support is required once strategies are set",
  "errSeparator": "; ",
  "errMore": " (+{count} more)",
  "weekdayShort": "Mon,Tue,Wed,Thu,Fri,Sat,Sun",
  "strategyLabel": "Strategy {index}",
  "effortLow": "Low",
  "effortMedium": "Medium",
  "effortHigh": "High",
  "effortXhigh": "Extra high",
  "effortMax": "Max",
  "windowStart": "Start time",
  "windowEnd": "End time"
}

// ---- src/client/00-shared.js ----
// 共享常量与 RPC 封装。所有 client 端模块共用。

const NS = 'settings.peakValley'

const inject = ['slots', 'connection', 'locale']

// 统一解包 { ok, value } 信封；失败时抛出服务端消息。
function rpc(connection) {
  const call = async (method, payload) => {
    const res = await connection.rpc.call('/api', method, payload)
    if (res && res.ok === true) return res.value
    const msg = res?.error?.message ?? res?.error ?? 'RPC failed'
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return {
    get: () => call('dsh-peak-valley-router.get', {}),
    set: (config) => call('dsh-peak-valley-router.set', { config }),
    providers: () => call('dsh-peak-valley-router.providers', {}),
    models: (provider) => call('dsh-peak-valley-router.models', { provider }),
    toggle: (enabled) => call('dsh-peak-valley-router.toggle', { enabled }),
  }
}

// 星期简称：来自 lib/text.js 的 weekdayShort（单一维护文件，zh `一,二…` / en `Mon,Tue…`）。
// key 缺失时 DSH 会把 key 名原样返回，此时整体退回空数组，由调用方显示数字，
// 避免 d=1 把 "weekdayShort" 当成星期的文案渲染出来。
function weekdayLabels(t) {
  const raw = t('weekdayShort')
  if (raw === undefined || raw === null || raw === 'weekdayShort') return []
  return String(raw).split(',')
}

// 控件「自身容器」的宽度（不是窗口宽度）。设置面板常常比窗口窄（分屏、窄窗口、
// 宿主内边距），按窗口判断会把三个下拉硬挤在一行。用 ResizeObserver 实测自身宽度。
// 返回 [ref, narrow]；ref 是回调 ref，挂到被测量的根元素上。
// 用回调 ref + state 保存节点（而不是 useRef）：节点被重新挂载时 effect 会重跑，
// 不会出现「一直在观测旧节点」这种静默失效。
function useContainerWidth(threshold) {
  const [node, setNode] = useState(null)
  const [narrow, setNarrow] = useState(false)
  // ref 回调里**同步**测一次：effect 要等绘制之后才跑，本就窄的容器会先闪一帧宽布局。
  const ref = useCallback((next) => {
    setNode(next || null)
    if (next && next.clientWidth > 0) setNarrow(next.clientWidth < threshold)
  }, [threshold])
  useEffect(() => {
    if (!node) return undefined
    const read = () => {
      const width = node.clientWidth
      // clientWidth 为 0（尚未布局或被隐藏）时保持上一次判断，避免宽度闪一下。
      if (width > 0) setNarrow(width < threshold)
    }
    read()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read)
      return () => window.removeEventListener('resize', read)
    }
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, threshold])
  return [ref, narrow]
}

// ---- 「启用避峰岗」开关的共享状态源 ----
// 侧边栏入口与 composer 备用入口必须读写同一份状态：两边各自 rpc.get 会撕裂状态，
// 所以这里放一个极简订阅源，由 registerToggle 创建一次、注入给两个入口。

function peakRoutingErrorText(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

// rpc.get() -> { config, enabled }；rpc.toggle(enabled) -> { enabled }（见 90-apply.js / lib/index.js）。
function createPeakRoutingStore(api) {
  const listeners = new Set()
  let state = { enabled: false, ready: false, busy: false, failed: false, error: '' }
  let loading = null

  const snapshot = () => ({ ...state })
  const publish = (patch) => {
    state = { ...state, ...patch }
    const view = snapshot()
    // 订阅者（React setState）抛错不得影响其他订阅者，更不得冒泡到开关本身。
    for (const listener of Array.from(listeners)) {
      try {
        listener(view)
      } catch (err) {
        console.error('[peak-valley-router] toggle subscriber failed', err)
      }
    }
  }

  const read = async () => {
    try {
      const value = await api.get()
      const enabled = Boolean(value && value.enabled)
      publish({ enabled, ready: true, busy: false, failed: false, error: '' })
      return enabled
    } catch (err) {
      // 读取失败：保留本地状态，只标记非致命失败（开关仍然可点）。
      publish({ ready: true, busy: false, failed: true, error: peakRoutingErrorText(err) })
      return undefined
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: snapshot,
    // 两个入口共用同一次首次读取（重复挂载不会重复发 rpc.get）。
    ensureLoaded() {
      if (loading === null) loading = read()
      return loading
    },
    async toggle(next) {
      const before = state.enabled
      const desired = typeof next === 'boolean' ? next : !before
      if (state.busy) return before
      publish({ enabled: desired, busy: true, failed: false, error: '' }) // 乐观更新
      try {
        const value = await api.toggle(desired)
        const confirmed = value && typeof value.enabled === 'boolean' ? value.enabled : desired
        publish({ enabled: confirmed, busy: false, failed: false, error: '' }) // 以服务端返回值为准
        return confirmed
      } catch (err) {
        // 失败：回滚到点击前的状态，并给出可展示的非致命错误文本。
        publish({ enabled: before, busy: false, failed: true, error: peakRoutingErrorText(err) })
        return before
      }
    },
  }
}

// 订阅共享 store；首次挂载触发一次共享 rpc.get()。
function usePeakRouting(store) {
  const [view, setView] = useState(() => (store ? store.get() : null))
  useEffect(() => {
    if (!store) return undefined
    setView(store.get())
    const off = store.subscribe(setView)
    store.ensureLoaded()
    return off
  }, [store])
  const toggle = useCallback((next) => (store ? store.toggle(next) : Promise.resolve(false)), [store])
  return { view, toggle }
}

// ---- src/client/10-toggle.js ----
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
// 接管选择器（审计后收窄）：只用「composer 卡片 + 模型触发器类片段」的组合，
// 不再用 `button[aria-haspopup="menu"]` —— 那条虽然在本构建无损，但未来 composer 里
// 新增任何菜单按钮都会被一并禁用。哈希类名是构建生成的，DSH 升级换哈希后本条自然
// 失配并静默降级：视觉变灰消失，但功能性接管（node 端 agent/request 覆盖）不受影响。
  'html[' + PEAK_ROUTING_ATTR + '="on"] [data-composer-card] button[class*="_7KE1Ra_trigger"]{',
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

// ---- src/client/20-modelpicker.js ----
// Provider + 模型 + 思考档 三档选择器。
// 约定：provider 下拉把全部已注册 provider（API 与订阅套餐）并列展示；
// 模型一律「下拉选择」，选项由 40-settings.js 通过 models RPC 拉取后传入（models[providerId]）。
// 降级：providers / 模型拉取失败时下拉仍然可用（可能为空），不阻塞保存。
//
// 布局：宽容器三列（Provider / 模型 各占一份，思考档固定窄列，避免被等分拉长）；
// 窄容器竖直堆叠。narrow 由 40-settings.js 按「控件自身容器宽度」实测后传入，
// 不用窗口宽度（设置面板常比窗口窄）。
//
// props:
//   label          — 选择器标题（如「主模型」）
//   value          — { provider, model, reasoningEffort }
//   providers      — [{ id, name }]，可为空数组
//   models         — { [providerId]: [{ id, name }] }
//   modelsLoading  — 当前 provider 的模型是否正在拉取
//   modelsError    — 当前 provider 的模型拉取失败信息（无失败时为空串）
//   onChange       — (nextValue) => void
//   onNeedModels   — (providerId) => void，切换 provider 时懒加载该 provider 的模型
//   t / narrow     — 文案函数 / 是否窄容器

function ModelPicker(props) {
  const h = React.createElement
  const { label, value, providers, models, modelsLoading, modelsError, onChange, onNeedModels, t, narrow } = props
  const v = value || {}
  const providerList = Array.isArray(providers) ? providers : []

  // provider 选项：显示 name || id，按 id 去重（防止目录重复导致 React key 冲突）。
  const seenProviders = Object.create(null)
  const providerOptions = []
  for (const p of providerList) {
    const id = p && (p.id || p.name) ? String(p.id || p.name) : ''
    if (!id || seenProviders[id]) continue
    seenProviders[id] = true
    providerOptions.push(h('option', { key: 'p:' + id, value: id }, String((p && p.name) || id)))
  }
  // 配置里已选的 provider 不在目录中（目录失败 / 未列出）时保留一项，避免选择器显示为空。
  const providerMissing = Boolean(v.provider) && !seenProviders[String(v.provider)]

  // 模型选项：当前 provider 的目录；目录里没有当前值时额外保留一项。
  const modelList = models && Array.isArray(models[v.provider]) ? models[v.provider] : []
  const modelOptions = []
  const seenModels = Object.create(null)
  for (const m of modelList) {
    const id = m && (m.id || m.name) ? String(m.id || m.name) : ''
    if (!id || seenModels[id]) continue
    seenModels[id] = true
    modelOptions.push(h('option', { key: 'm:' + id, value: id }, String((m && m.name) || id)))
  }
  const modelMissing = Boolean(v.model) && !seenModels[String(v.model)]

  const busy = modelsLoading === true
  const failed = modelsError ? String(modelsError) : ''

  // 模型下拉的第一项：未选 provider / 拉取中 / 失败 / 无模型时给出对应占位，避免空下拉。
  let modelPlaceholder
  if (!v.provider) modelPlaceholder = t('pickProviderFirst')
  else if (failed) modelPlaceholder = t('modelsLoadFailed')
  else if (busy) modelPlaceholder = t('modelsLoading')
  else if (modelOptions.length === 0) modelPlaceholder = t('noModels')
  else modelPlaceholder = t('pickModel')

  const modelChildren = []
  modelChildren.push(h('option', { key: '__placeholder', value: '' }, modelPlaceholder))
  if (modelMissing) {
    modelChildren.push(h('option', { key: '__current', value: String(v.model) }, String(v.model)))
  }
  for (const opt of modelOptions) modelChildren.push(opt)

  // 思考档：value 保持 DSH 的枚举值，标签走文案表（此前直接显示 low/max 这类原始值）。
  const effortChoices = [
    ['', t('effortDefault')],
    ['low', t('effortLow')],
    ['medium', t('effortMedium')],
    ['high', t('effortHigh')],
    ['xhigh', t('effortXhigh')],
    ['max', t('effortMax')],
  ]

  const ctrlStyle = {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
  }
  // 思考档只需要窄栏；等分会让它被拉得很长、值靠左显得空旷。给足最小宽度，
  // 避免「默认思考档」/「Extra high」这类较长标签在原生 select 里被裁切。
  const rowStyle = narrow
    ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }
    : { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(116px, 140px)', gap: 8 }

  const status = failed ? t('modelsLoadFailed') : (busy ? t('modelsLoading') : '')

  return h('div', { style: { minWidth: 0 } },
    label
      ? h('div', {
        style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 },
      }, label)
      : null,
    h('div', { style: rowStyle },
      h('select', {
        'aria-label': t('pickProvider'),
        title: v.provider || '',
        value: v.provider || '',
        style: ctrlStyle,
        onChange: (e) => {
          const next = e.target.value
          // 切换 provider 必须清空 model，避免 provider/model 不匹配。
          onChange({ ...v, provider: next, model: '' })
          if (next && onNeedModels) onNeedModels(next)
        },
      },
        h('option', { key: '__pick', value: '' }, t('pickProvider')),
        providerMissing ? h('option', { key: '__current', value: String(v.provider) }, String(v.provider)) : null,
        ...providerOptions,
      ),
      h('select', {
        'aria-label': label ? label + ' · ' + t('pickModel') : t('pickModel'),
        title: v.model || '',
        value: v.model || '',
        style: ctrlStyle,
        onChange: (e) => onChange({ ...v, model: e.target.value }),
      }, ...modelChildren),
      h('select', {
        'aria-label': label ? label + ' · ' + t('effortDefault') : t('effortDefault'),
        value: v.reasoningEffort || '',
        style: ctrlStyle,
        onChange: (e) => onChange({ ...v, reasoningEffort: e.target.value }),
      }, effortChoices.map(([val, text]) => h('option', { key: val || '__default', value: val }, text))),
    ),
    // 目录状态单独一行小字：放在 select 的 title 里在触屏上根本看不到。
    status
      ? h('div', {
        style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: 3 },
      }, status)
      : null,
  )
}

// ---- src/client/30-strategy.js ----
// 单条策略编辑器：触发条件（星期 + 峰时窗口）+ 主模型 + 副模型（峰时）。
// 视觉：整卡片边界 + 头部（序号 / 名称 / 删除）+ 分隔线 + 主模型 + 峰时子面板。
// 峰时子面板用左侧竖线做层级缩进；窄容器下所有控件整宽堆叠。

function StrategyEditor({ strategy, index, providers, models, modelsLoading, modelsError, onNeedModels, onChange, onRemove, t, narrow }) {
  const h = React.createElement
  const s = strategy
  const setPrimary = (primary) => onChange({ ...s, primary })
  const setPeak = (peak) => onChange({ ...s, peak })
  const peak = s.peak || { enabled: false, windows: [['09:00', '12:00'], ['14:00', '18:00']] }
  // 星期简称同样来自 lib/text.js（单一维护文件）。此前硬编码在客户端，导致英文
  // 界面仍显示「一…日」，且违反「所有界面文本只在 text.js 维护」的约定。
  const weekdayNames = weekdayLabels(t)

  const labelStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 }
  const inputStyle = { display: 'block', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }
  const timeStyle = { width: 56, boxSizing: 'border-box', textAlign: 'center' }

  return h('div', {
    style: {
      border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)',
      borderRadius: 10,
      padding: 12,
      marginBottom: 10,
      minWidth: 0,
      maxWidth: '100%',
      boxSizing: 'border-box',
    },
  },
    // 头部：序号 + 名称 + 删除。窄容器允许换行（宁可删除键换到下一行，也不把
    // 名称输入框压成一条缝）。
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: narrow ? 'wrap' : 'nowrap' } },
      h('span', {
        style: {
          flex: '0 0 auto',
          fontSize: 11,
          lineHeight: '18px',
          padding: '0 6px',
          borderRadius: 999,
          color: 'var(--dsw-alias-label-secondary, #666)',
          background: 'var(--dsw-alias-interactive-bg-hover, #f0f0f0)',
        },
      }, t('strategyLabel', { index: index + 1 })),
      h('input', {
        value: s.name || '',
        placeholder: t('strategyName'),
        'aria-label': t('strategyName'),
        onChange: (e) => onChange({ ...s, name: e.target.value }),
        style: { flex: '1 1 180px', minWidth: 0, boxSizing: 'border-box' },
      }),
      h('button', {
        onClick: onRemove,
        title: t('remove'),
        style: { flex: '0 0 auto', color: 'var(--dsw-alias-state-error-primary, #c00)' },
      }, t('remove')),
    ),
    h('input', {
      value: s.description || '',
      placeholder: t('strategyDescription'),
      'aria-label': t('strategyDescription'),
      onChange: (e) => onChange({ ...s, description: e.target.value }),
      style: { ...inputStyle, marginBottom: 10 },
    }),
    h('div', { style: labelStyle }, t('weekdays')),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 10 } },
      [1, 2, 3, 4, 5, 6, 7].map((d) => h('label', {
        key: d,
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, lineHeight: '20px', whiteSpace: 'nowrap' },
      },
        h('input', {
          type: 'checkbox',
          checked: (s.weekdays || []).includes(d),
          onChange: (e) => {
            const set = new Set(s.weekdays || [])
            if (e.target.checked) set.add(d); else set.delete(d)
            onChange({ ...s, weekdays: [...set].sort() })
          },
        }),
        h('span', null, weekdayNames[d - 1] || String(d)),
      )),
    ),
    h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, #efefef)', margin: '0 0 10px' } }),
    h(ModelPicker, {
      label: t('primaryModel'),
      value: s.primary || {},
      providers,
      models,
      modelsLoading: modelsLoading && modelsLoading[s.primary?.provider],
      modelsError: modelsError && modelsError[s.primary?.provider],
      onNeedModels,
      onChange: setPrimary,
      t,
      narrow,
    }),
    // 峰时开关：必须显式设字号，否则会继承宿主的基础字号，看起来像一级标题。
    h('label', {
      style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', marginTop: 10, cursor: 'pointer' },
    },
      h('input', {
        type: 'checkbox',
        checked: peak.enabled === true,
        onChange: (e) => setPeak({ ...peak, enabled: e.target.checked }),
      }),
      h('span', null, t('enablePeak')),
    ),
    peak.enabled
      ? h('div', {
        // 左侧竖线 + 缩进：把「峰时」表达成主模型的子层级，而不是又一个平级区块。
        style: {
          borderLeft: '2px solid var(--dsw-alias-border-l3, #d8d8d8)',
          paddingLeft: 10,
          marginTop: 8,
          minWidth: 0,
        },
      },
        h('div', { style: labelStyle }, t('peakWindows')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', marginBottom: 10 } },
          (peak.windows || []).map((w, i) => h('span', { key: i, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', {
              value: w[0] || '',
              placeholder: '09:00',
              'aria-label': t('windowStart'),
              onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [e.target.value, x[1]] : x) }),
              style: timeStyle,
            }),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } }, '–'),
            h('input', {
              value: w[1] || '',
              placeholder: '12:00',
              'aria-label': t('windowEnd'),
              onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [x[0], e.target.value] : x) }),
              style: timeStyle,
            }),
          )),
          h('button', {
            onClick: () => setPeak({ ...peak, windows: [...(peak.windows || []), ['09:00', '12:00']] }),
            title: t('peakWindows'),
            style: { padding: '2px 8px' },
          }, '+'),
        ),
        h(ModelPicker, {
          label: t('peakModel'),
          value: peak,
          providers,
          models,
          modelsLoading: modelsLoading && modelsLoading[peak.provider],
          modelsError: modelsError && modelsError[peak.provider],
          onNeedModels,
          onChange: setPeak,
          t,
          narrow,
        }),
      )
      : null,
  )
}

// ---- src/client/40-settings.js ----
// 设置页「避峰岗」区块：策略列表 + 高级模型支援。
// provider 与模型全部由 RPC 拉取后「选择」，不做手填。
// 加载顺序：get() → providers() → 配置里用到的 provider 的模型 → 其余 provider 的模型并行补齐。
// 任一 RPC 失败都降级显示（不白屏、目录失败也不影响保存）。

function pvErrorText(e) {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    try { return JSON.stringify(e) } catch (err) { return String(e) }
  }
  return e == null ? '' : String(e)
}

// 服务端丢弃策略时抛的是英文技术文案（见 lib/index.js 的 describeStrategyIssue）。
// 这里按当前语言重写，并保留「第几条策略」这一关键定位信息。
// 认不出来的一律原文照显，绝不把信息吞掉或误译。
function pvStrategyIssueText(issue, t) {
  if (/needs a primary provider and a primary model/i.test(issue)) return t('errNeedBoth')
  if (/needs a primary model/i.test(issue)) return t('errNeedModel')
  if (/needs a primary provider/i.test(issue)) return t('errNeedProvider')
  if (/is not a strategy object/i.test(issue)) return t('errBadStrategy')
  if (/invalid primary model/i.test(issue)) return t('errBadPrimary')
  return issue
}

function pvSaveErrorText(raw, t) {
  const text = pvErrorText(raw)
  if (!text) return ''
  if (/advanced model support/i.test(text)) return t('errAdvancedSupport')
  const parts = []
  const re = /strategy #(\d+)\s+([^;]+?)(?=\s+—|;|$)/g
  let match
  while ((match = re.exec(text)) !== null) {
    // 先从措辞里剥掉「(+N more)」，否则未知措辞会把它并进原文再追加一次计数。
    const issue = match[2].replace(/\s*\(\+\d+ more\)\s*$/, '').trim()
    parts.push(t('errStrategy', { index: match[1], issue: pvStrategyIssueText(issue, t) }))
  }
  if (parts.length === 0) return text
  const more = /\(\+(\d+) more\)/.exec(text)
  return parts.join(t('errSeparator')) + (more ? t('errMore', { count: more[1] }) : '')
}

// 配置里被引用到的 provider id（主模型 / 副模型 / 高级支援），用于优先拉取模型。
function pvUsedProviderIds(config) {
  const used = new Set()
  const add = (holder) => {
    const id = holder && holder.provider ? String(holder.provider) : ''
    if (id) used.add(id)
  }
  if (config && typeof config === 'object') {
    add(config.advancedSupport)
    add(config.exclusive)
    for (const s of Array.isArray(config.strategies) ? config.strategies : []) {
      add(s && s.primary)
      add(s && s.peak)
    }
  }
  return used
}

// 规范化 providers RPC 的返回：接受 { providers:[...] } 或裸数组，按 id 去重。
function pvNormalizeProviders(res) {
  const raw = res && Array.isArray(res.providers) ? res.providers : (Array.isArray(res) ? res : [])
  const seen = Object.create(null)
  const list = []
  for (const p of raw) {
    const id = p && (p.id || p.name) ? String(p.id || p.name) : ''
    if (!id || seen[id]) continue
    seen[id] = true
    list.push({ id, name: String((p && p.name) || id) })
  }
  return list
}

function PolicySettingsSection({ rpc, t }) {
  const h = React.createElement
  // 按「本区块自身容器宽度」判断宽窄：设置面板常比窗口窄（分屏、窄窗口），
  // 用窗口宽度会把三个下拉硬挤在一行。
  const [sectionRef, narrow] = useContainerWidth(640)
  const [config, setConfig] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [providers, setProviders] = useState([])
  const [providersError, setProvidersError] = useState('')
  const [models, setModels] = useState({})
  const [modelsLoading, setModelsLoading] = useState({})
  const [modelsError, setModelsError] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedAt, setSavedAt] = useState('')
  const requested = useRef({})

  // 拉取单个 provider 的模型：requested 去重；失败后清除标记以便重试。
  const fetchModels = useCallback(async (providerId) => {
    const id = providerId ? String(providerId) : ''
    if (!id || requested.current[id]) return
    requested.current[id] = true
    setModelsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const list = await rpc.models(id)
      setModels((prev) => ({ ...prev, [id]: Array.isArray(list) ? list : [] }))
      setModelsError((prev) => {
        if (!prev[id]) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (e) {
      requested.current[id] = false
      setModels((prev) => (Array.isArray(prev[id]) ? prev : { ...prev, [id]: [] }))
      setModelsError((prev) => ({ ...prev, [id]: pvErrorText(e) }))
    } finally {
      setModelsLoading((prev) => {
        if (!prev[id]) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }, [rpc])

  const loadProviders = useCallback(async () => {
    try {
      const res = await rpc.providers()
      const list = pvNormalizeProviders(res)
      setProviders(list)
      setProvidersError('')
      return list
    } catch (e) {
      setProviders([])
      setProvidersError(pvErrorText(e))
      return []
    }
  }, [rpc])

  const load = useCallback(async () => {
    setLoadError('')
    setSaveError('')
    setSavedAt('')
    setProvidersError('')
    setModelsError({})
    setModelsLoading({})
    requested.current = {}
    let res
    try {
      res = await rpc.get()
    } catch (e) {
      // get 失败：给出错误 + 重试，而不是白屏。
      setConfig(null)
      setLoadError(pvErrorText(e))
      return
    }
    const raw = res && res.config !== undefined ? res.config : res
    const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    setConfig(cfg)
    const used = [...pvUsedProviderIds(cfg)]
    const list = await loadProviders()
    // 1) 配置里用到的 provider 先并行拉模型；2) 其余 provider 随后并行补齐。
    await Promise.all(used.map((id) => fetchModels(id)))
    for (const p of list) {
      if (used.indexOf(p.id) < 0) fetchModels(p.id)
    }
  }, [rpc, loadProviders, fetchModels])

  useEffect(() => { load() }, [load])

  // 目录（providers / models）失败后的重试：不动已加载的配置。
  const reloadCatalog = useCallback(async () => {
    setProvidersError('')
    setModelsError({})
    const list = await loadProviders()
    const used = [...pvUsedProviderIds(config)]
    const ids = used.concat(list.map((p) => p.id).filter((id) => used.indexOf(id) < 0))
    await Promise.all(ids.map((id) => {
      requested.current[id] = false
      return fetchModels(id)
    }))
  }, [loadProviders, fetchModels, config])

  if (!config) {
    return h('div', { ref: sectionRef, style: { maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },
      h('div', { style: { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 8 } }, t('title')),
      loadError
        ? h('div', null,
          h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: 13, marginBottom: 4 } }, t('loadFailed')),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 8, wordBreak: 'break-word' } }, loadError),
          h('button', { onClick: () => { load() }, style: { fontWeight: 600 } }, t('retry')),
        )
        : h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #888)' } }, t('loading')),
    )
  }

  const strategies = Array.isArray(config.strategies) ? config.strategies : []
  const advancedSupport = config.advancedSupport || config.exclusive || {}

  // 任何编辑都清掉「已保存」与上一次的错误：成功提示只在表单内容仍等于
  // 已保存内容时才成立，否则会拿旧时间误导用户以为当前编辑已经存上了。
  const updateConfig = (next) => {
    setSavedAt('')
    setSaveError('')
    setConfig(next)
  }
  const updateStrategy = (i, next) => {
    const list = strategies.slice()
    list[i] = next
    updateConfig({ ...config, strategies: list })
  }
  const addStrategy = () => updateConfig({
    ...config,
    strategies: [...strategies, {
      name: '',
      description: '',
      weekdays: [1, 2, 3, 4, 5],
      primary: {},
      peak: { enabled: false, windows: [['09:00', '12:00'], ['14:00', '18:00']] },
    }],
  })
  const removeStrategy = (i) => updateConfig({ ...config, strategies: strategies.filter((_, j) => j !== i) })

  const save = async () => {
    setSaving(true)
    setSaveError('')
    setSavedAt('')
    try {
      const next = await rpc.set(config)
      const raw = next && next.config !== undefined ? next.config : next
      setConfig(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : config)
      // 明确的成功反馈：此前保存成功后界面毫无变化，用户无法区分「存上了」和「点了没反应」。
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setSaveError(pvErrorText(e))
    } finally {
      setSaving(false)
    }
  }

  // 目录降级提示：providers / 任一 provider 的 models 失败都只提示，不影响保存。
  const modelErrorIds = Object.keys(modelsError)
  const catalogDegraded = Boolean(providersError) || modelErrorIds.length > 0
  const catalogDetail = providersError || (modelErrorIds.length > 0 ? modelsError[modelErrorIds[0]] : '')

  return h('div', { ref: sectionRef, style: { maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },
    h('div', { style: { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 4 } }, t('title')),
    h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 12 } }, t('subtitle')),
    catalogDegraded ? h('div', {
      style: { border: '1px solid var(--dsw-alias-state-warn-primary, #e6c473)', background: 'var(--dsw-alias-bg-layer-1, #fff9e8)', borderRadius: 10, padding: 10, marginBottom: 12, maxWidth: '100%', boxSizing: 'border-box' },
    },
      h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('catalogUnavailable')),
      catalogDetail ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #a08447)', marginTop: 2, wordBreak: 'break-word' } }, catalogDetail) : null,
      h('button', { onClick: () => { reloadCatalog() }, style: { marginTop: 8 } }, t('retry')),
    ) : null,
    strategies.map((s, i) => h(StrategyEditor, {
      key: i,
      index: i,
      strategy: s,
      providers,
      models,
      modelsLoading,
      modelsError,
      onNeedModels: fetchModels,
      onChange: (next) => updateStrategy(i, next),
      onRemove: () => removeStrategy(i),
      t,
      narrow,
    })),
    // 整宽虚线按钮：把「添加」表达成一个可点击的插槽，而不是和保存按钮同级的实心按钮。
    h('button', {
      onClick: addStrategy,
      style: {
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        marginBottom: 12,
        border: '1px dashed var(--dsw-alias-border-l3, #ccc)',
        borderRadius: 10,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #666)',
        fontSize: 13,
        lineHeight: '20px',
        cursor: 'pointer',
      },
    }, t('addStrategy')),
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },
      h('div', { style: { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 2 } }, t('advancedSupportTitle')),
      h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 10 } }, t('advancedSupportHint')),
      h(ModelPicker, {
        label: t('advancedSupportModel'),
        value: advancedSupport,
        providers,
        models,
        modelsLoading: modelsLoading[advancedSupport.provider],
        modelsError: modelsError[advancedSupport.provider],
        onNeedModels: fetchModels,
        onChange: (next) => updateConfig({ ...config, advancedSupport: next }),
        t,
        narrow,
      }),
    ),
    // 保存按钮与状态行同一行：状态紧贴动作，不需要在页面上找。
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('button', { onClick: save, disabled: saving, style: { fontWeight: 600 } }, saving ? t('saving') : t('save')),
      saveError
        ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: 12, lineHeight: '18px', minWidth: 0, wordBreak: 'break-word' } }, t('saveFailed', { detail: pvSaveErrorText(saveError, t) }))
        : (savedAt
          // DSH 没有 success 语义 token（只有 business/error/warn），所以用已验证存在的
          // label-secondary 做中性状态行，不发明不存在的 token。
          ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 12, lineHeight: '18px' } }, t('saved', { time: savedAt }))
          : null),
    ),
  )
}

// ---- src/client/90-apply.js ----
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


return module.exports;
} });
