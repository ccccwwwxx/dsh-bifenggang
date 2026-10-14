// 单条策略编辑器：触发条件（星期 + 峰时窗口）+ 主模型 + 副模型（峰时）。
// 窄屏下所有控件整宽堆叠且折行，宽屏保持一行。

function StrategyEditor({ strategy, providers, models, modelsLoading, modelsError, onNeedModels, onChange, onRemove, t, narrow }) {
  const h = React.createElement
  const s = strategy
  const setPrimary = (primary) => onChange({ ...s, primary })
  const setPeak = (peak) => onChange({ ...s, peak })
  const peak = s.peak || { enabled: false, windows: [['09:00', '12:00'], ['14:00', '18:00']] }
  // 星期简称同样来自 lib/text.js（单一维护文件）。此前硬编码在客户端，导致英文
  // 界面仍显示「一…日」。key 缺失时退回数字，避免把 key 名当文案显示出来。
  const weekdayNames = String(t('weekdayShort') ?? '').split(',')

  const nameRow = narrow
    ? { marginBottom: 6 }
    : { display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }
  const nameInput = narrow
    ? { display: 'block', width: '100%', maxWidth: '100%', boxSizing: 'border-box', marginBottom: 4 }
    : { flex: '1 1 auto', minWidth: 0 }
  const fullInput = { display: 'block', width: '100%', maxWidth: '100%', boxSizing: 'border-box', marginBottom: 6 }
  const wrapRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6 }

  return h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #ddd)', borderRadius: 8, padding: 10, marginBottom: 10, overflow: 'hidden' } },
    h('div', { style: nameRow },
      h('input', {
        value: s.name || '',
        placeholder: t('strategyName'),
        onChange: (e) => onChange({ ...s, name: e.target.value }),
        style: nameInput,
      }),
      h('button', {
        onClick: onRemove,
        style: narrow
          ? { display: 'block', width: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-state-error-primary, #c00)' }
          : { flex: '0 0 auto', color: 'var(--dsw-alias-state-error-primary, #c00)' },
      }, t('remove')),
    ),
    h('input', {
      value: s.description || '',
      placeholder: t('strategyDescription'),
      onChange: (e) => onChange({ ...s, description: e.target.value }),
      style: fullInput,
    }),
    h('div', { style: wrapRow },
      h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', width: narrow ? '100%' : 'auto', marginRight: narrow ? 0 : 6 } }, t('weekdays')),
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
        h('span', null, weekdayNames[d - 1] || String(d)),
      )),
    ),
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
    h('label', { style: { display: 'block', margin: '6px 0' } },
      h('input', {
        type: 'checkbox',
        checked: peak.enabled === true,
        onChange: (e) => setPeak({ ...peak, enabled: e.target.checked }),
      }),
      h('span', null, t('enablePeak')),
    ),
    peak.enabled ? h('div', null,
      h('div', { style: { ...wrapRow, marginBottom: 4 } },
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', width: narrow ? '100%' : 'auto', marginRight: narrow ? 0 : 6 } }, t('peakWindows')),
        (peak.windows || []).map((w, i) => h('span', { key: i, style: { marginRight: 6, whiteSpace: 'nowrap' } },
          h('input', { value: w[0] || '', placeholder: '09:00', onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [e.target.value, x[1]] : x) }), style: { width: 52, boxSizing: 'border-box' } }),
          h('span', null, '–'),
          h('input', { value: w[1] || '', placeholder: '12:00', onChange: (e) => setPeak({ ...peak, windows: (peak.windows || []).map((x, j) => j === i ? [x[0], e.target.value] : x) }), style: { width: 52, boxSizing: 'border-box' } }),
        )),
        h('button', { onClick: () => setPeak({ ...peak, windows: [...(peak.windows || []), ['09:00', '12:00']] }) }, '+'),
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
    ) : null,
  )
}
