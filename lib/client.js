window.__ModuleLoader__.load({ id: "dsh-peak-valley-router", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require("react");
const { useState, useEffect, useCallback } = require("react");

const NS = 'settings.peakValley'

const inject = ['slots', 'connection', 'locale']

const WEEKDAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日']

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
  }
}

function ModelPicker({ label, value, providers, models, onChange, t }) {
  const h = React.createElement
  const providerOptions = (providers || []).map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id))
  const modelOptions = (models?.[value.provider] || []).map((m) => h('option', { key: m.id, value: m.id }, m.name || m.id))
  return h('div', { style: { margin: '4px 0' } },
    h('label', { style: { display: 'block', fontSize: '12px', color: '#888' } }, label),
    h('select', {
      value: value.provider || '',
      onChange: (e) => onChange({ ...value, provider: e.target.value, model: '' }),
      style: { marginRight: 6 },
    }, h('option', { value: '' }, t('pickProvider')), ...providerOptions),
    h('select', {
      value: value.model || '',
      onChange: (e) => onChange({ ...value, model: e.target.value }),
    }, h('option', { value: '' }, t('pickModel')), ...modelOptions),
    h('select', {
      value: value.reasoningEffort || '',
      onChange: (e) => onChange({ ...value, reasoningEffort: e.target.value }),
      style: { marginLeft: 6 },
    }, ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => h('option', { key: e, value: e }, e))),
  )
}

function StrategyEditor({ strategy, providers, models, onChange, onRemove, t }) {
  const h = React.createElement
  const s = strategy
  const setPrimary = (primary) => onChange({ ...s, primary })
  const setPeak = (peak) => onChange({ ...s, peak })
  const peak = s.peak || { enabled: false, windows: [['09:00', '12:00'], ['14:00', '18:00']] }
  return h('div', { style: { border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 10 } },
    h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
      h('input', {
        value: s.name || '',
        placeholder: t('strategyName'),
        onChange: (e) => onChange({ ...s, name: e.target.value }),
        style: { flex: 1 },
      }),
      h('button', { onClick: onRemove, style: { color: '#c00' } }, t('remove')),
    ),
    h('input', {
      value: s.description || '',
      placeholder: t('strategyDescription'),
      onChange: (e) => onChange({ ...s, description: e.target.value }),
      style: { width: '100%', marginBottom: 6 },
    }),
    h('div', { style: { marginBottom: 6 } },
      h('span', { style: { fontSize: '12px', color: '#888', marginRight: 6 } }, t('weekdays')),
      [1, 2, 3, 4, 5, 6, 7].map((d) => h('label', { key: d, style: { marginRight: 6 } },
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
    h(ModelPicker, { label: t('primaryModel'), value: s.primary || {}, providers, models, onChange: setPrimary, t }),
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
        (peak.windows || []).map((w, i) => h('span', { key: i, style: { marginRight: 6 } },
          h('input', { value: w[0] || '', placeholder: '09:00', onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [e.target.value, x[1]] : x) }), style: { width: 52 } }),
          h('span', null, '–'),
          h('input', { value: w[1] || '', placeholder: '12:00', onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [x[0], e.target.value] : x) }), style: { width: 52 } }),
        )),
        h('button', { onClick: () => setPeak({ ...peak, windows: [...(peak.windows || []), ['09:00', '12:00']] }), style: { marginLeft: 6 } }, '+'),
      ),
      h(ModelPicker, { label: t('peakModel'), value: peak, providers, models, onChange: setPeak, t }),
    ) : null,
  )
}

