// Cost-decision routing (§3): six costReason values, their fixed priority, the
// window boundary rule (start included, end excluded), per-tier tables/switches
// and the shared holiday calendar.
// Run: node scripts/cost-routing.test.mjs
import { normalizeConfig, resolveTargets, decide } from '../lib/routing.js'
import { DEFAULTS } from '../lib/text.js'

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}

const PEAK = { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }
const VALLEY = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const ALT = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }

// Build a canonical config with one explicit low table; mid/high share it unless
// a test overrides them.
function config(low = {}, extra = {}) {
  return normalizeConfig({
    utcOffsetMinutes: 480,
    holidays: [],
    tierRouting: { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 },
    targets: {
      low: {
        valley: VALLEY,
        costRouting: true,
        peak: { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00'], ['14:00', '18:00']], ...PEAK },
        ...low,
      },
      mid: { share: 'low' },
      high: { share: 'low' },
    },
    advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    ...extra,
  })
}

// Wed 2026-10-14 in Beijing is weekday 3; Thu 2026-10-15 is 4; Sat 2026-10-17 is 6.
const beijing = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 9, day, h - 8, m))
}

check('peak: weekday inside a window uses the peak target', () => {
  const d = decide(beijing(14, '10:00'), config())
  eq([d.costReason, d.target], ['peak', PEAK], 'peak branch')
})

check('cost-off beats everything else (per-tier switch off => always valley)', () => {
  const cfg = config({ costRouting: false })
  for (const hhmm of ['10:00', '15:00', '20:00']) {
    const d = decide(beijing(14, hhmm), cfg)
    eq([d.costReason, d.target], ['cost-off', VALLEY], `costRouting=false at ${hhmm}`)
  }
  // even on a holiday, which would otherwise be peak-holiday
  const holiday = config({ costRouting: false }, { holidays: [[2026, 10, 14]] })
  eq(decide(beijing(14, '10:00'), holiday).costReason, 'cost-off', 'cost-off wins over holiday')
})

