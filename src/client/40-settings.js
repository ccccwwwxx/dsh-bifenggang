// 设置页「避峰岗」区块（0.16 三档版）。
// 布局与文案见 docs/ROUTING_V2_DESIGN.md §7.1 与附录 B：
//   [状态区] 此刻生效 / 告警 / 冲突
//   [A] 智能程度路由（默认关）+ 阈值 + 样例试算
//   [B] 三档模型（低/中/高；中高默认「跟随低档」）
//   [C] 峰谷与节假日（时区偏移 + 节假日增删 + 整年导入）
//   [D] 高级模型支援（max）
//   [E] 诊断（刷新模型列表 / 恢复原模型 / 最近决策）
//   [保存] [重新加载]
//
// 三条硬约束：
// 1) 所有界面文案走 lib/text.js（copy.test.mjs 会扫硬编码中文）。
// 2) 目录（providers/models）刷新失败不阻塞保存；刷新也**绝不**重载正在编辑的草稿。
// 3) 保存是唯一写入口，且不做任何会阻塞保存的隐式刷新（设计 §7.2）。

function pvErrorText(e) {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    try { return JSON.stringify(e) } catch (err) { return String(e) }
  }
  return e == null ? '' : String(e)
}

// 0.15 的英文技术文案 → 当前语言（v1 迁移期与服务端旧校验仍可能出现）。
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

// ---------- 纯数据整形（全部放在本文件，便于 scripts/catalog-refresh.test.mjs
// 单独加载本文件时也能完整渲染） ----------

const PV_TIERS = ['low', 'mid', 'high']
const PV_TIER_LABEL_KEY = { low: 'tierLow', mid: 'tierMid', high: 'tierHigh' }
const PV_FALLBACK_WINDOWS = [['09:00', '12:00'], ['14:00', '18:00']]
const PV_FALLBACK_WEEKDAYS = [1, 2, 3, 4, 5]
const PV_DEFAULT_CONCRETE = 0.55
const PV_DEFAULT_MEDIUM = 0.28

function pvStr(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function pvNum(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pvTriple(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = { provider: pvStr(src.provider), model: pvStr(src.model) }
  const effort = pvStr(src.reasoningEffort)
  if (effort) out.reasoningEffort = effort
  return out
}

function pvTripleText(triple) {
  const value = triple && typeof triple === 'object' ? triple : {}
  const provider = pvStr(value.provider)
  const model = pvStr(value.model)
  if (!provider && !model) return '-'
  return `${provider}/${model}${value.reasoningEffort ? '@' + value.reasoningEffort : ''}`
}

function pvWeekdays(raw, fallback) {
  const base = Array.isArray(fallback) ? fallback : PV_FALLBACK_WEEKDAYS
  if (!Array.isArray(raw)) return base.slice()
  const out = []
  for (const item of raw) {
    const n = Math.trunc(Number(item))
    if (n >= 1 && n <= 7 && out.indexOf(n) < 0) out.push(n)
  }
  return out.sort((a, b) => a - b)
}

function pvWindows(raw, fallback) {
  const base = Array.isArray(fallback) ? fallback : []
  if (!Array.isArray(raw)) return base.slice()
  const out = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue
    out.push([pvStr(item[0]), pvStr(item[1])])
  }
  return out
}

function pvTimeValid(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(pvStr(value))
}

function pvMinutesOf(value) {
  const [h, m] = pvStr(value).split(':').map((n) => Number(n))
  return h * 60 + m
}

// start < end（含 start、不含 end；不跨午夜）——与服务端一致。
function pvWindowsInvalid(windows) {
  const list = Array.isArray(windows) ? windows : []
  return list.some((w) => {
    if (!Array.isArray(w) || w.length < 2) return true
    if (!pvTimeValid(w[0]) || !pvTimeValid(w[1])) return true
    return pvMinutesOf(w[0]) >= pvMinutesOf(w[1])
  })
}

function pvHolidayValid(year, month, day) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (!Number.isInteger(day) || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function pvHolidayKey(item) {
  return item[0] * 10000 + item[1] * 100 + item[2]
}

function pvNormalizeHolidays(raw) {
  if (!Array.isArray(raw)) return []
  const seen = Object.create(null)
  const out = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) continue
    const year = Math.trunc(Number(item[0]))
    const month = Math.trunc(Number(item[1]))
    const day = Math.trunc(Number(item[2]))
    if (!pvHolidayValid(year, month, day)) continue
    const key = pvHolidayKey([year, month, day])
    if (seen[key]) continue
    seen[key] = true
    out.push([year, month, day])
  }
  return out.sort((a, b) => pvHolidayKey(a) - pvHolidayKey(b))
}

function pvDateRange(year, month, fromDay, toDay) {
  const out = []
  for (let day = fromDay; day <= toDay; day += 1) out.push([year, month, day])
  return out
}

// 内置节假日预设：2026/2027 与 lib/text.js 的 DEFAULTS.holidays 一致（单一事实来源
// 是 text.js，改默认值时要同步这里）；2025 为公开的放假安排，仅作示例。
// 目的只有一个：让「整年导入」可用，用户仍可逐条改。
const PV_HOLIDAY_PRESETS = {
  2025: [].concat(
    [[2025, 1, 1]],
    pvDateRange(2025, 1, 28, 31),
    pvDateRange(2025, 2, 1, 4),
    pvDateRange(2025, 4, 4, 6),
    pvDateRange(2025, 5, 1, 5),
    pvDateRange(2025, 5, 31, 31),
    pvDateRange(2025, 6, 1, 2),
    pvDateRange(2025, 10, 1, 8),
  ),
  2026: pvDateRange(2026, 10, 1, 8),
  2027: pvDateRange(2027, 1, 1, 3),
}

function pvNormalizeTier(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const peakSrc = src.peak && typeof src.peak === 'object' ? src.peak : {}
  return {
    valley: pvTriple(src.valley !== undefined ? src.valley : src.primary),
    costRouting: src.costRouting !== false,
    peak: {
      enabled: peakSrc.enabled === true,
      weekdays: pvWeekdays(peakSrc.weekdays, pvWeekdays(src.weekdays, PV_FALLBACK_WEEKDAYS)),
      windows: pvWindows(peakSrc.windows, []),
      ...pvTriple(peakSrc),
    },
  }
}

function pvTierRouting(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: src.enabled === true,
    concreteThreshold: pvNum(src.concreteThreshold, PV_DEFAULT_CONCRETE),
    mediumThreshold: pvNum(src.mediumThreshold, PV_DEFAULT_MEDIUM),
  }
}

