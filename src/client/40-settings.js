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
  const narrow = useIsNarrow()
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
    return h('div', { style: { padding: narrow ? 8 : 12, maxWidth: '100%', boxSizing: 'border-box' } },
      h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: 8 } }, t('title')),
      loadError
        ? h('div', null,
          h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: '13px', marginBottom: 4 } }, t('loadFailed')),
          h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 8, wordBreak: 'break-word' } }, loadError),
          h('button', { onClick: () => { load() }, style: { fontWeight: 600 } }, t('retry')),
        )
        : h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, t('loading')),
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

  return h('div', { style: { padding: narrow ? 8 : 12, maxWidth: '100%', boxSizing: 'border-box' } },
    h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: 8 } }, t('title')),
    h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 12 } }, t('subtitle')),
    catalogDegraded ? h('div', {
      style: { border: '1px solid var(--dsw-alias-state-warn-primary, #e6c473)', background: 'var(--dsw-alias-bg-layer-1, #fff9e8)', borderRadius: 8, padding: 8, marginBottom: 10, maxWidth: '100%', boxSizing: 'border-box' },
    },
      h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('catalogUnavailable')),
      catalogDetail ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a08447)', marginTop: 2, wordBreak: 'break-word' } }, catalogDetail) : null,
      h('button', { onClick: () => { reloadCatalog() }, style: { marginTop: 6 } }, t('retry')),
    ) : null,
    strategies.map((s, i) => h(StrategyEditor, {
      key: i,
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
    h('button', { onClick: addStrategy, style: { marginBottom: 12 } }, t('addStrategy')),
    h('div', { style: { border: '1px dashed var(--dsw-alias-border-l3, #bbb)', borderRadius: 8, padding: 10, marginBottom: 12, maxWidth: '100%', boxSizing: 'border-box' } },
      h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: 4 } }, t('advancedSupportTitle')),
      h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 6 } }, t('advancedSupportHint')),
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
    saveError
      ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: '12px', marginBottom: 8, wordBreak: 'break-word' } }, t('saveFailed', { detail: pvSaveErrorText(saveError, t) }))
      : (savedAt
        // DSH 没有 success 语义 token（只有 business/error/warn），所以用已验证存在的
        // label-secondary 做中性状态行，不发明不存在的 token。
        ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #555)', fontSize: '12px', marginBottom: 8 } }, t('saved', { time: savedAt }))
        : null),
    h('button', { onClick: save, disabled: saving, style: { fontWeight: 600 } }, saving ? t('saving') : t('save')),
  )
}
