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