// 把服务端（或旧草稿）下发的任意形状收敛成「可渲染的 canonical v2 草稿」。
// 幂等：对已经是 v2 的输入不做任何语义改动。v1 形状只是兼容显示（0.15 服务端、
// 旧 policy.json 的 in-memory 视图），一旦保存就按 v2 提交。
function pvDraftFrom(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const draft = {
    schemaVersion: 2,
    utcOffsetMinutes: pvNum(src.utcOffsetMinutes, 480),
    holidays: pvNormalizeHolidays(src.holidays),
    tierRouting: pvTierRouting(src.tierRouting),
    targets: {},
    advancedSupport: pvTriple(src.advancedSupport !== undefined ? src.advancedSupport : src.exclusive),
  }
  if (src.targets && typeof src.targets === 'object') {
    draft.targets.low = pvNormalizeTier(src.targets.low)
    for (const tier of ['mid', 'high']) {
      const item = src.targets[tier]
      draft.targets[tier] = item && item.share === 'low' ? { share: 'low' } : pvNormalizeTier(item)
    }
    // v1 迁移快照（只读、不参与路由）。节点只在首次保存时写入，GUI 必须原样带回，
    // 否则一次保存就把迁移前的 strategies 快照永久丢了。
    if (src.legacy && typeof src.legacy === 'object') draft.legacy = JSON.parse(JSON.stringify(src.legacy))
    return draft
  }
  const strategies = Array.isArray(src.strategies) ? src.strategies : []
  const first = strategies[0] && typeof strategies[0] === 'object' ? strategies[0] : {}
  const firstPeak = first.peak && typeof first.peak === 'object' ? first.peak : {}
  const peakSource = firstPeak.provider || firstPeak.model ? firstPeak : first.primary
  draft.targets.low = {
    valley: pvTriple(first.primary),
    costRouting: true,
    peak: {
      enabled: firstPeak.enabled === true,
      weekdays: pvWeekdays(firstPeak.weekdays, pvWeekdays(first.weekdays, PV_FALLBACK_WEEKDAYS)),
      windows: pvWindows(firstPeak.windows, PV_FALLBACK_WINDOWS),
      ...pvTriple(peakSource),
    },
  }
  draft.targets.mid = { share: 'low' }
  draft.targets.high = {
    valley: pvTriple(draft.advancedSupport),
    costRouting: true,
    peak: {
      enabled: false,
      weekdays: draft.targets.low.peak.weekdays.slice(),
      windows: draft.targets.low.peak.windows.slice(),
      provider: draft.advancedSupport.provider || '',
      model: draft.advancedSupport.model || '',
    },
  }
  return draft
}

function pvIsShared(draft, tier) {
  const item = draft && draft.targets ? draft.targets[tier] : null
  return Boolean(item && item.share === 'low')
}

function pvResolveTarget(draft, tier) {
  const targets = draft && draft.targets ? draft.targets : {}
  const item = targets[tier]
  if (item && item.share === 'low') return targets.low
  return item || pvNormalizeTier(null)
}

// 取消「跟随低档」时，把当前继承值复制成独立配置（用户可继续改）。
function pvCopyTarget(target) {
  return JSON.parse(JSON.stringify(target || pvNormalizeTier(null)))
}

// 配置里被引用到的 provider id，用于优先拉取模型（失败不影响保存）。
function pvUsedProviderIds(draft) {
  const used = new Set()
  const add = (holder) => {
    const id = holder && holder.provider ? String(holder.provider) : ''
    if (id) used.add(id)
  }
  const targets = draft && draft.targets ? draft.targets : {}
  add(draft && draft.advancedSupport)
  for (const tier of PV_TIERS) {
    const item = targets[tier]
    if (!item || item.share === 'low') continue
    add(item.valley)
    add(item.peak)
  }
  return used
}

// 提交给 set 的 canonical payload：共享档只提交 { share: 'low' }，不夹带继承值。
function pvSavePayload(draft) {
  const targets = {}
  for (const tier of PV_TIERS) {
    const item = draft && draft.targets ? draft.targets[tier] : null
    targets[tier] = item && item.share === 'low' ? { share: 'low' } : pvNormalizeTier(item)
  }
  const payload = {
    schemaVersion: 2,
    utcOffsetMinutes: pvNum(draft && draft.utcOffsetMinutes, 480),
    holidays: pvNormalizeHolidays(draft && draft.holidays),
    tierRouting: pvTierRouting(draft && draft.tierRouting),
    targets,
    advancedSupport: pvTriple(draft && draft.advancedSupport),
  }
  if (draft && draft.legacy && typeof draft.legacy === 'object') payload.legacy = draft.legacy
  return payload
}

// 保存前的本地校验：只拦「一定能看出错」的情况，其余交给服务端（服务端是权威）。
function pvValidationError(draft, t) {
  const tr = pvTierRouting(draft && draft.tierRouting)
  const inRange = (n) => Number.isFinite(n) && n >= 0 && n <= 1
  if (!inRange(tr.concreteThreshold) || !inRange(tr.mediumThreshold)) return t('errThresholdRange')
  if (!(tr.concreteThreshold > tr.mediumThreshold)) return t('errThresholdOrder')
  const targets = draft && draft.targets ? draft.targets : {}
  for (const tier of PV_TIERS) {
    const item = targets[tier]
    if (!item || item.share === 'low') continue
    const label = t(PV_TIER_LABEL_KEY[tier])
    const valley = item.valley || {}
    if (!valley.provider || !valley.model) return t('errTargetIncomplete', { tier: label })
    if (pvWindowsInvalid(item.peak && item.peak.windows)) return t('peakWindowInvalid')
    const peak = item.peak || {}
    if (item.costRouting !== false && peak.enabled === true && (!peak.provider || !peak.model)) {
      return t('errTargetIncomplete', { tier: label })
    }
  }
  const advanced = pvTriple(draft && draft.advancedSupport)
  if (!advanced.provider || !advanced.model) return t('errAdvancedSupport')
  return ''
}

// ---------- 原因 / 告警文案映射（未知值一律降级，不崩） ----------

function pvTierReasonText(reason, t) {
  switch (reason) {
    case 'tier-disabled': return t('tierReasonDisabled')
    case 'tier-low': return t('tierReasonLow')
    case 'tier-mid': return t('tierReasonMid')
    case 'tier-high': return t('tierReasonHigh')
    case 'override-high-safety': return t('tierReasonOverrideSafety')
    case 'override-high-explicit': return t('tierReasonOverrideHigh')
    case 'override-low-explicit': return t('tierReasonOverrideLow')
    case 'tier-fallback-low': return t('tierReasonFallbackLow')
    case 'max-advanced': return t('tierReasonMax')
    default: return ''
  }
}

