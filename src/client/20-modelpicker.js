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
