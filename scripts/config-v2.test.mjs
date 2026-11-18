// Config schema v2: normalization, validation and the tier/cost resolution.
//
// Replaces the old roundtrip.test.mjs (v1 `strategies[0].peak` shape): the v1
// shape is now a MIGRATION input (see migrate-v1.test.mjs) while the live shape
// is `targets.low/mid/high` + `tierRouting` (docs/ROUTING_V2_DESIGN.md §2).
// Run: node scripts/config-v2.test.mjs
import { DEFAULTS } from '../lib/text.js'
import {
  normalizeConfig,
  normalizeConfigDetailed,
  isValidHoliday,
  clampUtcOffset,
  resolveTargets,
  decide,
  ConfigError,
  SCHEMA_VERSION,
} from '../lib/routing.js'

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const throws = (fn, code, label) => {
  try {
    fn()
  } catch (error) {
    if (!(error instanceof ConfigError)) throw new Error(`${label}: expected ConfigError, got ${error?.name}: ${error?.message}`)
    if (code && error.code !== code) throw new Error(`${label}: expected code ${code}, got ${error.code}`)
    return error
  }
  throw new Error(`${label}: expected a ConfigError, nothing was thrown`)
}
const at = (date, cfg) => decide(date, cfg)
const iso = (s) => new Date(s)

// ---------- shipped defaults ----------

check('DEFAULTS normalize to a complete v2 config (three tiers, costRouting on, tiers off)', () => {
  const cfg = normalizeConfig(DEFAULTS)
  eq(cfg.schemaVersion, SCHEMA_VERSION, 'schemaVersion')
  eq(Object.keys(cfg.targets).sort(), ['high', 'low', 'mid'], 'targets keys')
  eq(cfg.targets.mid, { share: 'low' }, 'mid shares low')
  eq(cfg.targets.high, { share: 'low' }, 'high shares low')
  eq(cfg.tierRouting, { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 }, 'tierRouting defaults')
  eq(cfg.targets.low.costRouting, true, 'cost routing is on by default')
  eq(cfg.targets.low.peak.enabled, false, 'peak switching is off by default')
  if (cfg.advancedSupport.provider !== 'deepseek-official' || cfg.advancedSupport.model !== 'deepseek-flash') {
    throw new Error(`fail-safe advancedSupport expected, got ${JSON.stringify(cfg.advancedSupport)}`)
  }
  eq(cfg.targets.low.valley, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }, 'low valley')
})

check('normalizeConfig is idempotent (canonical in -> identical canonical out)', () => {
  const once = normalizeConfig(DEFAULTS)
  const twice = normalizeConfig(once)
  eq(twice, once, 'idempotence')
})

check('normalizeConfig(undefined) equals normalizeConfig(DEFAULTS)', () => {
  eq(normalizeConfig(undefined), normalizeConfig(DEFAULTS), 'undefined -> DEFAULTS')
})