function PolicySettingsSection({ rpc, t }) {
  const h = React.createElement
  const [config, setConfig] = useState(null)
  const [providers, setProviders] = useState([])
  const [models, setModels] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const cfg = await rpc.get()
      setConfig(cfg || {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    try {
      const prov = await rpc.providers()
      setProviders(prov?.providers || [])
      setModels(prov?.models || {})
    } catch (e) {
      /* providers are optional; keep the UI usable without them */
    }
  }, [rpc])

  useEffect(() => { load() }, [load])

  if (!config) return h('div', { style: { padding: 12 } },
    error ? h('div', { style: { color: '#c00' } }, error) : t('loading'))

  const strategies = config.strategies || []
  const exclusive = config.exclusive || {}

  const updateStrategy = (i, next) => {
    const list = strategies.slice()
    list[i] = next
    setConfig({ ...config, strategies: list })
  }
  const addStrategy = () => setConfig({
    ...config,
    strategies: [...strategies, { name: '', description: '', weekdays: [1, 2, 3, 4, 5], primary: {}, peak: { enabled: false, windows: [['09:00', '12:00'], ['14:00', '18:00']] } }],
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

  return h('div', { style: { padding: 12 } },
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
    })),
    h('button', { onClick: addStrategy, style: { marginBottom: 12 } }, t('addStrategy')),
    h('div', { style: { border: '1px dashed #bbb', borderRadius: 8, padding: 10, marginBottom: 12 } },
      h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: 4 } }, t('exclusiveTitle')),
      h('div', { style: { fontSize: '12px', color: '#888', marginBottom: 6 } }, t('exclusiveHint')),
      h(ModelPicker, { label: t('exclusiveModel'), value: exclusive, providers, models, onChange: (next) => setConfig({ ...config, exclusive: next }), t }),
    ),
    error ? h('div', { style: { color: '#c00', fontSize: '12px', marginBottom: 8 } }, error) : null,
    h('button', { onClick: save, disabled: saving, style: { fontWeight: 600 } }, saving ? t('saving') : t('save')),
  )
}

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-peak-valley-router: copy dictionaries')
  const connection = ctx.get('connection')
  const t = ctx.locale.bind(NS)
  const injected = () => ({ rpc: rpc(connection), t })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'peak-valley-router',
    order: 95,
    label: () => t('nav'),
    inject: injected,
  }, PolicySettingsSection))
}

const zh = {
  nav: '避峰岗',
  title: '模型协同策略（避峰岗）',
  subtitle: '按时间自动路由：命中某条策略就用它的主模型（峰时可选副模型）；全部未命中则走互斥策略。',
  loading: '加载中…',
  pickProvider: '选择 API',
  pickModel: '选择模型',
  strategyName: '策略名称',
  strategyDescription: '触发条件描述',
  weekdays: '生效星期',
  primaryModel: '主模型（谷时）',
  enablePeak: '启用峰谷（峰时用副模型）',
  peakWindows: '峰时窗口',
  peakModel: '副模型（峰时）',
  addStrategy: '+ 添加策略',
  exclusiveTitle: '互斥策略（兜底）',
  exclusiveHint: '当所有策略都未命中时使用；设置了策略后必填。',
  exclusiveModel: '互斥模型',
  remove: '删除',
  save: '保存',
  saving: '保存中…',
}

const en = {
  nav: 'Peak Routing',
  title: 'Model Routing Policy (Peak Avoidance)',
  subtitle: 'Time-based routing: a matching strategy uses its primary model (optional peak secondary); otherwise the exclusive fallback applies.',
  loading: 'Loading…',
  pickProvider: 'Pick API',
  pickModel: 'Pick model',
  strategyName: 'Strategy name',
  strategyDescription: 'Trigger condition description',
  weekdays: 'Active weekdays',
  primaryModel: 'Primary model (off-peak)',
  enablePeak: 'Enable peak (use secondary during peak)',
  peakWindows: 'Peak windows',
  peakModel: 'Secondary model (peak)',
  addStrategy: '+ Add strategy',
  exclusiveTitle: 'Exclusive strategy (fallback)',
  exclusiveHint: 'Used when no strategy matches; required once strategies are set.',
  exclusiveModel: 'Exclusive model',
  remove: 'Remove',
  save: 'Save',
  saving: 'Saving…',
}

exports.apply = apply;
exports.inject = inject;
return module.exports;
} });