check('peak-disabled beats weekday/holiday/window', () => {
  const cfg = config({ peak: { enabled: false, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00']], ...PEAK } })
  eq(decide(beijing(14, '10:00'), cfg).costReason, 'peak-disabled', 'on weekday')
  eq(decide(beijing(17, '10:00'), cfg).costReason, 'peak-disabled', 'on weekend')
})

check('peak-weekday beats holiday and window', () => {
  // Saturday AND a holiday AND inside the window: weekday wins by contract.
  const cfg = config({}, { holidays: [[2026, 10, 17]] })
  const d = decide(beijing(17, '10:00'), cfg)
  eq([d.costReason, d.holiday, d.target], ['peak-weekday', true, VALLEY], 'weekday check first')
})

check('peak-holiday beats window on a weekday', () => {
  const cfg = config({}, { holidays: [[2026, 10, 14]] })
  const d = decide(beijing(14, '10:00'), cfg)
  eq([d.costReason, d.target], ['peak-holiday', VALLEY], 'holiday suppresses peak')
})

check('peak-outside on a weekday outside every window', () => {
  const cfg = config()
  for (const hhmm of ['08:59', '12:00', '13:59', '18:00', '23:00']) {
    const d = decide(beijing(14, hhmm), cfg)
    eq([d.costReason, d.target], ['peak-outside', VALLEY], `outside at ${hhmm}`)
  }
})

check('window boundaries: 09:00 in, 11:59 in, 12:00 out; 14:00 in, 18:00 out', () => {
  const cfg = config()
  const reason = (hhmm) => decide(beijing(14, hhmm), cfg).costReason
  eq(reason('09:00'), 'peak', 'start inclusive')
  eq(reason('11:59'), 'peak', 'last minute inside')
  eq(reason('12:00'), 'peak-outside', 'end exclusive')
  eq(reason('14:00'), 'peak', 'second window start inclusive')
  eq(reason('17:59'), 'peak', 'second window inside')
  eq(reason('18:00'), 'peak-outside', 'second window end exclusive')
})

check('each tier has its own peak table and cost switch', () => {
  const cfg = normalizeConfig({
    utcOffsetMinutes: 480,
    holidays: [],
    targets: {
      low: { valley: VALLEY, costRouting: true, peak: { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00']], ...PEAK } },
      mid: { valley: ALT, costRouting: false, peak: { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00']], ...PEAK } },
      high: { valley: { provider: 'codex', model: 'gpt-6-astra' }, costRouting: true, peak: { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['15:00', '16:00']], ...PEAK } },
    },
    tierRouting: { enabled: true, concreteThreshold: 0.55, mediumThreshold: 0.28 },
    advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  })
  const at = (hhmm, tier) => decide(beijing(14, hhmm), cfg, { tier })
  eq([at('10:00', 'low').costReason, at('10:00', 'low').target], ['peak', PEAK], 'low 10:00 peak')
  eq([at('10:00', 'mid').costReason, at('10:00', 'mid').target], ['cost-off', ALT], 'mid costRouting off')
  eq([at('15:30', 'high').costReason, at('15:30', 'high').target], ['peak', PEAK], 'high window 15:00-16:00')
  eq([at('10:00', 'high').costReason], ['peak-outside'], 'high is outside its own window')
  // Share resolution: mid/high copies are independent of later low edits.
  const tables = resolveTargets(cfg)
  eq(tables.low.peak.windows, [['09:00', '12:00']], 'low windows')
  eq(tables.high.peak.windows, [['15:00', '16:00']], 'high windows')
})

check('holidays are shared by every tier', () => {
  const cfg = config({}, {
    holidays: [[2026, 10, 14]],
    tierRouting: { enabled: true, concreteThreshold: 0.55, mediumThreshold: 0.28 },
  })
  for (const tier of ['low', 'mid', 'high']) {
    const d = decide(beijing(14, '10:00'), cfg, { tier })
    eq([d.costReason, d.tier], ['peak-holiday', tier], `tier ${tier} sees the shared holiday`)
  }
})

check('utcOffsetMinutes reinterprets the clock, not the system timezone', () => {
  const utc = config({}, { utcOffsetMinutes: 0 })
  // 10:00 UTC is inside 09:00-12:00 for offset 0 (weekday 3).
  const d = decide(new Date('2026-10-14T10:00:00Z'), utc)
  eq([d.costReason, d.minutes, d.weekday], ['peak', 600, 3], 'offset 0 sees 10:00')
  const utcMinus5 = config({}, { utcOffsetMinutes: -300 })
  // 10:00 UTC == 05:00 at -05:00 -> outside the window.
  eq(decide(new Date('2026-10-14T10:00:00Z'), utcMinus5).costReason, 'peak-outside', 'offset -05:00')
})

check('weekday set is per tier and matches 1=Monday..7=Sunday', () => {
  const cfg = config({ peak: { enabled: true, weekdays: [6, 7], windows: [['09:00', '12:00']], ...PEAK } })
  eq(decide(beijing(17, '10:00'), cfg).costReason, 'peak', 'Saturday is peak with [6,7]')
  eq(decide(beijing(18, '10:00'), cfg).costReason, 'peak', 'Sunday is peak with [6,7]')
  eq(decide(beijing(14, '10:00'), cfg).costReason, 'peak-weekday', 'Wednesday is not in [6,7]')
})

check('the shipped defaults never switch to peak (fail-safe)', () => {
  const cfg = normalizeConfig(DEFAULTS)
  for (const day of [14, 17]) {
    for (const hhmm of ['09:00', '10:00', '15:00', '20:00']) {
      const d = decide(beijing(day, hhmm), cfg)
      eq([d.costReason, d.tier], ['peak-disabled', 'low'], `defaults at 2026-10-${day} ${hhmm}`)
      eq(d.target, DEFAULTS.targets.low.valley, 'defaults target')
    }
  }
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
console.log(failures === 0 ? 'cost-routing: 全部通过' : `cost-routing: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