check('the peak model is stored FLAT (the picker reads peak.provider/peak.model)', () => {
  const cfg = normalizeConfig({
    targets: {
      low: {
        valley: { provider: 'deepseek-official', model: 'deepseek-flash' },
        costRouting: true,
        peak: { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00']], provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
      },
      mid: { share: 'low' },
      high: { share: 'low' },
    },
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  const peak = cfg.targets.low.peak
  if (typeof peak.provider !== 'string' || !peak.provider) throw new Error('peak.provider must be a flat string')
  if (typeof peak.model !== 'string' || !peak.model) throw new Error('peak.model must be a flat string')
  eq({ provider: peak.provider, model: peak.model, reasoningEffort: peak.reasoningEffort }, { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }, 'flat peak')
})

check('legacy nested peak.model is still accepted and normalized flat', () => {
  // The exact shape a 0.12-era policy.json may still carry on disk.
  const cfg = normalizeConfig({
    targets: {
      low: {
        valley: { provider: 'deepseek-official', model: 'deepseek-flash' },
        costRouting: true,
        peak: { enabled: true, weekdays: [1], windows: [['09:00', '12:00']], model: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } },
      },
      mid: { share: 'low' },
      high: { share: 'low' },
    },
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  eq(cfg.targets.low.peak, { enabled: true, weekdays: [1], windows: [['09:00', '12:00']], provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }, 'nested peak')
})

check('an omitted peak inherits the valley target and stays disabled', () => {
  const cfg = normalizeConfig({
    targets: {
      low: { valley: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' }, costRouting: true },
      mid: { share: 'low' },
      high: { share: 'low' },
    },
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  eq(cfg.targets.low.peak.provider, 'deepseek-official', 'peak inherits the valley provider')
  eq(cfg.targets.low.peak.model, 'deepseek-chat', 'peak inherits the valley model')
  eq(cfg.targets.low.peak.enabled, false, 'inherited peak stays disabled')
  eq(cfg.targets.low.costRouting, true, 'costRouting defaults on')
})

check('an explicit v2 advancedSupport keeps provider/model and inherits the effort default', () => {
  const cfg = normalizeConfig({
    targets: base().targets,
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  eq(cfg.advancedSupport, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }, 'advanced support')
})

// ---------- validation ----------

const base = () => normalizeConfig(DEFAULTS)
const withCfg = (patch) => {
  const cfg = JSON.parse(JSON.stringify(base()))
  return normalizeConfig(patch(cfg))
}

check('an invalid window (end <= start) is rejected with a field path', () => {
  const error = throws(() => withCfg((c) => {
    c.targets.low.peak = { enabled: true, weekdays: [1], windows: [['12:00', '09:00']], provider: 'p', model: 'm' }
    return c
  }), 'window', 'reversed window')
  if (!error.path || !error.path.includes('windows')) throw new Error(`path must point at windows, got ${error.path}`)
})

check('an equal start/end window and an invalid clock are rejected', () => {
  throws(() => withCfg((c) => {
    c.targets.low.peak.windows = [['09:00', '09:00']]
    c.targets.low.peak.enabled = true
    return c
  }), 'window', 'zero-length window')
  throws(() => withCfg((c) => {
    c.targets.low.peak.windows = [['25:00', '26:00']]
    return c
  }), 'window', 'invalid clock')
})

check('threshold order and range are enforced', () => {
  throws(() => withCfg((c) => { c.tierRouting.concreteThreshold = 0.2; c.tierRouting.mediumThreshold = 0.3; return c }), 'threshold-order', 'concrete < medium')
  throws(() => withCfg((c) => { c.tierRouting.concreteThreshold = 1.5; return c }), 'threshold', 'threshold > 1')
  throws(() => withCfg((c) => { c.tierRouting.mediumThreshold = -0.1; return c }), 'threshold', 'negative threshold')
})

check('weekdays, holidays and targets are validated with field paths', () => {
  throws(() => withCfg((c) => { c.targets.low.peak.weekdays = [0, 8]; return c }), 'weekday', 'weekday range')
  // An invalid holiday DATE is dropped (never fatal — one typo must not reset the
  // policy), but a non-list holidays value is still a type error.
  eq(withCfg((c) => { c.holidays = [[2026, 13, 1], [2026, 2, 30]]; return c }).holidays, [], 'invalid holiday dates are dropped')
  throws(() => withCfg((c) => { c.holidays = {}; return c }), 'type', 'holidays must be a list')
  throws(() => withCfg((c) => { c.targets.low.valley = { provider: 'p' }; return c }), 'missing-model', 'missing valley model')
  throws(() => withCfg((c) => { c.targets.low = { share: 'low' }; return c }), 'share', 'low cannot share')
  throws(() => withCfg((c) => { c.targets.mid = { share: 'high' }; return c }), 'share', 'only share low is supported')
  throws(() => withCfg((c) => { c.tierRouting = [] ; return c }), 'type', 'tierRouting object')
})

check('holiday dates must be real calendar days (leap years included)', () => {
  eq(isValidHoliday(2026, 10, 1), true, 'ordinary date')
  eq(isValidHoliday(2028, 2, 29), true, 'leap day 2028')
  eq(isValidHoliday(2027, 2, 29), false, '2027 is not a leap year')
  eq(isValidHoliday(2026, 2, 30), false, 'February 30 does not exist')
  eq(isValidHoliday(2026, 4, 31), false, 'April 31 does not exist')
  eq(isValidHoliday(2026, 13, 1), false, 'month 13')
  eq(isValidHoliday(2026, 0, 1), false, 'month 0')
  eq(isValidHoliday(2026, 1, 0), false, 'day 0')
  eq(isValidHoliday(1970, 1, 1), true, 'lower bound')
  eq(isValidHoliday(2100, 12, 31), true, 'upper bound')
  eq(isValidHoliday(1969, 12, 31), false, 'below 1970')
  eq(isValidHoliday(2101, 1, 1), false, 'above 2100')
  eq(isValidHoliday('2026', '10', '1'), true, 'numeric strings')
  eq(isValidHoliday(2026.5, 10, 1), false, 'fractional year')
  eq(isValidHoliday(2026, 10), false, 'missing day')

  const detailed = normalizeConfigDetailed({
    ...base(),
    holidays: [[2026, 10, 1], [2026, 2, 30], [1969, 12, 31], [2027, 2, 29], [2028, 2, 29], 'nope', [2026, 13, 1]],
  })
  eq(detailed.config.holidays, [[1999, 1, 1], [2026, 10, 1], [2028, 2, 29]].slice(1), 'only real dates survive')
  eq(detailed.droppedHolidays, 5, 'dropped count')
  eq(normalizeConfig({ ...base(), holidays: [[2026, 10, 1]] }).holidays, [[2026, 10, 1]], 'no drop when clean')
})

check('holidays are de-duplicated and sorted; a shared tier drops stray fields', () => {
  const cfg = normalizeConfig({
    holidays: [[2026, 10, 2], [2026, 10, 1], [2026, 10, 2], [2025, 12, 31]],
    targets: {
      low: base().targets.low,
      mid: { share: 'low', valley: { provider: 'ignored', model: 'ignored' } },
      high: { share: 'low' },
    },
    advancedSupport: base().advancedSupport,
  })
  eq(cfg.holidays, [[2025, 12, 31], [2026, 10, 1], [2026, 10, 2]], 'holiday order')
  eq(cfg.targets.mid, { share: 'low' }, 'shared tier keeps only share')
})

check('utcOffsetMinutes is clamped to the real-world range and defaults to +08:00', () => {
  eq(normalizeConfig({ targets: base().targets, advancedSupport: base().advancedSupport }).utcOffsetMinutes, 480, 'default offset')
  eq(clampUtcOffset(480), 480, 'in range')
  eq(clampUtcOffset(-720), -720, 'lower boundary')
  eq(clampUtcOffset(840), 840, 'upper boundary')
  eq(clampUtcOffset(900), 840, 'over the top clamps')
  eq(clampUtcOffset(-900), -720, 'below the bottom clamps')
  eq(clampUtcOffset(-800), -720, 'clamps upward into range')
  eq(clampUtcOffset(480.6), 481, 'rounds')
  eq(clampUtcOffset(-0.4), 0, 'rounds to zero')
  eq(clampUtcOffset('abc'), 480, 'non-numeric falls back')
  eq(clampUtcOffset(NaN), 480, 'NaN falls back')
  eq(clampUtcOffset(Infinity), 480, 'Infinity falls back')
  eq(clampUtcOffset(undefined), 480, 'undefined falls back')
  eq(withCfg((c) => { c.utcOffsetMinutes = 900; return c }).utcOffsetMinutes, 840, 'config clamps instead of throwing')
  eq(withCfg((c) => { c.utcOffsetMinutes = 'nonsense'; return c }).utcOffsetMinutes, 480, 'config falls back')
})

// ---------- effective tables ----------

check('resolveTargets resolves {share:"low"} into an independent copy of the low table', () => {
  const cfg = withCfg((c) => {
    c.targets.low.peak.enabled = true
    c.targets.low.peak.windows = [['09:00', '12:00']]
    return c
  })
  const tiers = resolveTargets(cfg)
  eq(tiers.mid, tiers.low, 'mid equals low')
  eq(tiers.high, tiers.low, 'high equals low')
  if (tiers.mid === tiers.low) throw new Error('resolved tables must be copies, not the same object')
  tiers.mid.peak.windows[0][0] = '23:00'
  eq(cfg.targets.low.peak.windows[0][0], '09:00', 'mutating a resolved table must not touch the config')
})

check('an independent mid/high table is used as-is', () => {
  const cfg = withCfg((c) => {
    c.targets.high = {
      valley: { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' },
      costRouting: false,
      peak: { enabled: false, weekdays: [1], windows: [] , provider: 'codex', model: 'gpt-6-astra' },
    }
    return c
  })
  const tiers = resolveTargets(cfg)
  eq(tiers.high.valley, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }, 'high valley')
  eq(tiers.high.costRouting, false, 'high costRouting')
  if (tiers.mid.valley.provider !== 'deepseek-official') throw new Error('mid must still share low')
})

// ---------- tier + cost decision ----------

check('tierRouting disabled always resolves to the low tier (0.15 equivalence)', () => {
  const cfg = withCfg((c) => {
    c.targets.mid = { valley: { provider: 'codex', model: 'gpt-5.6-luna' }, costRouting: true, peak: { enabled: false, weekdays: [1], windows: [], provider: 'codex', model: 'gpt-5.6-luna' } }
    c.targets.high = { valley: { provider: 'codex', model: 'gpt-6-astra' }, costRouting: true, peak: { enabled: false, weekdays: [1], windows: [], provider: 'codex', model: 'gpt-6-astra' } }
    return c
  })
  for (const tier of [undefined, 'mid', 'high']) {
    const decision = decide(iso('2026-10-14T06:00:00Z'), cfg, { tier })
    eq(decision.tier, 'low', `tier=${String(tier)} must be forced to low`)
    eq(decision.tierReason, 'tier-disabled', 'tierReason')
    eq(decision.target, cfg.targets.low.valley, 'target is the low valley')
  }
})

check('tierRouting enabled without a classifier verdict falls back to low and says so', () => {
  const cfg = withCfg((c) => { c.tierRouting.enabled = true; return c })
  const decision = decide(iso('2026-10-14T06:00:00Z'), cfg)
  eq([decision.tier, decision.tierReason], ['low', 'tier-fallback-low'], 'fallback')
})

check('tierRouting enabled with a verdict picks that tier table', () => {
  const cfg = withCfg((c) => {
    c.tierRouting.enabled = true
    c.targets.high = {
      valley: { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' },
      costRouting: true,
      peak: { enabled: true, weekdays: [1, 2, 3, 4, 5, 6, 7], windows: [['09:00', '12:00']], provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
    }
    return c
  })
  const valley = decide(iso('2026-10-14T06:00:00Z'), cfg, { tier: 'high' }) // Wed 14:00 Beijing
  eq([valley.tier, valley.tierReason, valley.costReason], ['high', 'tier-high', 'peak-outside'], 'high valley')
  eq(valley.target, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }, 'high valley target')
  const peak = decide(iso('2026-10-14T02:00:00Z'), cfg, { tier: 'high' }) // Wed 10:00 Beijing
  eq([peak.costReason, peak.target], ['peak', { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }], 'high peak target')
})

check('the max axis wins over tiers and cost, and only when the baseline asks for max', () => {
  const cfg = withCfg((c) => {
    c.tierRouting.enabled = true
    return c
  })
  const max = decide(iso('2026-10-14T02:00:00Z'), cfg, { baseline: { provider: 'x', model: 'y', reasoningEffort: 'max' }, tier: 'high' })
  eq([max.axis, max.tierReason, max.costReason], ['max', 'max-advanced', null], 'max axis')
  eq(max.target, cfg.advancedSupport, 'advanced target')
  const notMax = decide(iso('2026-10-14T02:00:00Z'), cfg, { baseline: { provider: 'x', model: 'y', reasoningEffort: 'high' }, tier: 'high' })
  eq(notMax.axis, 'tier', 'a non-max baseline stays on the tier axis')
})

check('peak window boundaries: start included, end excluded', () => {
  const cfg = withCfg((c) => {
    c.targets.low.peak.enabled = true
    c.targets.low.peak.weekdays = [1, 2, 3, 4, 5, 6, 7]
    c.targets.low.peak.windows = [['09:00', '12:00']]
    return c
  })
  // All instants below are Beijing local time (UTC+8) on Wed 2026-10-14.
  const reason = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number)
    const utc = new Date(Date.UTC(2026, 9, 14, h - 8, m))
    return decide(utc, cfg).costReason
  }
  eq(reason('08:59'), 'peak-outside', '08:59 is outside')
  eq(reason('09:00'), 'peak', '09:00 is inside (start inclusive)')
  eq(reason('11:59'), 'peak', '11:59 is inside')
  eq(reason('12:00'), 'peak-outside', '12:00 is outside (end exclusive)')
})

check('holidays only suppress the peak branch; a weekday holiday is peak-holiday', () => {
  const cfg = withCfg((c) => {
    c.holidays = [[2026, 10, 14]]
    c.targets.low.peak.enabled = true
    c.targets.low.peak.weekdays = [1, 2, 3, 4, 5, 6, 7]
    c.targets.low.peak.windows = [['09:00', '12:00']]
    return c
  })
  const decision = decide(iso('2026-10-14T02:00:00Z'), cfg) // Wed 10:00 Beijing
  eq([decision.costReason, decision.holiday], ['peak-holiday', true], 'holiday suppresses peak')
  eq(decision.target, cfg.targets.low.valley, 'holiday uses the valley target')
})

check('every branch reports WHY (legacy reason + costReason)', () => {
  const cfg = withCfg((c) => {
    c.targets.low.peak.enabled = true
    c.targets.low.peak.weekdays = [1, 2, 3, 4, 5]
    c.targets.low.peak.windows = [['09:00', '12:00']]
    return c
  })
  eq(decide(iso('2026-10-14T02:00:00Z'), cfg).reason, 'peak', 'peak reason')
  eq(decide(iso('2026-10-14T06:00:00Z'), cfg).reason, 'primary', 'valley reason')
  eq(decide(iso('2026-10-17T02:00:00Z'), cfg).reason, 'primary', 'weekend reason (no advanced escalation)')
  eq(decide(iso('2026-10-17T02:00:00Z'), cfg).target, cfg.targets.low.valley, 'weekend stays on low.valley')
})

for (const [name, fn] of checks) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
console.log(failures === 0 ? 'config-v2: 全部通过' : `config-v2: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
