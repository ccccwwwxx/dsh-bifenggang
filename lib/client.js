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
  "saving": "保存中…"
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
  "saving": "Saving…"
}

// ---- src/client/00-shared.js ----
// 共享常量与 RPC 封装。所有 client 端模块共用。

const NS = 'settings.peakValley'

const inject = ['slots', 'connection', 'locale']

const WEEKDAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日']

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

// 轻量响应式：视口宽度 <= 720px 视为窄屏（移动端 / 远程连接）。
function useIsNarrow() {
  const read = () => (typeof window === 'undefined' ? false : window.innerWidth <= 720)
  const [narrow, setNarrow] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setNarrow(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}

// ---- src/client/10-toggle.js ----
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

// ---- src/client/20-modelpicker.js ----
// Provider + 模型选择器。
// 约定：provider 下拉列出全部已注册 provider（API 与订阅套餐并列）；
// 模型必须是「选择」而非手填 —— 由 40-settings.js 通过 models RPC 拉取后传入。

function ModelPicker({ label, value, providers, models, onChange, t, narrow }) {
  const h = React.createElement
  const providerList = providers || []
  const providerOptions = providerList.map((p) =>
    h('option', { key: p.id, value: p.id }, p.name || p.id))
  const modelList = models?.[value.provider] || []
  const knownModel = modelList.some((m) => m.id === value.model)
  const modelOptions = modelList.map((m) =>
    h('option', { key: m.id, value: m.id }, m.name || m.id))
  const selectStyle = narrow ? { width: '100%', marginBottom: 4 } : { marginRight: 6 }

  return h('div', { style: { margin: '4px 0' } },
    h('label', { style: { display: 'block', fontSize: '12px', color: '#888' } }, label),
    h('select', {
      value: value.provider || '',
      onChange: (e) => onChange({ ...value, provider: e.target.value, model: '' }),
      style: selectStyle,
    }, h('option', { value: '' }, t('pickProvider')), ...providerOptions),
    h('select', {
      value: value.model || '',
      onChange: (e) => onChange({ ...value, model: e.target.value }),
      style: selectStyle,
    },
      h('option', { value: '' }, t('pickModel')),
      // 当前值不在目录里时保留一项，避免选择器显示为空。
      value.model && !knownModel ? h('option', { key: value.model, value: value.model }, value.model) : null,
      ...modelOptions,
    ),
    h('select', {
      value: value.reasoningEffort || '',
      onChange: (e) => onChange({ ...value, reasoningEffort: e.target.value }),
      style: selectStyle,
    }, ['', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) =>
      h('option', { key: e || 'default', value: e }, e || t('effortDefault')))),
  )
}

// ---- src/client/30-strategy.js ----
// 单条策略编辑器：触发条件（星期 + 峰时窗口）+ 主模型 + 副模型（峰时）。

function StrategyEditor({ strategy, providers, models, onChange, onRemove, t, narrow }) {
  const h = React.createElement
  const s = strategy
  const setPrimary = (primary) => onChange({ ...s, primary })
  const setPeak = (peak) => onChange({ ...s, peak })
  const peak = s.peak || { enabled: false, windows: [['09:00', '12:00'], ['14:00', '18:00']] }
  const row = narrow ? { marginBottom: 6 } : { display: 'flex', gap: 6, marginBottom: 6 }

  return h('div', { style: { border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 10 } },
    h('div', { style: row },
      h('input', {
        value: s.name || '',
        placeholder: t('strategyName'),
        onChange: (e) => onChange({ ...s, name: e.target.value }),
        style: narrow ? { width: '100%', marginBottom: 4 } : { flex: 1 },
      }),
      h('button', { onClick: onRemove, style: { color: '#c00' } }, t('remove')),
    ),
    h('input', {
      value: s.description || '',
      placeholder: t('strategyDescription'),
      onChange: (e) => onChange({ ...s, description: e.target.value }),
      style: { width: '100%', marginBottom: 6, boxSizing: 'border-box' },
    }),
    h('div', { style: { marginBottom: 6 } },
      h('span', { style: { fontSize: '12px', color: '#888', marginRight: 6 } }, t('weekdays')),
      [1, 2, 3, 4, 5, 6, 7].map((d) => h('label', { key: d, style: { marginRight: 6, whiteSpace: 'nowrap' } },
        h('input', {
          type: 'checkbox',
          checked: (s.weekdays || []).includes(d),
          onChange: (e) => {
            const set = new Set(s.weekdays || [])
            if (e.target.checked) set.add(d); else set.delete(d)
            onChange({ ...s, weekdays: [...set].sort() })
          },
        }),
        h('span', null, WEEKDAY_NAMES[d]),
      )),
    ),
    h(ModelPicker, { label: t('primaryModel'), value: s.primary || {}, providers, models, onChange: setPrimary, t, narrow }),
    h('label', { style: { display: 'block', margin: '6px 0' } },
      h('input', {
        type: 'checkbox',
        checked: peak.enabled === true,
        onChange: (e) => setPeak({ ...peak, enabled: e.target.checked }),
      }),
      h('span', null, t('enablePeak')),
    ),
    peak.enabled ? h('div', null,
      h('div', { style: { marginBottom: 4 } },
        h('span', { style: { fontSize: '12px', color: '#888', marginRight: 6 } }, t('peakWindows')),
        (peak.windows || []).map((w, i) => h('span', { key: i, style: { marginRight: 6, whiteSpace: 'nowrap' } },
          h('input', { value: w[0] || '', placeholder: '09:00', onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [e.target.value, x[1]] : x) }), style: { width: 52 } }),
          h('span', null, '–'),
          h('input', { value: w[1] || '', placeholder: '12:00', onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [x[0], e.target.value] : x) }), style: { width: 52 } }),
        )),
        h('button', { onClick: () => setPeak({ ...peak, windows: [...(peak.windows || []), ['09:00', '12:00']] }), style: { marginLeft: 6 } }, '+'),
      ),
      h(ModelPicker, { label: t('peakModel'), value: peak, providers, models, onChange: setPeak, t, narrow }),
    ) : null,
  )
}

