// Provider + 模型选择器。
// 约定：provider 下拉把全部已注册 provider（API 与订阅套餐）并列展示；
// 模型一律「下拉选择」，选项由 40-settings.js 通过 models RPC 拉取后传入（models[providerId]）。
// 降级：providers / 模型拉取失败时下拉仍然可用（可能为空），不阻塞保存。
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
//   t / narrow     — 文案函数 / 是否窄屏

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

  // 窄屏：三个控件全宽堆叠；宽屏：同一行等宽伸缩，禁止横向溢出。
  const rowStyle = narrow
    ? { margin: '4px 0' }
    : { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', margin: '4px 0' }
  const ctrlStyle = narrow
    ? { display: 'block', width: '100%', maxWidth: '100%', boxSizing: 'border-box', marginBottom: 6 }
    : { flex: '1 1 0', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' }

  return h('div', null,
    label ? h('label', { style: { display: 'block', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', marginTop: 4 } }, label) : null,
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
        title: failed || v.model || '',
        value: v.model || '',
        style: ctrlStyle,
        onChange: (e) => onChange({ ...v, model: e.target.value }),
      }, ...modelChildren),
      h('select', {
        'aria-label': label ? label + ' · ' + t('effortDefault') : t('effortDefault'),
        value: v.reasoningEffort || '',
        style: ctrlStyle,
        onChange: (e) => onChange({ ...v, reasoningEffort: e.target.value }),
      }, ['', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) =>
        h('option', { key: e || 'default', value: e }, e || t('effortDefault')))),
    ),
  )
}