function pvCostReasonText(reason, t) {
  switch (reason) {
    case 'peak': return t('costReasonPeak')
    case 'valley': return t('costReasonValley')
    case 'cost-off': return t('costReasonCostOff')
    case 'peak-disabled': return t('costReasonPeakDisabled')
    case 'peak-weekday': return t('costReasonWeekday')
    case 'peak-holiday': return t('costReasonHoliday')
    case 'peak-outside': return t('costReasonOutside')
    default: return ''
  }
}

function pvOutcomeText(outcome, t) {
  switch (outcome) {
    case 'selected': return t('outcomeSelected')
    case 'noop-same': return t('outcomeNoop')
    case 'unroutable': return t('outcomeUnroutable')
    case 'select-failed': return t('outcomeSelectFailed')
    case 'host-unsupported': return t('outcomeDisabled')
    case 'disabled': return t('outcomeDisabled')
    default: return ''
  }
}

function pvWarningKindText(kind, t) {
  switch (kind) {
    case 'provider': return t('warnKindProvider')
    case 'model': return t('warnKindModel')
    case 'effort': return t('warnKindEffort')
    case 'missing': return t('warnKindMissing')
    case 'unverified': return t('warnKindUnverified')
    case 'llm-unavailable': return t('warnKindLlmUnavailable')
    case 'select-failed': return t('warnKindSelectFailed')
    case 'no-current': return t('warnKindNoCurrent')
    case 'host-unsupported': return t('warnKindHostUnsupported')
    case 'request-failed': return t('warnKindRequestFailed')
    case 'sync-read-failed': return t('warnKindSyncReadFailed')
    case 'state-write-failed': return t('warnKindStateWriteFailed')
    case 'default-seam-missing': return t('warnKindDefaultSeamMissing')
    case 'legacy-extra-strategies': return t('warnKindLegacyExtra')
    case 'invalid-holidays': return t('warnKindInvalidHolidays')
    default: return t('warnKindOther')
  }
}

function pvWarningText(warning, t) {
  if (!warning || typeof warning !== 'object') return ''
  const kind = pvStr(warning.kind)
  const target = pvTripleText(warning.target)
  const kept = pvTripleText(warning.kept)
  if (kind === 'unverified') return t('warningUnverified', { target })
  if (kind === 'llm-unavailable') return t('warningLlmUnavailable')
  if (kind === 'host-unsupported') return t('warningHostUnsupported')
  // v1 迁移：strategies[1..] 不再参与路由（只读 legacy 快照），必须让用户看见。
  if (kind === 'legacy-extra-strategies') return t('warningLegacyExtra', { count: pvNum(warning.extraCount, 0) })
  // 服务端过滤掉非法节假日（t18）：走既有横幅，不新增专用 UI。
  if (kind === 'invalid-holidays') return t('warningInvalidHolidays')
  if (kind === 'select-failed' || kind === 'no-current' || kind === 'request-failed'
    || kind === 'provider' || kind === 'model' || kind === 'effort' || kind === 'missing') {
    return t('warningUnroutable', { target, kind: pvWarningKindText(kind, t), kept: kept === '-' ? '-' : kept })
  }
  return t('warningGeneric', { kind: pvWarningKindText(kind, t), target })
}

// 「此刻生效」：目标 + 档位来源 + costRouting 原因，一段话解释清楚。
// 同时兼容 0.16 的 Decision 形状与 0.15 的扁平 active。
function pvActiveParts(active, t) {
  if (!active || typeof active !== 'object') return []
  const target = active.target && typeof active.target === 'object' ? active.target : active
  const parts = [pvTripleText(target)]
  if (active.axis === 'max') parts.push(t('axisMax'))
  const tier = active.tier === 'low' || active.tier === 'mid' || active.tier === 'high' ? active.tier : ''
  if (tier) parts.push(t(PV_TIER_LABEL_KEY[tier]))
  const tierReason = pvTierReasonText(active.tierReason, t)
  // tier-low/mid/high 与档位标签本身重复，不再重复一遍。
  const redundant = active.tierReason === 'tier-low' || active.tierReason === 'tier-mid' || active.tierReason === 'tier-high'
  if (tierReason && !redundant) parts.push(tierReason)
  else if (active.reason === 'advanced-max') parts.push(t('tierReasonMax'))
  else if (active.reason === 'primary') parts.push(t('tierReasonDisabled'))
  const cost = pvCostReasonText(active.costReason, t)
  if (cost) parts.push(cost)
  else if (active.reason === 'peak') parts.push(t('costReasonPeak'))
  if (active.fallback === 'low') parts.push(t('fallbackLow'))
  return parts
}

const PV_FEATURE_KEYS = {
  code: 'featureCode',
  path: 'featurePath',
  command: 'featureCommand',
  symbol: 'featureSymbol',
  verb: 'featureVerb',
  'multi-question': 'featureMulti',
  abstract: 'featureAbstract',
  long: 'featureLong',
  short: 'featureShort',
  'short-command': 'featureShortCommand',
  image: 'featureImage',
  'mid-turn': 'featureMidTurn',
  'override-safety': 'featureOverrideSafety',
  'override-high': 'featureOverrideHigh',
  'override-low': 'featureOverrideLow',
  target: 'featureTarget',
  sequence: 'featureSequence',
}

function pvFeatureId(feature) {
  if (typeof feature === 'string') return feature
  if (feature && typeof feature === 'object') return pvStr(feature.id || feature.key || feature.label)
  return ''
}

function pvFeatureText(feature, t) {
  const id = pvFeatureId(feature)
  const key = PV_FEATURE_KEYS[id]
  return key ? t(key) : id
}

function pvTierLabel(tier, t) {
  return t(PV_TIER_LABEL_KEY[tier] || 'tierLow')
}

// 首次使用判定：node 端下发 get.firstRun 时以它为准；尚未下发时按 revision 兜底
// 推断——新装/从未保存过 policy.json 时 revision 仍是 DEFAULTS 的 1，首次保存后
// node 端会 +1。兜底只是过渡（t18/core 落地 firstRun 后自动优先用字段），
// 未知形状一律 false（不误导已有用户）。
function pvFirstRunState(res) {
  if (!res || typeof res !== 'object') return false
  if (typeof res.firstRun === 'boolean') return res.firstRun
  // v1 policy.json 被内存迁移后一定带 legacy 快照（lib/routing.js#migrateV1），
  // 说明是老用户升级上来而不是新装：不要用 revision=1 误判成首次使用。
  if (res.config && typeof res.config === 'object' && res.config.legacy && typeof res.config.legacy === 'object') return false
  const revision = typeof res.configRevision === 'number'
    ? res.configRevision
    : (res.config && typeof res.config.revision === 'number' ? res.config.revision : undefined)
  if (typeof revision !== 'number') return false
  return revision <= 1
}

