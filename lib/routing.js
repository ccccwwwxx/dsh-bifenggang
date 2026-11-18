// dsh-peak-valley-router — pure routing core (config schema v2 + cost decision).
//
// 本文件只有纯函数：不读文件、不碰 host、不发请求、不 select。这样路由语义能被
// 单测和差分测试直接钉住，host 侧（lib/index.js）只负责「什么时候 select 哪个目标」。
// 契约来源：docs/ROUTING_V2_DESIGN.md §2（schema/迁移）与 §3（成本决策）。
//
// canonical v2:
//   {
//     schemaVersion: 2, revision, utcOffsetMinutes, holidays: [[y,m,d]],
//     tierRouting: { enabled, concreteThreshold, mediumThreshold },
//     targets: {
//       low:  { valley: triple, costRouting: boolean, peak: peakTable },
//       mid:  { ...table } | { share: 'low' },
//       high: { ...table } | { share: 'low' },
//     },
//     advancedSupport: triple,
//     legacy?: { strategies, advancedSupport, migratedAt }   // v1 只读快照
//   }
//
// triple = { provider, model, reasoningEffort? }
// peakTable = { enabled, weekdays:[1..7], windows:[[HH:MM,HH:MM]], provider, model, reasoningEffort? }
//
// 0.15 的 v1 形状（strategies + advancedSupport）只在**读取**时于内存迁移成 v2，
// 不写盘；只有用户保存（set）才写 v2 并备份原文件（§2.4）。

import { DEFAULTS } from './text.js'

export const SCHEMA_VERSION = 2
export const TIERS = ['low', 'mid', 'high']

const DEFAULT_CONCRETE_THRESHOLD = 0.55
const DEFAULT_MEDIUM_THRESHOLD = 0.28
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]

// A configuration error carries the field path so the GUI can point at the row it
// must fix. `code` is stable for tests; `message` stays English technical text
// (the client localizes the messages it can actually produce).
export class ConfigError extends Error {
  constructor(code, path, message) {
    super(`dsh-peak-valley-router: ${message}`)
    this.name = 'ConfigError'
    this.code = code
    this.path = path
  }
}

// ---------- small normalizers ----------

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneTriple(triple) {
  const out = { provider: triple.provider, model: triple.model }
  if (triple.reasoningEffort !== undefined) out.reasoningEffort = triple.reasoningEffort
  return out
}

function clonePeak(peak) {
  return {
    enabled: peak.enabled === true,
    weekdays: [...(peak.weekdays ?? [])],
    windows: (peak.windows ?? []).map(([start, end]) => [start, end]),
    ...cloneTriple(peak),
  }
}

function cloneTable(table) {
  return {
    valley: cloneTriple(table.valley),
    costRouting: table.costRouting === true,
    peak: clonePeak(table.peak),
  }
}

// The peak (secondary) target is stored FLAT — { provider, model, reasoningEffort }
// — because that is what the settings client renders from `peak.provider` /
// `peak.model`. An earlier revision wrote it NESTED as `peak.model = {...}`; that
// round-trip silently blanked the picker and collapsed the peak onto the primary
// on the next save. Both layouts are still ACCEPTED on input; the output is flat.
function peakModelSource(peak) {
  if (typeof peak.provider === 'string' || typeof peak.model === 'string') return peak
  if (isPlainObject(peak.model)) return peak.model
  return peak
}

// A model triple. `fallback` supplies the WHOLE triple when the input leaves the
// field out (v1 migration, a peak table that inherits its valley target). When an
// explicit object is supplied it must name both provider and model: silently
// inheriting one of them would let a half-edited GUI row look valid. The optional
// reasoning effort may still inherit from `fallback` (`inheritEffort`) — that is
// the v1 contract for the peak target and for an explicit advancedSupport.
function normalizeTriple(value, fallback, path, { inheritMissing = false, inheritEffort = inheritMissing } = {}) {
  const f = fallback ?? {}
  if (value === undefined || value === null) {
    if (!f.provider || !f.model) throw new ConfigError('missing-model', path, `${path} needs a provider and model`)
    return cloneTriple(f)
  }
  if (!isPlainObject(value)) throw new ConfigError('type', path, `${path} must be an object`)
  const provider = nonEmptyString(value.provider) ?? (inheritMissing ? f.provider : undefined)
  const model = nonEmptyString(value.model) ?? (inheritMissing ? f.model : undefined)
  if (!provider || !model) throw new ConfigError('missing-model', path, `${path} needs a provider and model`)
  const rawEffort = value.reasoningEffort
  const reasoningEffort = rawEffort === undefined || rawEffort === null || rawEffort === ''
    ? (rawEffort === undefined && inheritEffort ? f.reasoningEffort : undefined)
    : String(rawEffort)
  const out = { provider, model }
  if (reasoningEffort !== undefined) out.reasoningEffort = reasoningEffort
  return out
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map((n) => Number(n))
  return h * 60 + m
}

