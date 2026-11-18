// v1 -> v2 migration: matrix, differential equivalence with the 0.15 resolver,
// and the "read v1 in memory, do not touch the file until the user saves" rule.
//
// 0.15's `resolveSelectionDetailed` is the oracle. Re-implemented here from the
// 0.15 source (lib/index.js:249-310 at tag v0.15.0) so an accidental semantic
// change in v2 fails instead of being blessed by a shared implementation.
// Run: node scripts/migrate-v1.test.mjs
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { normalizeConfig, decide, ConfigError } = mod

console.error = () => {}

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}

// The exact v1 policy shape 0.15.0 shipped / a user could have saved.
const V1 = {
  utcOffsetMinutes: 480,
  holidays: [[2026, 10, 14]],
  strategies: [{
    name: '避峰岗',
    description: 'GPT 额度枯竭时低级任务全周使用 DeepSeek Flash low',
    weekdays: [1, 2, 3, 4, 5],
    primary: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    peak: {
      enabled: true,
      windows: [['09:00', '12:00'], ['14:00', '18:00']],
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    },
  }],
  advancedSupport: { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' },
}

check('migration matrix: low <- strategies[0], high <- advancedSupport, mid <- share low', () => {
  const cfg = normalizeConfig(V1)
  eq(cfg.schemaVersion, 2, 'schemaVersion')
  eq(cfg.targets.low.valley, V1.strategies[0].primary, 'low.valley')
  eq(cfg.targets.low.costRouting, true, 'low.costRouting defaults on (keeps v1 peak switching)')
  eq(cfg.targets.low.peak.weekdays, [1, 2, 3, 4, 5], 'low.peak.weekdays')
  eq(cfg.targets.low.peak.windows, [['09:00', '12:00'], ['14:00', '18:00']], 'low.peak.windows')
  eq(cfg.targets.low.peak, { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00'], ['14:00', '18:00']], provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }, 'low.peak triple')
  eq(cfg.targets.mid, { share: 'low' }, 'mid')
  eq(cfg.targets.high.valley, V1.advancedSupport, 'high.valley <- advancedSupport')
  eq(cfg.targets.high.peak.enabled, false, 'high peak starts disabled')
  eq(cfg.targets.high.costRouting, true, 'high costRouting')
  eq(cfg.tierRouting, { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 }, 'tierRouting off keeps 0.15 behavior')
  eq(cfg.holidays, V1.holidays, 'holidays preserved')
  eq(cfg.utcOffsetMinutes, 480, 'utcOffset preserved')
  eq(cfg.advancedSupport, V1.advancedSupport, 'advancedSupport preserved')
})

check('an explicit advancedSupport without an effort still inherits the v1 default (max)', () => {
  const cfg = normalizeConfig({
    strategies: [{ weekdays: [1], primary: { provider: 'deepseek-official', model: 'deepseek-chat' }, peak: { enabled: false, windows: [] } }],
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  eq(cfg.advancedSupport, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }, 'inherited effort')
})

check('legacy nested peak.model and an explicitly empty peak window still migrate', () => {
  const cfg = normalizeConfig({
    strategies: [{
      weekdays: [1],
      primary: { provider: 'deepseek-official', model: 'deepseek-chat' },
      peak: { enabled: true, windows: [], model: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } },
    }],
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  eq(cfg.targets.low.peak.provider, 'codex', 'nested peak provider')
  eq(cfg.targets.low.peak.model, 'gpt-5.6-luna', 'nested peak model')
  eq(cfg.targets.low.peak.enabled, false, 'enabled with no windows normalizes to off')
})

check('strategies[1..] do not route but survive in the legacy snapshot', () => {
  const two = {
    ...V1,
    strategies: [
      V1.strategies[0],
      { name: 'second', weekdays: [6, 7], primary: { provider: 'codex', model: 'gpt-6-astra' }, peak: { enabled: false, windows: [] } },
    ],
  }
  const cfg = normalizeConfig(two)
  eq(cfg.targets.low.valley, two.strategies[0].primary, 'only the first strategy supplies low')
  eq(cfg.legacy.strategies.length, 2, 'legacy keeps every strategy')
  eq(cfg.legacy.strategies[1].name, 'second', 'legacy keeps the dropped plan')
  if (!/^\d{4}-\d{2}-\d{2}T/.test(cfg.legacy.migratedAt)) throw new Error('legacy.migratedAt must be an ISO timestamp')
})

check('v1 with no strategies keeps the advanced-only target as the low valley', () => {
  const cfg = normalizeConfig({ advancedSupport: { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' } })
  eq(cfg.targets.low.valley, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }, 'advanced-only becomes low.valley')
  eq(decide(new Date('2026-10-14T02:00:00Z'), cfg).target, cfg.targets.low.valley, 'resolves to it')
})

check('v1 validation stays strict (bad strategy / explicitly empty advanced support)', () => {
  try {
    normalizeConfig({ strategies: [{}], advancedSupport: { provider: 'p', model: 'm' } })
    throw new Error('expected a ConfigError for a strategy without a primary model')
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    if (!error.message.includes('strategy #1')) throw new Error(`message must keep the strategy index: ${error.message}`)
  }
  try {
    normalizeConfig({ strategies: [{ primary: { provider: 'p', model: 'm' } }], advancedSupport: {} })
    throw new Error('expected a ConfigError for missing advanced support')
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    if (!error.message.includes('高级模型支援')) throw new Error(`message must mention the required support: ${error.message}`)
  }
})

// ---------- 0.15 oracle ----------

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
const v1TimeInWindows = (minutes, windows) => windows.some(([s, e]) => minutes >= minutesOf(s) && minutes < minutesOf(e))

// Verbatim port of 0.15.0 lib/index.js#resolveSelectionDetailed (same shift,
// same weekday formula, same branch order). Selection only — v2 has different
// reason strings and that is intentional (§3.3).
function v1ResolveSelection(date, cfg) {
  const shifted = new Date(date.getTime() + cfg.utcOffsetMinutes * 60_000)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  const weekday = ((shifted.getUTCDay() + 6) % 7) + 1
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const holiday = (cfg.holidays ?? []).some(([y, m, d]) => y === year && m === month && d === day)
  for (const strategy of cfg.strategies ?? []) {
    if (!strategy.weekdays.includes(weekday)) continue
    if (strategy.peak.enabled && !holiday && v1TimeInWindows(minutes, strategy.peak.windows)) {
      return { provider: strategy.peak.provider, model: strategy.peak.model, reasoningEffort: strategy.peak.reasoningEffort }
    }
    return { provider: strategy.primary.provider, model: strategy.primary.model, reasoningEffort: strategy.primary.reasoningEffort }
  }
  if ((cfg.strategies ?? []).length > 0) {
    const first = cfg.strategies[0].primary
    return { provider: first.provider, model: first.model, reasoningEffort: first.reasoningEffort }
  }
  if (cfg.advancedSupport?.provider && cfg.advancedSupport?.model) {
    return { provider: cfg.advancedSupport.provider, model: cfg.advancedSupport.model, reasoningEffort: cfg.advancedSupport.reasoningEffort }
  }
  return null
}

check('differential equivalence with 0.15 across weekday x window x holiday x peak-switch', () => {
  const strategies = [
    V1.strategies[0],
    // all-week plan
    { weekdays: [1, 2, 3, 4, 5, 6, 7], primary: { provider: 'deepseek-official', model: 'deepseek-chat' }, peak: { enabled: false, windows: [] } },
    // peak enabled with no windows (normalizes to off in both versions)
    { weekdays: [1, 2, 3, 4, 5], primary: { provider: 'deepseek-official', model: 'deepseek-chat' }, peak: { enabled: true, windows: [], provider: 'x', model: 'y' } },
  ]
  const configs = [
    { ...V1, strategies: [strategies[0]] },
    { ...V1, strategies: [strategies[1]] },
    { ...V1, strategies: [strategies[2]] },
    { ...V1, strategies: [], advancedSupport: V1.advancedSupport },
  ]
  const clock = ['00:00', '08:59', '09:00', '11:59', '12:00', '14:00', '17:59', '18:00', '23:59']
  const holidaySets = [[], [[2026, 10, 14]], [[2026, 10, 17]]]
  let compared = 0
  for (const v1 of configs) {
    for (const holidays of holidaySets) {
      // Both sides must see the SAME holidays: the oracle reads the v1 object
      // while the resolver reads the migrated v2 config.
      const variant = { ...v1, holidays }
      const cfg = normalizeConfig(variant)
      for (let day = 12; day <= 18; day += 1) {
        for (const hhmm of clock) {
          const [h, m] = hhmm.split(':').map(Number)
          const instant = new Date(Date.UTC(2026, 9, day, h - 8, m))
          const oracle = v1ResolveSelection(instant, variant)
          const actual = decide(instant, cfg).selection
          eq(actual, oracle, `${variant.strategies.length} plan(s), 2026-10-${day} ${hhmm}, holidays=${JSON.stringify(holidays)}`)
          compared += 1
        }
      }
    }
  }
  if (compared !== configs.length * holidaySets.length * 7 * clock.length) throw new Error(`compared ${compared} instants`)
})

check('extra v1 plans are NOT routed after migration (documented, intentional difference)', () => {
  // 0.15 picked the first plan whose weekdays matched, so a second weekend plan
  // could own Saturdays. v2 keeps one low table; strategies[1..] survive only as
  // the read-only legacy snapshot (§2.4). This test pins that difference so it is
  // a decision, not an accident.
  const two = {
    ...V1,
    strategies: [
      V1.strategies[0],
      { name: 'weekend', weekdays: [6, 7], primary: { provider: 'deepseek-official', model: 'deepseek-chat' }, peak: { enabled: false, windows: [] } },
    ],
  }
  const saturday = new Date('2026-10-17T04:00:00Z') // Sat 12:00 Beijing
  const oracle = v1ResolveSelection(saturday, two)
  const cfg = normalizeConfig(two)
  const actual = decide(saturday, cfg).selection
  eq(oracle, { provider: 'deepseek-official', model: 'deepseek-chat' }, 'the 0.15 oracle did use the weekend plan')
  eq(actual, V1.strategies[0].primary, 'v2 routes the first plan valley')
  if (JSON.stringify(oracle) === JSON.stringify(actual)) throw new Error('the documented difference disappeared; update the design matrix consciously')
})

// ---------- file behavior: read v1, do NOT write ----------

const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-migrate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
rmSync(root, { recursive: true, force: true })
mkdirSync(pluginDir, { recursive: true })
process.env.DSH_HOME = root
const policyPath = join(pluginDir, 'policy.json')
writeFileSync(policyPath, JSON.stringify(V1))
const beforeBytes = readFileSync(policyPath, 'utf8')
const beforeMtime = statSync(policyPath).mtimeMs

const listeners = new Map()
const routes = new Map()
const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const models = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
  codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
}
const llm = {
  listProviders: () => providers,
  listModels: async (provider) => models[provider] ?? [],
  resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }),
}
const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
index.apply({
  llm,
  get: (n) => (n === 'llm' ? llm : undefined),
  on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
  inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
  effect: (fn) => { fn(); return () => {} },
})
await new Promise((resolve) => setTimeout(resolve, 60))

const call = async (endpoint, payload) => {
  const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
  if (!route) throw new Error(`no route for ${endpoint}`)
  const request = new Request('http://x/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
  })
  return (await (await route.fetch(request)).json()).result
}

const pending = []
const checkAsync = (name, fn) => pending.push([name, fn])

checkAsync('loading a v1 policy.json migrates in memory and leaves the file untouched', async () => {
  const got = await call('get', {})
  if (got.ok !== true) throw new Error(`get failed: ${JSON.stringify(got.error)}`)
  eq(got.value.config.targets.low.valley, V1.strategies[0].primary, 'in-memory v2 low valley')
  const afterBytes = readFileSync(policyPath, 'utf8')
  if (afterBytes !== beforeBytes) throw new Error('policy.json was rewritten on load; v1 files must stay read-only until a save')
  if (statSync(policyPath).mtimeMs !== beforeMtime) throw new Error('policy.json mtime changed on load')
  const log = readFileSync(join(pluginDir, 'debug.log'), 'utf8')
  if (!log.includes('policy: read v1 (in-memory v2)')) throw new Error('the v1 read must be logged')
})

checkAsync('the first save writes canonical v2 and backs the v1 file up', async () => {
  const got = await call('get', {})
  const saved = await call('set', { config: got.value.config })
  if (saved.ok !== true) throw new Error(`set failed: ${JSON.stringify(saved.error)}`)
  const disk = JSON.parse(readFileSync(policyPath, 'utf8'))
  eq(disk.schemaVersion, 2, 'disk schemaVersion')
  eq(disk.targets.low.valley, V1.strategies[0].primary, 'disk low valley')
  eq(disk.legacy.strategies.length, 1, 'disk keeps the legacy snapshot')
  const backups = readdirSync(pluginDir).filter((file) => file.startsWith('policy.json.bak-v1-'))
  if (backups.length !== 1) throw new Error(`expected exactly one v1 backup, got ${JSON.stringify(backups)}`)
  const backup = JSON.parse(readFileSync(join(pluginDir, backups[0]), 'utf8'))
  eq(backup.strategies[0].primary, V1.strategies[0].primary, 'backup is the original v1 file')
  if (saved.value.configRevision <= got.value.configRevision) throw new Error('revision must increase on save')
})

checkAsync('the peak model survives get / set / re-set / disk as a FLAT triple', async () => {
  // Regression ported from the deleted roundtrip.test.mjs: the settings client
  // renders `peak.provider` / `peak.model`; a nested or collapsed peak made the
  // picker render empty and the next save overwrite the user's secondary model.
  const expectedPeak = { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00'], ['14:00', '18:00']], provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }
  const got = await call('get', {})
  eq(got.value.config.targets.low.peak, expectedPeak, 'peak via get')
  const first = await call('set', { config: got.value.config })
  eq(first.value.config.targets.low.peak, expectedPeak, 'peak echoed by set #1')
  const second = await call('set', { config: first.value.config })
  eq(second.value.config.targets.low.peak, expectedPeak, 'peak survives an unchanged re-save')
  const diskPeak = JSON.parse(readFileSync(policyPath, 'utf8')).targets.low.peak
  if (typeof diskPeak.provider !== 'string' || typeof diskPeak.model !== 'string') {
    throw new Error(`disk peak must be flat: ${JSON.stringify(diskPeak)}`)
  }
  eq(diskPeak, expectedPeak, 'disk peak')
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
for (const [name, fn] of pending) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'migrate-v1: 全部通过' : `migrate-v1: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