// 节假日编辑器（无内部状态：日期输入与年份选择由父级持有）。
function PvHolidayEditor(props) {
  const h = React.createElement
  const { holidays, input, year, onInput, onYear, onAdd, onRemove, onImport, t } = props
  const list = Array.isArray(holidays) ? holidays : []
  const years = Object.keys(PV_HOLIDAY_PRESETS).map((y) => Number(y)).sort()
  const chosen = Number(year) || years[years.length - 1] || new Date().getFullYear()
  const hasPreset = Object.prototype.hasOwnProperty.call(PV_HOLIDAY_PRESETS, chosen)
  const groups = []
  for (const item of list) {
    const last = groups[groups.length - 1]
    if (last && last.year === item[0]) last.days.push(item)
    else groups.push({ year: item[0], days: [item] })
  }
  return h('div', { style: { minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
      h('input', {
        type: 'date',
        min: '2000-01-01',
        max: '2100-12-31',
        value: input || '',
        'aria-label': t('holidayAdd'),
        onChange: (e) => onInput(e.target.value),
        style: { width: 160, boxSizing: 'border-box' },
      }),
      h('button', { onClick: onAdd, style: { padding: '2px 8px' } }, t('holidayAdd')),
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('holidayPresetLabel')),
      h('select', {
        value: String(chosen),
        'aria-label': t('holidayPresetLabel'),
        onChange: (e) => onYear(e.target.value),
      }, years.map((y) => h('option', { key: y, value: String(y) }, String(y)))),
      h('button', {
        onClick: () => onImport(chosen),
        disabled: !hasPreset,
        style: { padding: '2px 8px' },
      }, t('holidayPresetAdd', { year: chosen })),
    ),
    hasPreset
      ? null
      : h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-warn-label, #8a6100)', marginBottom: 6 } }, t('holidayPresetMissing', { year: chosen })),
    list.length === 0
      ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('holidayEmpty'))
      : h('div', null, groups.map((group) => h('div', { key: group.year, style: { marginBottom: 4 } },
        h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginRight: 6 } }, String(group.year)),
        group.days.map((item) => h('span', {
          key: pvHolidayKey(item),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            margin: '0 6px 4px 0',
            padding: '0 6px',
            borderRadius: 999,
            fontSize: 12,
            lineHeight: '20px',
            background: 'var(--dsw-alias-interactive-bg-hover, #f0f0f0)',
          },
        },
          h('span', null, `${item[0]}-${String(item[1]).padStart(2, '0')}-${String(item[2]).padStart(2, '0')}`),
          h('button', {
            onClick: () => onRemove(item[0], item[1], item[2]),
            title: t('remove'),
            style: { padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' },
          }, 'x'),
        )),
      ))),
  )
}