function isClock(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) return false
  const hours = Number(m[1])
  const minutes = Number(m[2])
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
}

// Peak windows: `[[start, end], ...]` with `start < end` — cross-midnight windows
// are rejected on purpose (v1 semantics; split them into two windows instead of
// guessing which weekday the tail belongs to). Boundary rule: start included,
// end excluded, so 12:00 is NOT inside 09:00-12:00.
function parseWindows(value, path) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ConfigError('type', `${path}`, `${path} must be a list of [start, end] windows`)
  return value.map((window, index) => {
    if (!Array.isArray(window) || window.length !== 2) {
      throw new ConfigError('window', `${path}[${index}]`, `${path}[${index}] must be a [start, end] pair`)
    }
    const [start, end] = window
    if (!isClock(start) || !isClock(end)) {
      throw new ConfigError('window', `${path}[${index}]`, `${path}[${index}] must use HH:MM times`)
    }
    if (minutesOf(start) >= minutesOf(end)) {
      throw new ConfigError('window', `${path}[${index}]`, `${path}[${index}] must start before it ends (cross-midnight windows are not supported)`)
    }
    return [start, end]
  })
}

function parseWeekdays(value, path) {
  if (value === undefined || value === null) return [...DEFAULT_WEEKDAYS]
  if (!Array.isArray(value)) throw new ConfigError('type', path, `${path} must be a list of weekdays 1..7`)
  if (value.length === 0) return []
  const days = new Set()
  for (const entry of value) {
    const day = Number(entry)
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new ConfigError('weekday', path, `${path} must contain integers 1..7 (1=Monday)`)
    }
    days.add(day)
  }
  return [...days].sort((a, b) => a - b)
}

function parseHolidays(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ConfigError('type', 'holidays', 'holidays must be a list of [year, month, day]')
  const seen = new Set()
  const out = []
  value.forEach((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new ConfigError('holiday', `holidays[${index}]`, `holidays[${index}] must be [year, month, day]`)
    }
    const [year, month, day] = entry.map(Number)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new ConfigError('holiday', `holidays[${index}]`, `holidays[${index}] year must be between 2000 and 2100`)
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new ConfigError('holiday', `holidays[${index}]`, `holidays[${index}] month must be between 1 and 12`)
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new ConfigError('holiday', `holidays[${index}]`, `holidays[${index}] day must be between 1 and 31`)
    }
    const key = `${year}-${month}-${day}`
    if (seen.has(key)) return
    seen.add(key)
    out.push([year, month, day])
  })
  return out.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]))
}

function normalizePeak(value, fallback, path) {
  const f = fallback ?? {}
  const raw = value === undefined || value === null ? {} : value
  if (!isPlainObject(raw)) throw new ConfigError('type', path, `${path} must be an object`)
  const windows = parseWindows(raw.windows ?? f.windows, `${path}.windows`)
  const weekdays = parseWeekdays(raw.weekdays ?? f.weekdays, `${path}.weekdays`)
  const triple = normalizeTriple(peakModelSource(raw), f.triple ?? fallbackTripleOf(f), path, { inheritMissing: true })
  // `enabled` with no windows can never fire; normalizing it down keeps the GUI
  // honest ("on" must mean something) and matches v1's normalizeStrategy.
  const enabledRaw = raw.enabled === undefined ? f.enabled === true : raw.enabled === true
  const enabled = enabledRaw && windows.length > 0
  return { enabled, weekdays, windows, ...triple }
}

function fallbackTripleOf(peakFallback) {
  if (!peakFallback || !peakFallback.provider || !peakFallback.model) return undefined
  return { provider: peakFallback.provider, model: peakFallback.model, reasoningEffort: peakFallback.reasoningEffort }
}