// ---- src/client/40-settings.js ----
// 设置页「避峰岗」区块：策略列表 + 高级模型支援。
// provider 与模型全部由 RPC 拉取后「选择」，不做手填。

function PolicySettingsSection({ rpc, t }) {
  const h = React.createElement
  const narrow = useIsNarrow()
  const [config, setConfig] = useState(null)
  const [providers, setProviders] = useState([])
  const [models, setModels] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const requested = useRef({})

  const fetchModels = useCallback(async (providerId) => {
    if (!providerId || requested.current[providerId]) return
    requested.current[providerId] = true
    try {
      const list = await rpc.models(providerId)
      setModels((prev) => ({ ...prev, [providerId]: Array.isArray(list) ? list : [] }))
    } catch (e) {
      requested.current[providerId] = false
      setModels((prev) => ({ ...prev, [providerId]: [] }))
    }
  }, [rpc])

  const load = useCallback(async () => {
    try {
      const res = await rpc.get()
      const cfg = res?.config || res || {}
      setConfig(cfg)
      const used = new Set([cfg.advancedSupport?.provider, cfg.exclusive?.provider])
      for (const s of cfg.strategies || []) {
        used.add(s?.primary?.provider)
        used.add(s?.peak?.provider)
      }
      for (const id of used) fetchModels(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    try {
      const prov = await rpc.providers()
      const list = prov?.providers || []
      setProviders(list)
      for (const p of list) fetchModels(p.id)
    } catch (e) {
      /* providers 拉不到时保持界面可用 */
    }
  }, [rpc, fetchModels])

  useEffect(() => { load() }, [load])

  if (!config) {
    return h('div', { style: { padding: 12 } },
      error ? h('div', { style: { color: '#c00' } }, error) : t('loading'))
  }

  const strategies = config.strategies || []
  const advancedSupport = config.advancedSupport || config.exclusive || {}

  const updateStrategy = (i, next) => {
    const list = strategies.slice()
    list[i] = next
    setConfig({ ...config, strategies: list })
  }
  const addStrategy = () => setConfig({
    ...config,
    strategies: [...strategies, {
      name: '',
      description: '',
      weekdays: [1, 2, 3, 4, 5],
      primary: {},
      peak: { enabled: false, windows: [['09:00', '12:00'], ['14:00', '18:00']] },
    }],
  })
  const removeStrategy = (i) => setConfig({ ...config, strategies: strategies.filter((_, j) => j !== i) })

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const next = await rpc.set(config)
      setConfig(next || config)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return h('div', { style: { padding: narrow ? 8 : 12 } },
    h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: 8 } }, t('title')),
    h('div', { style: { fontSize: '12px', color: '#888', marginBottom: 12 } }, t('subtitle')),
    strategies.map((s, i) => h(StrategyEditor, {
      key: i,
      strategy: s,
      providers,
      models,
      onChange: (next) => updateStrategy(i, next),
      onRemove: () => removeStrategy(i),
      t,
      narrow,
    })),
    h('button', { onClick: addStrategy, style: { marginBottom: 12 } }, t('addStrategy')),
    h('div', { style: { border: '1px dashed #bbb', borderRadius: 8, padding: 10, marginBottom: 12 } },
      h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: 4 } }, t('advancedSupportTitle')),
      h('div', { style: { fontSize: '12px', color: '#888', marginBottom: 6 } }, t('advancedSupportHint')),
      h(ModelPicker, {
        label: t('advancedSupportModel'),
        value: advancedSupport,
        providers,
        models,
        onChange: (next) => setConfig({ ...config, advancedSupport: next }),
        t,
        narrow,
      }),
    ),
    error ? h('div', { style: { color: '#c00', fontSize: '12px', marginBottom: 8 } }, error) : null,
    h('button', { onClick: save, disabled: saving, style: { fontWeight: 600 } }, saving ? t('saving') : t('save')),
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
