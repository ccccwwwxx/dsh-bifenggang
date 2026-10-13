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