function normalizeTable(value, path, fallbacks = {}) {
  const raw = value === undefined || value === null ? {} : value
  if (!isPlainObject(raw)) throw new ConfigError('type', path, `${path} must be an object`)
  const valley = normalizeTriple(raw.valley, fallbacks.valley, `${path}.valley`)
  const costRouting = raw.costRouting === undefined
    ? fallbacks.costRouting !== false
    : raw.costRouting === true
  // The peak target inherits THIS table's valley (not the shipped defaults): an
  // omitted peak must never point at another table's model. Only its
  // enabled/weekdays/windows layout may fall back to the defaults.
  const peakFallback = fallbacks.peak
    ? { enabled: fallbacks.peak.enabled, weekdays: fallbacks.peak.weekdays, windows: fallbacks.peak.windows, triple: valley }
    : { triple: valley }
  const peak = normalizePeak(raw.peak, peakFallback, `${path}.peak`)
  return { valley, costRouting, peak }
}

function normalizeTierTarget(value, tier, fallbacks) {
  const path = `targets.${tier}`
  if (value === undefined || value === null) {
    if (tier === 'low') throw new ConfigError('missing-target', path, `${path} is required`)
    return { share: 'low' }
  }
  if (!isPlainObject(value)) throw new ConfigError('type', path, `${path} must be an object`)
  if (value.share !== undefined && value.share !== null) {
    if (tier === 'low') throw new ConfigError('share', path, `${path} cannot share another tier`)
    if (value.share !== 'low') throw new ConfigError('share', path, `${path}.share only supports "low"`)
    // A shared tier keeps nothing else: the resolved table always comes from low,
    // so silently keeping half-edited fields would make the GUI lie about what is
    // in force. Normalizing them away is deterministic and round-trips cleanly.
    return { share: 'low' }
  }
  if (tier === 'low') return normalizeTable(value, path, fallbacks.low)
  return normalizeTable(value, path, fallbacks[tier] ?? fallbacks.mid ?? fallbacks.low)
}

// ---------- v2 normalization ----------

function normalizeTierRouting(value) {
  const raw = value === undefined || value === null ? {} : value
  if (!isPlainObject(raw)) throw new ConfigError('type', 'tierRouting', 'tierRouting must be an object')
  const enabled = raw.enabled === true
  const concreteThreshold = raw.concreteThreshold === undefined ? DEFAULT_CONCRETE_THRESHOLD : Number(raw.concreteThreshold)
  const mediumThreshold = raw.mediumThreshold === undefined ? DEFAULT_MEDIUM_THRESHOLD : Number(raw.mediumThreshold)
  for (const [label, threshold] of [['concreteThreshold', concreteThreshold], ['mediumThreshold', mediumThreshold]]) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new ConfigError('threshold', `tierRouting.${label}`, `tierRouting.${label} must be a number between 0 and 1`)
    }
  }
  if (!(concreteThreshold > mediumThreshold)) {
    throw new ConfigError('threshold-order', 'tierRouting', 'tierRouting.concreteThreshold must be greater than tierRouting.mediumThreshold')
  }
  return { enabled, concreteThreshold, mediumThreshold }
}

function normalizeAdvancedSupport(value) {
  const raw = value !== undefined && value !== null ? value : DEFAULTS.advancedSupport
  // An explicitly supplied advancedSupport keeps the optional reasoning effort
  // from DEFAULTS (v1 contract), while a missing one falls back entirely.
  return normalizeTriple(raw, DEFAULTS.advancedSupport, 'advancedSupport', { inheritEffort: true })
}

function normalizeV2(cfg) {
  const utcOffsetMinutes = cfg.utcOffsetMinutes === undefined || cfg.utcOffsetMinutes === null
    ? DEFAULTS.utcOffsetMinutes
    : Number(cfg.utcOffsetMinutes)
  if (!Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes < -840 || utcOffsetMinutes > 840) {
    throw new ConfigError('timezone', 'utcOffsetMinutes', 'utcOffsetMinutes must be an integer between -840 and 840')
  }
  const revision = Number.isInteger(cfg.revision) && cfg.revision >= 0 ? cfg.revision : 1
  const out = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    utcOffsetMinutes,
    holidays: parseHolidays(cfg.holidays),
    tierRouting: normalizeTierRouting(cfg.tierRouting),
    targets: {
      low: normalizeTierTarget(cfg.targets?.low, 'low', { low: DEFAULTS.targets.low }),
      mid: normalizeTierTarget(cfg.targets?.mid, 'mid', { low: DEFAULTS.targets.low }),
      high: normalizeTierTarget(cfg.targets?.high, 'high', { low: DEFAULTS.targets.low }),
    },
    advancedSupport: normalizeAdvancedSupport(cfg.advancedSupport),
  }
  if (isPlainObject(cfg.legacy)) out.legacy = cfg.legacy
  return out
}

