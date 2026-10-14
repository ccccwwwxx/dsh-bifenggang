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