function PolicySettingsSection({ rpc, t }) {
  const h = React.createElement
  // 第一个 useState 必须是 config：scripts/catalog-refresh.test.mjs 直接替换 cells[0]
  // 来注入草稿，其余钩子顺序必须稳定。
  const [config, setConfig] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [providers, setProviders] = useState([])
  const [providersError, setProvidersError] = useState('')
  const [models, setModels] = useState({})
  const [modelsLoading, setModelsLoading] = useState({})
  const [modelsError, setModelsError] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [version, setVersion] = useState('')
  const [active, setActive] = useState(null)
  const [host, setHost] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [recentWarnings, setRecentWarnings] = useState([])
  // 首次使用引导：firstRun 来自 get（true = 用户还没保存过 policy.json）；
  // guideDismissed 只存会话内存（不落盘），保存成功后引导也必须消失。
  const [firstRun, setFirstRun] = useState(null)
  const [guideDismissed, setGuideDismissed] = useState(false)
  const [recentDecisions, setRecentDecisions] = useState([])
  const [sessionDetails, setSessionDetails] = useState({})
  const [restoring, setRestoring] = useState('')
  const [savedAt, setSavedAt] = useState('')
  const [toast, setToast] = useState('')
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [conflict, setConflict] = useState(null)
  const [probeText, setProbeText] = useState('')
  const [probeResult, setProbeResult] = useState(null)
  const [probeError, setProbeError] = useState('')
  const [probeBusy, setProbeBusy] = useState(false)
  const [baseRevision, setBaseRevision] = useState(undefined)
  const [holidayInput, setHolidayInput] = useState('')
  const [holidayYear, setHolidayYear] = useState('')
  const [sectionRef, narrow] = useContainerWidth(640)
  const catalogRefresh = useRef(false)
  const requested = useRef({})
  // ---- 跨窗口同步（设计 §6.3）：3 秒整份 get 轮询 + 草稿保护 ----
  // busyRef：保存进行中不做 adopt，避免「刚保存的成功回包」和轮询互相覆盖。
  // seenRevisionRef：已经处理过的 configRevision，避免同一个外部变更每 3 秒重设状态。
  // baseConfigJson：最近一次「已采纳」的 canonical 配置（脏检查基线）。
  // draftJsonRef：当前草稿的 canonical 序列化（每次渲染后同步，供轮询回调读取）。
  const busyRef = useRef(false)
  const pollingRef = useRef(false)
  const seenRevisionRef = useRef(undefined)
  const baseConfigJson = useRef('')
  const draftJsonRef = useRef('')

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
      // Keep the last usable catalog when a refresh fails.
      setProvidersError(pvErrorText(e))
      return []
    }
  }, [rpc])

  const load = useCallback(async () => {
    setLoadError('')
    setSaveError('')
    setSavedAt('')
    setToast('')
    setConflict(null)
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
    setVersion(res && typeof res.version === 'string' ? res.version : '')
    setActive(res && res.active && typeof res.active === 'object' ? res.active : null)
    setHost(res && res.host && typeof res.host === 'object' ? res.host : null)
    setWarnings(res && Array.isArray(res.warnings) ? res.warnings : [])
    setRecentWarnings(res && Array.isArray(res.recentWarnings) ? res.recentWarnings : [])
    setRecentDecisions(res && Array.isArray(res.recentDecisions) ? res.recentDecisions : [])
    setSessionDetails(res && res.sessionDetails && typeof res.sessionDetails === 'object' ? res.sessionDetails : {})
    setBaseRevision(res && typeof res.configRevision === 'number' ? res.configRevision : undefined)
    setFirstRun(pvFirstRunState(res))
    const raw = res && res.config !== undefined ? res.config : res
    const draft = pvDraftFrom(raw)
    setConfig(draft)
    // 采纳新配置：重置脏检查基线与「已见 revision」。
    baseConfigJson.current = JSON.stringify(pvSavePayload(draft))
    draftJsonRef.current = baseConfigJson.current
    seenRevisionRef.current = res && typeof res.configRevision === 'number' ? res.configRevision : undefined
    const used = [...pvUsedProviderIds(draft)]
    const list = await loadProviders()
    // 1) 配置里用到的 provider 先并行拉模型；2) 其余 provider 随后并行补齐。
    await Promise.all(used.map((id) => fetchModels(id)))
    for (const p of list) {
      if (used.indexOf(p.id) < 0) fetchModels(p.id)
    }
  }, [rpc, loadProviders, fetchModels])

  useEffect(() => { load() }, [load])

  // 目录（providers / models）刷新：只动目录，不动正在编辑的配置（草稿保护）。
  const reloadCatalog = useCallback(async () => {
    if (catalogRefresh.current) return
    catalogRefresh.current = true
    setRefreshingCatalog(true)
    setProvidersError('')
    setModelsError({})
    try {
      const list = await loadProviders()
      const used = [...pvUsedProviderIds(pvDraftFrom(config))]
      const ids = used.concat(list.map((p) => p.id).filter((id) => used.indexOf(id) < 0))
      await Promise.all(ids.map((id) => {
        requested.current[id] = false
        return fetchModels(id)
      }))
    } finally {
      catalogRefresh.current = false
      setRefreshingCatalog(false)
    }
  }, [loadProviders, fetchModels, config])

  // 草稿序列化基线：渲染期同步（不等 effect）。轮询每 3 秒读一次，必须看到
  // 当前草稿；放在 effect 里会有一个渲染间隙，可能把脏草稿误判成干净而覆盖。
  if (config) {
    try {
      draftJsonRef.current = JSON.stringify(pvSavePayload(pvDraftFrom(config)))
    } catch (err) {
      draftJsonRef.current = ''
    }
  }

  // 3 秒整份 get 轮询（设计 §6.3）：只同步展示态；配置变更按「草稿是否脏」决定
  // 采纳还是亮冲突条。失败静默，绝不弹错、绝不阻塞保存。
  const poll = useCallback(async () => {
    if (pollingRef.current) return
    pollingRef.current = true
    try {
      const res = await rpc.get()
      if (!res || typeof res !== 'object') return
      if (typeof res.version === 'string') setVersion(res.version)
      setActive(res.active && typeof res.active === 'object' ? res.active : null)
      setHost(res.host && typeof res.host === 'object' ? res.host : null)
      setWarnings(Array.isArray(res.warnings) ? res.warnings : [])
      setRecentWarnings(Array.isArray(res.recentWarnings) ? res.recentWarnings : [])
      setSessionDetails(res.sessionDetails && typeof res.sessionDetails === 'object' ? res.sessionDetails : {})
      // 另一窗口保存后（revision 变化/firstRun=false）引导也应消失。
      setFirstRun(pvFirstRunState(res))
      // get 也带 enabled/sessions；本区块不展示它们（开关属于侧边栏 store），
      // 但会话覆盖变化仍通过 sessionDetails 的 enabled 字段在「恢复原模型」里体现。

      const revision = typeof res.configRevision === 'number' ? res.configRevision : undefined
      if (revision === undefined || revision === seenRevisionRef.current) return
      if (busyRef.current) return // 保存进行中：交给保存回包，避免互相覆盖
      const raw = res.config !== undefined ? res.config : res
      const next = pvDraftFrom(raw)
      const nextJson = JSON.stringify(pvSavePayload(next))
      const dirty = draftJsonRef.current !== '' && draftJsonRef.current !== baseConfigJson.current
      if (!dirty) {
        // 草稿干净：直接采纳外部变更（等价于「另一窗口保存后这边自动跟上」）。
        setConfig(next)
        setBaseRevision(revision)
        seenRevisionRef.current = revision
        baseConfigJson.current = nextJson
        draftJsonRef.current = nextJson
        setSavedAt('')
        setSaveError('')
        setToast('')
        setConflict(null)
        // 新配置可能引用还没拉过目录的 provider：后台补齐，不阻塞任何保存。
        for (const id of pvUsedProviderIds(next)) fetchModels(id)
        return
      }
      // 草稿是脏的：绝不静默覆盖。保留 base revision，普通保存仍会拿到
      // stale-revision（用户必须显式选「用我的覆盖」）。
      seenRevisionRef.current = revision
      setConflict({ message: '', config: next, revision, external: true })
    } catch (err) {
      // 轮询失败静默：下一次再试。
    } finally {
      pollingRef.current = false
    }
  }, [rpc, fetchModels])

  useEffect(() => {
    // 只在真实运行时轮询：测试/无 DOM 环境下（vm harness）没有定时器与 document。
    if (typeof setInterval !== 'function' || typeof document === 'undefined') return undefined
    let timer = null
    const visible = () => document.visibilityState === undefined || document.visibilityState === 'visible'
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const start = () => {
      if (timer === null && visible()) timer = setInterval(() => { poll() }, 3000)
    }
    const onVisibility = () => {
      if (visible()) {
        poll()
        start()
      } else {
        stop()
      }
    }
    const onFocus = () => {
      if (visible()) {
        poll()
        start()
      }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('focus', onFocus)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('focus', onFocus)
    }
  }, [poll])

  const updateConfig = (next) => {
    setSavedAt('')
    setSaveError('')
    setToast('')
    setConfig(next)
  }

  // 样例试算：只读（不落盘、不 select）。0.16 之前没有 probe handler → 明确降级。
  const runProbe = async () => {
    setProbeError('')
    setProbeResult(null)
    if (typeof rpc.probe !== 'function') {
      setProbeError(t('tierProbeUnavailable'))
      return
    }
    setProbeBusy(true)
    try {
      const result = await rpc.probe({ text: probeText })
      setProbeResult(result && typeof result === 'object' ? result : null)
    } catch (e) {
      const message = pvErrorText(e)
      if (/not found|unknown|unsupported|no handler/i.test(message)) setProbeError(t('tierProbeUnavailable'))
      else setProbeError(t('tierProbeFailed', { detail: message }))
    } finally {
      setProbeBusy(false)
    }
  }

  const restoreSession = async (sessionId) => {
    setRestoring(sessionId || '')
    try {
      await rpc.restore(sessionId)
      setSessionDetails((prev) => {
        const next = { ...prev }
        if (next[sessionId] && typeof next[sessionId] === 'object') {
          next[sessionId] = { ...next[sessionId], restore: null, restorePending: false }
        }
        return next
      })
    } catch (e) {
      setSaveError(pvErrorText(e))
    } finally {
      setRestoring('')
    }
  }

  // 批量恢复：串行调用（同一会话只有一个写句柄），成功后才清本地行。
  const restoreAll = async (ids) => {
    const list = Array.isArray(ids) ? ids.slice() : []
    if (list.length === 0) return
    setRestoring('all')
    try {
      for (const id of list) await rpc.restore(id)
      setSessionDetails((prev) => {
        const next = { ...prev }
        for (const id of list) {
          if (next[id] && typeof next[id] === 'object') next[id] = { ...next[id], restore: null, restorePending: false }
        }
        return next
      })
    } catch (e) {
      setSaveError(pvErrorText(e))
    } finally {
      setRestoring('')
    }
  }

  if (!config) {
    return h('div', { ref: sectionRef, style: { maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },
      h('div', { style: { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 8 } }, t('title')),
      loadError
        ? h('div', null,
          h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: 13, marginBottom: 4 } }, t('loadFailed')),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 8, wordBreak: 'break-word' } }, loadError),
          h('button', { onClick: () => { load() }, style: { fontWeight: 600 } }, t('retry')),
        )
        : h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #888)' } }, t('loading')),
    )
  }

  // 渲染前收敛一次：外部下发的东西一律当外部输入（v1 旧服务端 / 旧草稿也能显示）。
  const draft = pvDraftFrom(config)
  const targets = draft.targets
  const resolved = {
    low: targets.low,
    mid: pvResolveTarget(draft, 'mid'),
    high: pvResolveTarget(draft, 'high'),
  }

  const setTier = (tier, nextValue) => updateConfig({
    ...draft,
    targets: { ...draft.targets, [tier]: nextValue },
  })
  const setShare = (tier, shared) => {
    if (shared) {
      setTier(tier, { share: 'low' })
      return
    }
    setTier(tier, pvCopyTarget(pvResolveTarget(draft, tier)))
  }
  const setTierRouting = (patch) => updateConfig({ ...draft, tierRouting: { ...draft.tierRouting, ...patch } })
  const setAdvanced = (triple) => updateConfig({ ...draft, advancedSupport: triple })
  const setHolidays = (list) => updateConfig({ ...draft, holidays: pvNormalizeHolidays(list) })

  const addHoliday = () => {
    const raw = pvStr(holidayInput)
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
    if (!match) {
      setSaveError(t('holidayInvalid'))
      return
    }
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (!pvHolidayValid(year, month, day)) {
      setSaveError(t('holidayInvalid'))
      return
    }
    setSaveError('')
    setHolidayInput('')
    setHolidays(draft.holidays.concat([[year, month, day]]))
  }

  const importHolidayYear = (year) => {
    const preset = PV_HOLIDAY_PRESETS[year]
    if (!Array.isArray(preset)) {
      setSaveError(t('holidayPresetMissing', { year }))
      return
    }
    setSaveError('')
    setHolidays(draft.holidays.concat(preset))
  }

  const save = async (overwrite) => {
    const invalid = pvValidationError(draft, t)
    if (invalid) {
      setSaveError(invalid)
      setToast('')
      return
    }
    setSaving(true)
    busyRef.current = true
    setSaveError('')
    setSavedAt('')
    setToast('')
    try {
      const payload = pvSavePayload(draft)
      const next = await rpc.set(payload, overwrite === true ? undefined : baseRevision)
      const raw = next && next.config !== undefined ? next.config : next
      const applied = pvDraftFrom(raw)
      setConfig(applied)
      const appliedJson = JSON.stringify(pvSavePayload(applied))
      baseConfigJson.current = appliedJson
      draftJsonRef.current = appliedJson
      if (next && typeof next.configRevision === 'number') {
        setBaseRevision(next.configRevision)
        seenRevisionRef.current = next.configRevision
      }
      // 保存即视为「已用过」：引导永久消失（即使服务端这一版还没下发 firstRun）。
      setFirstRun(false)
      setConflict(null)
      // 明确的成功反馈：保存成功后界面必须有变化，用户才能区分「存上了」和「点了没反应」。
      const time = new Date().toLocaleTimeString()
      setSavedAt(time)
      setToast(t('saveToast', { time }))
    } catch (e) {
      setToast('')
      if (e && e.code === 'stale-revision') {
        // 另一窗口已改：不静默覆盖，给「重新加载 / 用我的覆盖」。
        setConflict({
          message: pvErrorText(e),
          config: e.details && e.details.config ? e.details.config : null,
          revision: e.details && typeof e.details.revision === 'number' ? e.details.revision : undefined,
          external: false,
        })
      } else {
        setSaveError(pvErrorText(e))
      }
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  // 「重新加载」冲突：优先用服务端随错误/轮询下发的 config，省一次往返；
  // 没有可用配置时退回整份 get。
  const reloadConflict = async () => {
    const current = conflict
    const external = current && current.config && typeof current.config === 'object' ? pvDraftFrom(current.config) : null
    if (!external) {
      await load()
      return
    }
    setConfig(external)
    baseConfigJson.current = JSON.stringify(pvSavePayload(external))
    draftJsonRef.current = baseConfigJson.current
    if (current.revision !== undefined) {
      setBaseRevision(current.revision)
      seenRevisionRef.current = current.revision
    }
    setConflict(null)
    setSavedAt('')
    setSaveError('')
    setToast('')
  }

  // 目录降级提示：providers / 任一 provider 的 models 失败都只提示，不影响保存。
  const modelErrorIds = Object.keys(modelsError)
  const catalogDegraded = Boolean(providersError) || modelErrorIds.length > 0
  const catalogDetail = providersError || (modelErrorIds.length > 0 ? modelsError[modelErrorIds[0]] : '')
  const hostOk = host && typeof host === 'object' ? host.modelSelect : undefined
  const activeParts = pvActiveParts(active, t)
  const warningList = Array.isArray(warnings) ? warnings : []
  // 最近 50 条 raise/clear 历史：告警自动消失后，用户仍能看到「刚才发生了什么」。
  const clearedWarnings = (Array.isArray(recentWarnings) ? recentWarnings : [])
    .filter((entry) => entry && entry.event === 'cleared')
    .slice(0, 5)
  const warningSeverity = warningList.some((w) => w && w.severity === 'error') ? 'error' : 'info'
  const recentList = Array.isArray(recentDecisions) ? recentDecisions : []
  const restorable = Object.keys(sessionDetails || {})
    .filter((id) => sessionDetails[id] && typeof sessionDetails[id] === 'object' && sessionDetails[id].restore)
    .slice(0, 20)
  const presetYears = Object.keys(PV_HOLIDAY_PRESETS).map((y) => Number(y)).sort()
  const selectedHolidayYear = Number(holidayYear) || presetYears[presetYears.length - 1] || new Date().getFullYear()

  const labelStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 }
  const sectionTitleStyle = { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 4 }
  const hintStyle = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginBottom: 8 }

  return h('div', { ref: sectionRef, style: { maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },

    // ---- 标题 / 版本 / 宿主能力 ----
    h('div', { style: { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 4 } }, t('title')),
    h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 8 } }, t('subtitle')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
      version
        ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)' } }, `${t('versionLabel')} v${version}`)
        : null,
      hostOk === true
        ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-success-primary, #16794c)' } }, t('hostBadgeOk'))
        : hostOk === false
          ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('hostBadgeOld'))
          : null,
    ),

    // ---- 首次使用引导（可关闭、不阻塞保存；保存后永久消失） ----
    firstRun === true && guideDismissed !== true
      ? h('div', {
        role: 'note',
        'data-first-run': 'true',
        style: {
          border: '1px solid var(--dsw-alias-state-business-primary, #4c8dff)',
          background: 'var(--dsw-alias-bg-layer-1, #f2f7ff)',
          borderRadius: 10,
          padding: 12,
          marginBottom: 12,
          maxWidth: '100%',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } }, t('firstRunTitle')),
          h('button', {
            onClick: () => setGuideDismissed(true),
            style: { marginLeft: 'auto', padding: '2px 8px' },
          }, t('firstRunDismiss')),
        ),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)' } },
          ['firstRunPoint1', 'firstRunPoint2', 'firstRunPoint3', 'firstRunPoint4'].map((key) => h('li', { key }, t(key))),
        ),
      )
      : null,

    // ---- 状态区：此刻生效 ----
    active && typeof active === 'object'
      ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)', marginBottom: 8, wordBreak: 'break-word' } },
        t('activeNowLabel') + activeParts.join(' · '),
        active.advancedForMax ? t('advancedForMax', { model: active.advancedForMax }) : null)
      : null,

    // ---- 告警（error=红 / info=黄；数据来自 get.warnings） ----
    warningList.length > 0
      ? h('div', {
        role: 'alert',
        style: {
          border: `1px solid ${warningSeverity === 'error' ? 'var(--dsw-alias-state-error-primary, #e5484d)' : 'var(--dsw-alias-state-warn-primary, #e6c473)'}`,
          background: warningSeverity === 'error' ? 'var(--dsw-alias-bg-layer-1, #fff1f1)' : 'var(--dsw-alias-bg-layer-1, #fff9e8)',
          borderRadius: 10,
          padding: 10,
          marginBottom: 10,
          maxWidth: '100%',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { fontSize: 12, lineHeight: '18px', fontWeight: 600, color: warningSeverity === 'error' ? 'var(--dsw-alias-state-error-primary, #c00)' : 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('warningTitle')),
        h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)', marginTop: 2, wordBreak: 'break-word' } }, pvWarningText(warningList[0], t)),
        warningList.length > 1 || clearedWarnings.length > 0
          ? h('details', { style: { marginTop: 4 } },
            h('summary', { style: { fontSize: 11, lineHeight: '16px', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary, #777)' } },
              warningList.length > 1 ? t('warningMore', { count: warningList.length - 1 }) : t('warningRecent')),
            warningList.slice(1, 5).map((w, i) => h('div', { key: 'w' + i, style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #777)', wordBreak: 'break-word' } }, pvWarningText(w, t))),
            clearedWarnings.map((w, i) => h('div', { key: 'c' + i, style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #777)', wordBreak: 'break-word' } },
              t('warningCleared', { target: pvTripleText(w.target) }))),
          )
          : null,
      )
      : null,

    // ---- 冲突：另一窗口已改 ----
    conflict
      ? h('div', {
        role: 'alert',
        style: { border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)', background: 'var(--dsw-alias-bg-layer-1, #fff1f1)', borderRadius: 10, padding: 10, marginBottom: 10, boxSizing: 'border-box' },
      },
        h('div', { style: { fontSize: 12, lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #c00)' } }, t('conflictTitle')),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #777)', marginTop: 2, wordBreak: 'break-word' } }, conflict.message || t('conflictExternalHint')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
          h('button', { onClick: () => { reloadConflict() } }, t('conflictReload')),
          h('button', { onClick: () => { save(true) } }, t('conflictOverwrite')),
        ),
      )
      : null,

    // ---- 目录降级提示（不阻塞保存） ----
    catalogDegraded ? h('div', {
      style: { border: '1px solid var(--dsw-alias-state-warn-primary, #e6c473)', background: 'var(--dsw-alias-bg-layer-1, #fff9e8)', borderRadius: 10, padding: 10, marginBottom: 12, maxWidth: '100%', boxSizing: 'border-box' },
    },
      h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('catalogUnavailable')),
      catalogDetail ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #a08447)', marginTop: 2, wordBreak: 'break-word' } }, catalogDetail) : null,
      h('button', { onClick: () => { reloadCatalog() }, disabled: refreshingCatalog, style: { marginTop: 8 } }, t('retry')),
    ) : null,

    // ---- A. 智能程度路由 ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: sectionTitleStyle }, t('tierRoutingTitle')),
      h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: draft.tierRouting.enabled === true,
          onChange: (e) => setTierRouting({ enabled: e.target.checked }),
        }),
        h('span', null, t('tierRoutingTitle')),
      ),
      h('div', { style: { ...hintStyle, marginTop: 4 } }, t('tierRoutingHint')),
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' } },
        h('div', null,
          h('div', { style: labelStyle }, t('tierThresholdConcrete')),
          h('input', {
            type: 'number',
            min: 0,
            max: 1,
            step: 0.01,
            value: String(draft.tierRouting.concreteThreshold),
            'aria-label': t('tierThresholdConcrete'),
            onChange: (e) => setTierRouting({ concreteThreshold: pvNum(e.target.value, draft.tierRouting.concreteThreshold) }),
            style: { width: 96, boxSizing: 'border-box' },
          }),
        ),
        h('div', null,
          h('div', { style: labelStyle }, t('tierThresholdMedium')),
          h('input', {
            type: 'number',
            min: 0,
            max: 1,
            step: 0.01,
            value: String(draft.tierRouting.mediumThreshold),
            'aria-label': t('tierThresholdMedium'),
            onChange: (e) => setTierRouting({ mediumThreshold: pvNum(e.target.value, draft.tierRouting.mediumThreshold) }),
            style: { width: 96, boxSizing: 'border-box' },
          }),
        ),
      ),
      h('div', { style: { ...hintStyle, marginTop: 6, marginBottom: 0 } }, t('tierThresholdHint')),

      // 样例试算
      h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, #efefef)', marginTop: 10, paddingTop: 10 } },
        h('div', { style: sectionTitleStyle }, t('tierProbeTitle')),
        h('textarea', {
          value: probeText,
          placeholder: t('tierProbePlaceholder'),
          'aria-label': t('tierProbePlaceholder'),
          onChange: (e) => setProbeText(e.target.value),
          rows: 3,
          style: { display: 'block', width: '100%', boxSizing: 'border-box', minWidth: 0, marginBottom: 6 },
        }),
        h('button', { onClick: () => { runProbe() }, disabled: probeBusy }, probeBusy ? t('loading') : t('tierProbeRun')),
        probeError
          ? h('div', { role: 'alert', style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary, #c00)', marginTop: 6, wordBreak: 'break-word' } }, probeError)
          : null,
        probeResult
          ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)', marginTop: 6 } },
            t('tierProbeResult', {
              score: typeof probeResult.score === 'number' ? probeResult.score.toFixed(3) : '-',
              tier: probeResult.tier ? pvTierLabel(probeResult.tier, t) : '-',
              model: pvTripleText(probeResult.target && typeof probeResult.target === 'object' ? probeResult.target : probeResult),
            }),
            pvTierReasonText(probeResult.tierReason, t) ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, pvTierReasonText(probeResult.tierReason, t)) : null,
            pvCostReasonText(probeResult.costReason, t) ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, pvCostReasonText(probeResult.costReason, t)) : null,
            Array.isArray(probeResult.features) && probeResult.features.length > 0
              ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)', wordBreak: 'break-word' } },
                t('tierProbeFeatures') + ': ' + probeResult.features.map((f) => pvFeatureText(f, t)).join(', '))
              : null,
          )
          : null,
      ),
    ),

    // ---- B. 三档模型 ----
    h('div', { style: { ...sectionTitleStyle, marginBottom: 8 } }, t('targetsTitle')),
    PV_TIERS.map((tier) => h(StrategyEditor, {
      key: tier,
      tier,
      target: targets[tier],
      effective: resolved[tier],
      shared: pvIsShared(draft, tier),
      providers,
      models,
      modelsLoading,
      modelsError,
      onNeedModels: fetchModels,
      onChange: (next) => setTier(tier, next),
      onShareChange: (shared) => setShare(tier, shared),
      t,
      narrow,
    })),

    // ---- C. 峰谷与节假日 ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: sectionTitleStyle }, t('holidaysTitle')),
      h('div', { style: hintStyle }, t('holidaysHint')),
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
        h('div', null,
          h('div', { style: labelStyle }, t('utcOffsetLabel')),
          h('input', {
            type: 'number',
            min: -840,
            max: 840,
            step: 15,
            value: String(draft.utcOffsetMinutes),
            'aria-label': t('utcOffsetLabel'),
            onChange: (e) => updateConfig({ ...draft, utcOffsetMinutes: pvNum(e.target.value, draft.utcOffsetMinutes) }),
            style: { width: 120, boxSizing: 'border-box' },
          }),
        ),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('utcOffsetHint')),
      ),
      h(PvHolidayEditor, {
        holidays: draft.holidays,
        input: holidayInput,
        year: selectedHolidayYear,
        onInput: setHolidayInput,
        onYear: (value) => setHolidayYear(String(value)),
        onAdd: addHoliday,
        onRemove: (year, month, day) => setHolidays(draft.holidays.filter((item) => !(item[0] === year && item[1] === month && item[2] === day))),
        onImport: importHolidayYear,
        t,
      }),
    ),

    // ---- D. 高级模型支援（max） ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: sectionTitleStyle }, t('advancedTitle')),
      h('div', { style: hintStyle }, t('advancedHint')),
      h(ModelPicker, {
        label: t('advancedTitle'),
        value: draft.advancedSupport,
        providers,
        models,
        modelsLoading: modelsLoading[draft.advancedSupport.provider],
        modelsError: modelsError[draft.advancedSupport.provider],
        onNeedModels: fetchModels,
        onChange: setAdvanced,
        t,
        narrow,
      }),
    ),

    // ---- E. 诊断 ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('button', {
          onClick: () => { reloadCatalog() },
          disabled: refreshingCatalog,
          'aria-busy': refreshingCatalog,
        }, refreshingCatalog ? t('refreshingModels') : t('refreshModels')),
      ),
      h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, #efefef)', marginTop: 10, paddingTop: 10 } },
        h('div', { style: sectionTitleStyle }, t('restoreTitle')),
        h('div', { style: hintStyle }, t('restoreHint')),
        restorable.length === 0
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('restoreMissing'))
          : h('div', null,
            restorable.map((id) => {
              const detail = sessionDetails[id] || {}
              return h('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, lineHeight: '20px', marginBottom: 4 } },
                h('span', { style: { fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary, #555)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(id)),
                h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #888)' } }, pvTripleText(detail.restore)),
                h('button', { onClick: () => { restoreSession(id) }, disabled: restoring !== '' }, t('restoreOne')),
              )
            }),
            h('button', { onClick: () => { restoreAll(restorable) }, disabled: restoring !== '' }, t('restoreAll')),
          ),
      ),
      recentList.length > 0
        ? h('details', { style: { marginTop: 10 } },
          h('summary', { style: { fontSize: 12, lineHeight: '18px', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #555)' } }, t('recentDecisions')),
          recentList.slice(0, 20).map((decision, i) => h('div', { key: i, style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)', wordBreak: 'break-word' } },
            [
              decision && decision.tier ? pvTierLabel(decision.tier, t) : '',
              decision && decision.outcome ? pvOutcomeText(decision.outcome, t) : '',
              decision && decision.target ? pvTripleText(decision.target) : '',
              decision && decision.costReason ? pvCostReasonText(decision.costReason, t) : '',
            ].filter((part) => part !== '').join(' · '))),
        )
        : null,
    ),

    // ---- 保存 / 重新加载 ----
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('button', { onClick: () => { save(false) }, disabled: saving, style: { fontWeight: 600 } }, saving ? t('saving') : t('save')),
      h('button', { onClick: () => { load() }, disabled: saving }, t('reloadConfig')),
      saveError
        ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: 12, lineHeight: '18px', minWidth: 0, wordBreak: 'break-word' } }, t('saveFailed', { detail: pvSaveErrorText(saveError, t) }))
        : toast
          ? h('div', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-state-success-primary, #16794c)', fontSize: 12, lineHeight: '18px', fontWeight: 600 } }, toast)
          : (savedAt
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 12, lineHeight: '18px' } }, t('saved', { time: savedAt }))
            : null),
    ),
  )
}

// providers RPC 的返回：接受 { providers:[...] } 或裸数组，按 id 去重。
// （放在文件末尾也可：函数声明会提升，渲染时一定可用。）
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