// ---------- v1 -> v2 migration (in memory only; §2.4) ----------

function normalizeStrategyV1(value) {
  if (!isPlainObject(value)) return null
  const primary = normalizeModelV1(value.primary, {})
  if (!primary.provider || !primary.model) return null
  const peak = isPlainObject(value.peak) ? value.peak : {}
  const peakWindows = parseWindowsFallback(peak.windows)
  const peakModel = normalizeModelV1(peakModelSource(peak), primary)
  const weekdays = (Array.isArray(value.weekdays) && value.weekdays.length
    ? value.weekdays.map(Number)
    : [...DEFAULT_WEEKDAYS]).filter((n) => n >= 1 && n <= 7)
  return {
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : '',
    weekdays,
    primary,
    peak: {
      enabled: peak.enabled === true && peakWindows.length > 0,
      windows: peakWindows,
      provider: peakModel.provider,
      model: peakModel.model,
      reasoningEffort: peakModel.reasoningEffort,
    },
  }
}

// v1 tolerated malformed windows by dropping them; migration must not start
// throwing on a policy.json that 0.15 accepted, or an upgrade would silently
// reset the user's policy to DEFAULTS.
function parseWindowsFallback(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((w) => Array.isArray(w) && w.length === 2)
    .map((w) => [String(w[0]), String(w[1])])
    .filter(([s, e]) => isClock(s) && isClock(e) && minutesOf(s) < minutesOf(e))
}

function normalizeModelV1(value, fallback) {
  const f = fallback || {}
  if (!isPlainObject(value)) {
    return { provider: f.provider, model: f.model, reasoningEffort: f.reasoningEffort }
  }
  return {
    provider: nonEmptyString(value.provider) ?? f.provider,
    model: nonEmptyString(value.model) ?? f.model,
    reasoningEffort: typeof value.reasoningEffort === 'string' && value.reasoningEffort
      ? value.reasoningEffort
      : f.reasoningEffort,
  }
}

function describeStrategyIssue(value) {
  if (!isPlainObject(value)) return 'is not a strategy object'
  const primary = isPlainObject(value.primary) ? value.primary : {}
  const missing = []
  if (typeof primary.provider !== 'string' || !primary.provider) missing.push('a primary provider')
  if (typeof primary.model !== 'string' || !primary.model) missing.push('a primary model')
  return missing.length > 0 ? `needs ${missing.join(' and ')}` : 'has an invalid primary model'
}

function normalizeAdvancedSupportV1(raw) {
  const explicit = raw !== undefined && raw !== null
  return normalizeModelV1(raw, explicit ? { reasoningEffort: DEFAULTS.advancedSupport?.reasoningEffort } : DEFAULTS.advancedSupport)
}

