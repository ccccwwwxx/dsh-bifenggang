// 三档模型卡片之一（低 / 中 / 高）+ 该档的峰谷表编辑器。
//
// 组件名沿用 `StrategyEditor`：scripts/catalog-refresh.test.mjs 只加载 40-settings.js
// 并把这个名字注册成 stub 组件，它断言「刷新目录不会重载草稿」时依赖该名字被渲染。
// 改名会让那条断言失配（该测试不在本任务的写域内），所以这里保留名字、按设计文档
// §7.1 重做成「档位卡片」（语义仍是「一条策略」：谷时目标 + 峰时子表）。
//
// 布局：
//   档位标题
//   中/高档：[x] 跟随低档（勾选时只读展示继承值）
//   谷时模型  [provider][model][effort]
//   [x] 成本决策（关闭时峰时子区置灰但保留数据）
//   [x] 启用峰时  星期[一..日]  窗口[09:00–12:00][+]
//   峰时模型  [provider][model][effort]
//
// props:
//   tier        — 'low' | 'mid' | 'high'
//   target      — canonical 档位对象 { valley, costRouting, peak } 或 { share: 'low' }
//   effective   — 解析后的档位对象（共享时 = low；只读展示用）
//   shared      — 是否为「跟随低档」
//   providers / models / modelsLoading / modelsError / onNeedModels
//   onChange(next)      — 提交整个档位对象（父级负责写回 config.targets[tier]）
//   onShareChange(bool) — 勾选/取消「跟随低档」
//   t / narrow

// 星期多选（1=周一 … 7=周日）。标签来自 lib/text.js 的 weekdayShort。
function WeekdayPicker(props) {
  const h = React.createElement
  const { value, onChange, t, disabled } = props
  const names = weekdayLabels(t)
  const picked = Array.isArray(value) ? value : []
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 10, opacity: disabled ? 0.6 : 1 } },
    [1, 2, 3, 4, 5, 6, 7].map((d) => h('label', {
      key: d,
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, lineHeight: '20px', whiteSpace: 'nowrap' },
    },
      h('input', {
        type: 'checkbox',
        checked: picked.includes(d),
        disabled: disabled === true,
        onChange: (e) => {
          const set = new Set(picked)
          if (e.target.checked) set.add(d)
          else set.delete(d)
          onChange([...set].sort((a, b) => a - b))
        },
      }),
      h('span', null, names[d - 1] || String(d)),
    )),
  )
}

// 峰时窗口编辑：一行一个 [start, end]，开始含、结束不含；不支持跨午夜。
// 合法性与服务端一致（start < end），非法行就地提示，不静默丢数据。
function WindowEditor(props) {
  const h = React.createElement
  const { windows, onChange, t, disabled } = props
  const list = Array.isArray(windows) ? windows : []
  const timeStyle = { width: 104, boxSizing: 'border-box' }
  const invalid = windowsInvalid(list)
  return h('div', { style: { minWidth: 0 } },
    h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 } }, t('peakWindowsTitle')),
    list.length === 0
      ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #999)', marginBottom: 6 } }, t('peakWindowsEmpty'))
      : null,
    list.map((w, i) => h('div', {
      key: i,
      style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6, opacity: disabled ? 0.6 : 1 },
    },
      h('input', {
        type: 'time',
        step: 60,
        value: w && w[0] ? String(w[0]) : '',
        'aria-label': t('peakWindowStart'),
        disabled: disabled === true,
        onChange: (e) => onChange(list.map((x, j) => (j === i ? [e.target.value, x[1]] : x))),
        style: timeStyle,
      }),
      h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } }, '-'),
      h('input', {
        type: 'time',
        step: 60,
        value: w && w[1] ? String(w[1]) : '',
        'aria-label': t('peakWindowEnd'),
        disabled: disabled === true,
        onChange: (e) => onChange(list.map((x, j) => (j === i ? [x[0], e.target.value] : x))),
        style: timeStyle,
      }),
      h('button', {
        onClick: () => onChange(list.filter((_, j) => j !== i)),
        disabled: disabled === true,
        title: t('remove'),
        style: { padding: '2px 8px' },
      }, t('remove')),
    )),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('button', {
        onClick: () => onChange([...list, ['09:00', '12:00']]),
        disabled: disabled === true,
        style: { padding: '2px 8px' },
      }, t('peakWindowAdd')),
      invalid
        ? h('span', { role: 'alert', style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary, #c00)' } }, t('peakWindowInvalid'))
        : null,
    ),
  )
}

// 窗口是否全部合法（HH:MM 且 start < end）。供卡片与保存前校验共用。
function windowsInvalid(windows) {
  const list = Array.isArray(windows) ? windows : []
  return list.some((w) => {
    if (!Array.isArray(w) || w.length < 2) return true
    const start = String(w[0] || '')
    const end = String(w[1] || '')
    if (!timeValid(start) || !timeValid(end)) return true
    return minutesOfTime(start) >= minutesOfTime(end)
  })
}

function timeValid(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))
}

function minutesOfTime(value) {
  const [h, m] = String(value).split(':').map((n) => Number(n))
  return h * 60 + m
}

