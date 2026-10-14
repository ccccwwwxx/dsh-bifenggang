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