export function migrateV1(cfg) {
  const raw = cfg ?? {}
  const rawStrategies = Array.isArray(raw.strategies) ? raw.strategies : []
  const strategies = []
  const dropped = []
  rawStrategies.forEach((value, index) => {
    const normalized = normalizeStrategyV1(value)
    if (normalized) strategies.push(normalized)
    else dropped.push({ index, issue: describeStrategyIssue(value) })
  })
  if (dropped.length > 0) {
    const details = dropped.slice(0, 3).map(({ index, issue }) => `strategy #${index + 1} ${issue}`).join('; ')
    const rest = dropped.length > 3 ? ` (+${dropped.length - 3} more)` : ''
    throw new ConfigError('strategy', 'strategies', `${details}${rest} — every strategy needs primary.provider and primary.model`)
  }
  const rawAdvancedSupport = raw.advancedSupport ?? raw.exclusive
  const advancedSupport = normalizeAdvancedSupportV1(rawAdvancedSupport)
  if (strategies.length > 0 && (!advancedSupport.provider || !advancedSupport.model)) {
    throw new ConfigError('advanced-support', 'advancedSupport', 'advanced model support (高级模型支援) is required when strategies are configured')
  }

  const source = strategies[0] ?? {
    // v1 with no strategies was the "advanced-only" policy: advancedSupport was
    // the only configured target. Keeping it as the low valley preserves what the
    // user actually had configured instead of silently resetting to DEFAULTS.
    primary: advancedSupport,
    weekdays: [...DEFAULT_WEEKDAYS],
    peak: { enabled: false, windows: [] },
  }
  const low = {
    valley: source.primary,
    costRouting: true,
    peak: {
      enabled: source.peak.enabled,
      weekdays: source.weekdays,
      windows: source.peak.windows,
      provider: source.peak.provider,
      model: source.peak.model,
      reasoningEffort: source.peak.reasoningEffort,
    },
  }
  const high = {
    valley: advancedSupport,
    costRouting: true,
    peak: {
      enabled: false,
      weekdays: source.weekdays,
      windows: source.peak.windows,
      provider: advancedSupport.provider,
      model: advancedSupport.model,
      reasoningEffort: advancedSupport.reasoningEffort,
    },
  }
  return normalizeV2({
    utcOffsetMinutes: raw.utcOffsetMinutes,
    holidays: raw.holidays,
    revision: raw.revision,
    tierRouting: { enabled: false },
    targets: { low, mid: { share: 'low' }, high },
    advancedSupport,
    legacy: {
      strategies: rawStrategies,
      advancedSupport: rawAdvancedSupport,
      migratedAt: new Date().toISOString(),
    },
  })
}

// ---------- public config entry point ----------

export function isV1Config(input) {
  return isPlainObject(input)
    && input.targets === undefined
    && (input.strategies !== undefined || input.advancedSupport !== undefined || input.exclusive !== undefined)
}

// Deterministic: the same input always produces byte-identical canonical output
// (required by the GUI round-trip and by the migration differential test).
// `set` throws on bad input so the GUI can show the field; loading catches and
// falls back to DEFAULTS (existing behavior).
export function normalizeConfig(config) {
  if (config === undefined || config === null) return normalizeV2(DEFAULTS)
  if (!isPlainObject(config)) {
    throw new ConfigError('type', 'config', 'config must be an object')
  }
  if (isV1Config(config)) return migrateV1(config)
  if (config.targets === undefined) return normalizeV2(DEFAULTS)
  return normalizeV2(config)
}

// Resolve `{share:'low'}` against the low table. Always deep-copies, so a caller
// cannot mutate the normalized config through a resolved table.
export function resolveTargets(cfg) {
  const c = ensureConfig(cfg)
  const low = cloneTable(c.targets.low)
  const resolve = (tier) => {
    const target = c.targets[tier]
    if (tier !== 'low' && target && target.share === 'low') return cloneTable(low)
    return cloneTable(target)
  }
  return { low, mid: resolve('mid'), high: resolve('high') }
}

function ensureConfig(cfg) {
  if (isPlainObject(cfg) && cfg.schemaVersion === SCHEMA_VERSION && cfg.targets) return cfg
  return normalizeConfig(cfg)
}

// ---------- time ----------