// 只读摘要：共享档位时把继承到的峰谷表说清楚（不让用户以为「跟随」= 没配置）。
function InheritedPeakSummary({ t, effective }) {
  const h = React.createElement
  const peak = effective && effective.peak ? effective.peak : {}
  const windows = Array.isArray(peak.windows) ? peak.windows : []
  const windowsText = windows.length === 0
    ? t('peakWindowsEmpty')
    : windows.map((w) => `${w[0]}-${w[1]}`).join(', ')
  return h('div', {
    style: {
      borderLeft: '2px solid var(--dsw-alias-border-l3, #d8d8d8)',
      paddingLeft: 10,
      marginTop: 8,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, #666)',
      minWidth: 0,
    },
  },
    h('div', null, t('valleyModel') + ': ' + tripleText(effective && effective.valley)),
    h('div', null, t('costRoutingLabel') + ': ' + (effective && effective.costRouting === false ? t('off') : t('on'))),
    h('div', null, (peak.enabled === true ? t('peakEnabledOn') : t('peakEnabledOff')) + ': ' + (peak.provider || peak.model ? tripleText(peak) : t('reasonNone'))),
    h('div', { style: { wordBreak: 'break-word' } }, t('peakWindowsTitle') + ': ' + windowsText),
  )
}

function tripleText(triple) {
  const value = triple && typeof triple === 'object' ? triple : {}
  const provider = value.provider ? String(value.provider) : ''
  const model = value.model ? String(value.model) : ''
  if (!provider && !model) return '-'
  return `${provider}/${model}${value.reasoningEffort ? '@' + value.reasoningEffort : ''}`
}

function StrategyEditor(props) {
  const h = React.createElement
  const {
    tier, target, effective, shared, providers, models, modelsLoading, modelsError,
    onNeedModels, onChange, onShareChange, t, narrow,
  } = props
  const current = target && typeof target === 'object' ? target : {}
  const shown = shared ? (effective || {}) : current
  const valley = shown.valley || {}
  const peak = shown.peak || {}
  const costRouting = shown.costRouting !== false
  const peakEnabled = peak.enabled === true

  const labelStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 }
  const cardStyle = {
    border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
  }
  const setValley = (next) => onChange({ ...current, valley: next })
  const setPeak = (patch) => onChange({ ...current, peak: { ...peak, ...patch } })

  return h('div', { style: cardStyle, 'data-tier': tier },
    h('div', { style: { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 8 } }, t(tierLabelKey(tier))),

    tier !== 'low'
      ? h('div', { style: { marginBottom: 10 } },
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: shared === true,
            onChange: (e) => onShareChange(e.target.checked),
          }),
          h('span', null, t('shareLow')),
        ),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: 2 } }, t('shareLowHint')),
        shared ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: 2 } }, t('shareLowInherited')) : null,
      )
      : null,

    shared
      ? h(InheritedPeakSummary, { effective, t })
      : h('div', { style: { minWidth: 0 } },
        h(ModelPicker, {
          label: t('valleyModel'),
          value: valley,
          providers,
          models,
          modelsLoading: modelsLoading && modelsLoading[valley.provider],
          modelsError: modelsError && modelsError[valley.provider],
          onNeedModels,
          onChange: setValley,
          t,
          narrow,
        }),

        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', marginTop: 10, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: costRouting,
            onChange: (e) => onChange({ ...current, costRouting: e.target.checked }),
          }),
          h('span', null, t('costRoutingLabel')),
        ),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', margin: '2px 0 0' } }, t('costRoutingHint')),

        // 峰时子区：成本决策关闭时整体置灰但保留数据（设计 §7.2），不删窗口。
        h('div', {
          style: {
            borderLeft: '2px solid var(--dsw-alias-border-l3, #d8d8d8)',
            paddingLeft: 10,
            marginTop: 10,
            opacity: costRouting ? 1 : 0.55,
            minWidth: 0,
          },
        },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', cursor: costRouting ? 'pointer' : 'default' } },
            h('input', {
              type: 'checkbox',
              checked: peakEnabled,
              disabled: !costRouting,
              onChange: (e) => setPeak({ enabled: e.target.checked }),
            }),
            h('span', null, t('enablePeak')),
          ),
          h('div', { style: { ...labelStyle, marginTop: 8 } }, t('weekdays')),
          h(WeekdayPicker, {
            value: peak.weekdays,
            disabled: !costRouting,
            onChange: (next) => setPeak({ weekdays: next }),
            t,
          }),
          h(WindowEditor, {
            windows: peak.windows,
            disabled: !costRouting,
            onChange: (next) => setPeak({ windows: next }),
            t,
          }),
          h('div', { style: { marginTop: 10 } },
            h(ModelPicker, {
              label: t('peakModel'),
              value: { provider: peak.provider, model: peak.model, reasoningEffort: peak.reasoningEffort },
              providers,
              models,
              modelsLoading: modelsLoading && modelsLoading[peak.provider],
              modelsError: modelsError && modelsError[peak.provider],
              onNeedModels,
              onChange: (next) => setPeak({ provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort }),
              t,
              narrow,
              disabled: !costRouting,
            }),
          ),
        ),
      ),
  )
}

function tierLabelKey(tier) {
  if (tier === 'mid') return 'tierMid'
  if (tier === 'high') return 'tierHigh'
  return 'tierLow'
}