// Shift UTC by the configured offset and read the UTC fields — the v1 approach,
// kept verbatim so the migration differential test can compare instants exactly.
// It deliberately does NOT use the system timezone: the policy carries its own.
export function localParts(date, utcOffsetMinutes) {
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: ((shifted.getUTCDay() + 6) % 7) + 1, // 1=Mon..7=Sun
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

export function timeInWindows(minutes, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  return windows.some(([s, e]) => minutes >= minutesOf(s) && minutes < minutesOf(e))
}

export function isHoliday(year, month, day, holidays) {
  if (!Array.isArray(holidays)) return false
  return holidays.some(([y, m, d]) => y === year && m === month && d === day)
}

// ---------- tier + cost decision (§3.1) ----------

// Cost decision for ONE tier's table. The order is the contract: cost-off before
// peak-disabled, weekday before holiday before window. Tests assert this order.
export function resolveCost(date, table, cfg, parts) {
  const local = parts ?? localParts(date, cfg.utcOffsetMinutes)
  const valley = cloneTriple(table.valley)
  const base = {
    weekday: local.weekday,
    holiday: isHoliday(local.year, local.month, local.day, cfg.holidays),
    minutes: local.minutes,
    year: local.year,
    month: local.month,
    day: local.day,
  }
  if (table.costRouting !== true) return { target: valley, costReason: 'cost-off', ...base }
  if (table.peak?.enabled !== true) return { target: valley, costReason: 'peak-disabled', ...base }
  if (!Array.isArray(table.peak.weekdays) || !table.peak.weekdays.includes(local.weekday)) {
    return { target: valley, costReason: 'peak-weekday', ...base }
  }
  if (base.holiday) return { target: valley, costReason: 'peak-holiday', ...base }
  if (!timeInWindows(local.minutes, table.peak.windows)) return { target: valley, costReason: 'peak-outside', ...base }
  return { target: cloneTriple(table.peak), costReason: 'peak', ...base }
}

function tierFromOptions(cfg, options) {
  // `forceTier` is the probe/trial-run escape hatch: the settings page must be
  // able to show what a tier WOULD route to even while tier routing is off.
  // Real routing never passes it, so a disabled switch always means low.
  if (!cfg.tierRouting.enabled && options?.forceTier !== true) return { tier: 'low', tierReason: 'tier-disabled' }
  const tier = options?.tier
  if (TIERS.includes(tier)) {
    return { tier, tierReason: typeof options?.tierReason === 'string' && options.tierReason ? options.tierReason : `tier-${tier}` }
  }
  // No classifier verdict (t6 supplies one). A missing/unknown verdict is a
  // classification failure, which §4.3 says must fall back to low — never guess.
  return { tier: 'low', tierReason: 'tier-fallback-low' }
}

// The single decision function. `baseline` is the selection the session had
// before the plugin stepped in ({ provider, model, reasoningEffort? }), used only
// for the max-effort axis (§4.5). Returns the target plus WHY, for logs and GUI.
export function decide(date, cfg, options = {}) {
  const c = ensureConfig(cfg)
  const local = localParts(date, c.utcOffsetMinutes)
  const tierInfo = tierFromOptions(c, options)
  const tiers = resolveTargets(c)
  const advanced = c.advancedSupport
  const context = {
    weekday: local.weekday,
    holiday: isHoliday(local.year, local.month, local.day, c.holidays),
    minutes: local.minutes,
    year: local.year,
    month: local.month,
    day: local.day,
  }
  const advancedForMax = advanced.provider && advanced.model ? cloneTriple(advanced) : null

  if (options.baseline && options.baseline.reasoningEffort === 'max' && advancedForMax) {
    // max 轴优先级最高：它既不参与分级，也不参与峰谷（§4.5）。advancedSupport
    // 永远是独立的 max 轴，不是「周末/无方案」的兜底。
    return {
      axis: 'max',
      tier: tierInfo.tier,
      tierReason: 'max-advanced',
      costReason: null,
      target: advancedForMax,
      selection: advancedForMax,
      reason: 'advanced-max',
      strategyIndex: null,
      advancedForMax,
      ...context,
    }
  }
  const cost = resolveCost(date, tiers[tierInfo.tier], c, local)
  return {
    axis: 'tier',
    tier: tierInfo.tier,
    tierReason: tierInfo.tierReason,
    costReason: cost.costReason,
    target: cost.target,
    selection: cost.target,
    // Legacy reason used by the 0.15 client/settings line; the fine-grained WHY
    // lives in costReason. Kept stable so an older client still renders.
    reason: cost.costReason === 'peak' ? 'peak' : 'primary',
    strategyIndex: null,
    advancedForMax,
    ...context,
  }
}

// Backwards-compatible resolution helpers. `resolveSelectionDetailed(date, cfg,
// { tier })` is the cost/tier layer; `decide` adds the max axis.
export function resolveSelectionDetailed(date, cfg, options = {}) {
  return decide(date, cfg, options)
}

export function resolveSelection(date, cfg, options = {}) {
  return decide(date, cfg, options).selection
}

export function selectFor(date, config, options = {}) {
  return resolveSelection(date, normalizeConfig(config), options)
}

// The ONLY allowed diversion (§1.4 / §12 item 8): a high/mid target that is
// genuinely unavailable falls back to low.valley. Returns the candidate target
// (validity is the host's to check against the live catalog), or null when the
// decision must keep the current model instead.
export function fallbackSelection(cfg, decision) {
  if (!decision || decision.axis !== 'tier' || decision.tier === 'low') return null
  return cloneTriple(resolveTargets(ensureConfig(cfg)).low.valley)
}
