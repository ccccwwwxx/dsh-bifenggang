// Regression guard for the peak-model ROUND-TRIP shape.
//
// The settings client renders the peak (secondary) picker from `peak.provider` /
// `peak.model` (see src/client/20-modelpicker.js), and lib/text.js DEFAULTS
// declare the peak model in that same flat layout. An earlier revision wrote it
// NESTED (`peak.model = { provider, model, ... }`) instead, which made every
// get/set round-trip render the picker empty and silently collapse the peak
// model onto the PRIMARY on the next save — the user's selection looked like it
// "would not save".
//
// This test drives the real RPC handlers and mimics the client accessor, so a
// shape regression fails here instead of in the GUI. Run: node scripts/roundtrip.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const modPath = join(here, '..', 'lib', 'index.js')
const mod = await import(pathToFileURL(modPath).href)

// Unique per run: a fixed path collides when two runs overlap (e.g. `npm run
// verify` started twice, or a concurrent test suite), because DSH_HOME is
// process-global and each run wipes the directory at start.
const root = join(
  process.env.TEMP ?? process.env.TMP ?? '.',
  `dsh-pv-roundtrip-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
)
const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
rmSync(root, { recursive: true, force: true })
mkdirSync(pluginDir, { recursive: true })
process.env.DSH_HOME = root
writeFileSync(join(pluginDir, 'state.json'), JSON.stringify({ enabled: true }))

let failures = 0
// Checks are collected first and awaited in declaration order, so an async check
// cannot silently pass: `fn()` might otherwise return an un-awaited promise.
const pending = []
function check(name, fn) {
  pending.push([name, fn])
}
async function runChecks() {
  for (const [name, fn] of pending) {
    try {
      await fn()
      console.log(`  ok   ${name}`)
    } catch (e) {
      failures++
      console.log(`  FAIL ${name}\n       ${e.message}`)
    }
  }
}
const eqJson = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const isPlainString = (v) => typeof v === 'string' && v !== ''

// Minimal fake host for the two seams this test needs (llm + RPC fetch routes).
const routes = new Map()
const providers = [
  { id: 'deepseek-official', name: 'DeepSeek Official' },
  { id: 'codex', name: 'ChatGPT Plus' },
  { id: 'openai-codex', name: 'OpenAI Codex' },
]
const modelsByProvider = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
  codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
  'openai-codex': [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
}
const llm = { listProviders: () => providers, listModels: async (p) => modelsByProvider[p] ?? [] }
const connection = { fetch: { register: (r) => { routes.set(r.path, r); return () => {} } } }
const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
const ctx = {
  llm,
  get: (n) => (n === 'llm' ? llm : undefined),
  on: () => () => {},
  inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
}
mod.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 40))

const call = async (endpoint, payload) => {
  const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
  if (!route) throw new Error(`no registered route for ${endpoint}`)
  const request = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
  })
  return (await (await route.fetch(request)).json()).result
}
// Exactly what src/client/20-modelpicker.js does with the value it is handed.
const clientReads = (peak) => ({ provider: peak?.provider, model: peak?.model, reasoningEffort: peak?.reasoningEffort })
const PEAK = { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }
const flatInput = {
  strategies: [{
    name: 's',
    description: '',
    weekdays: [1, 2, 3, 4, 5],
    primary: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    peak: { enabled: true, windows: [['09:00', '12:00']], ...PEAK },
  }],
  advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
}

check('normalizeConfig writes the peak model FLAT (client-readable strings)', () => {
  const peak = mod.normalizeConfig(flatInput).strategies[0].peak
  if (!isPlainString(peak.provider)) throw new Error(`peak.provider must be a non-empty string, got ${JSON.stringify(peak.provider)}`)
  if (!isPlainString(peak.model)) throw new Error(`peak.model must be a non-empty string, got ${JSON.stringify(peak.model)}`)
  eqJson({ provider: peak.provider, model: peak.model, reasoningEffort: peak.reasoningEffort }, PEAK, 'peak')
})

check('peak time resolves to the chosen peak model (not the primary)', () => {
  const picked = mod.resolveSelection(new Date('2026-10-14T02:00:00Z'), mod.normalizeConfig(flatInput)) // Wed 10:00 Beijing
  eqJson(picked, PEAK, 'peak selection')
})

// The reason is what makes a surprising target explainable in the log and the
// settings page. A weekday-only policy falls back to advancedSupport all weekend:
// correct by design, but indistinguishable from a bug without this.
check('every branch reports WHY it was chosen (peak / primary / weekend / holiday)', () => {
  const cfg = mod.normalizeConfig(flatInput)
  const at = (iso) => mod.resolveSelectionDetailed(new Date(iso), cfg)

  const peak = at('2026-10-14T02:00:00Z') // Wed 10:00 Beijing, inside 09:00-12:00
  if (peak.reason !== 'peak') throw new Error(`Wed 10:00 must be reason=peak, got ${peak.reason}`)
  if (peak.holiday !== false || peak.weekday !== 3) throw new Error(`context wrong: weekday=${peak.weekday} holiday=${peak.holiday}`)

  const primary = at('2026-10-14T06:00:00Z') // Wed 14:00 Beijing, outside every window
  if (primary.reason !== 'primary') throw new Error(`Wed 14:00 must be reason=primary, got ${primary.reason}`)
  eqJson(primary.selection, flatInput.strategies[0].primary, 'off-peak selection')

  const weekend = at('2026-10-17T02:00:00Z') // Sat 10:00 Beijing: no plan matches
  if (weekend.reason !== 'fallback-first-primary') throw new Error(`Sat must be reason=fallback-first-primary, got ${weekend.reason}`)
  // The unmatched case resolves to the FIRST plan's primary — never to the advanced
  // thinking model, which is a separate axis (see the max-effort branch).
  eqJson({ provider: weekend.selection.provider, model: weekend.selection.model }, { provider: cfg.strategies[0].primary.provider, model: cfg.strategies[0].primary.model }, 'weekend uses the first plan primary')

  // A holiday ON a weekday still matches the strategy — but the peak window is
  // skipped (holidays run off-peak), so the reason is `primary`.
  const holidayCfg = mod.normalizeConfig({ ...flatInput, holidays: [[2026, 10, 14]] })
  const holiday = mod.resolveSelectionDetailed(new Date('2026-10-14T02:00:00Z'), holidayCfg)
  if (holiday.reason !== 'primary') throw new Error(`a weekday holiday must skip the peak window, got reason=${holiday.reason}`)
  if (holiday.holiday !== true) throw new Error('the holiday flag must be reported')
  eqJson({ provider: holiday.selection.provider, model: holiday.selection.model }, { provider: cfg.strategies[0].primary.provider, model: cfg.strategies[0].primary.model }, 'weekday holiday uses the primary')

  // A holiday that matches no weekday at all behaves like any other unmatched day.
  const satHoliday = mod.resolveSelectionDetailed(new Date('2026-10-17T02:00:00Z'), mod.normalizeConfig({ ...flatInput, holidays: [[2026, 10, 17]] }))
  if (satHoliday.reason !== 'fallback-first-primary') throw new Error(`an unmatched holiday must report fallback-first-primary, got ${satHoliday.reason}`)

  // With no plans at all, advancedSupport is the only configured target — that is
  // not an escalation, and it says so.
  const bare = mod.resolveSelectionDetailed(new Date('2026-10-17T02:00:00Z'), mod.normalizeConfig({ strategies: [], advancedSupport: { provider: 'codex', model: 'gpt-6-astra' } }))
  if (bare.reason !== 'advanced-only') throw new Error(`empty plans must report reason=advanced-only, got ${bare.reason}`)

  // Nothing configured at all is reported, not silently guessed.
  const empty = mod.resolveSelectionDetailed(new Date('2026-10-17T02:00:00Z'), mod.normalizeConfig({ strategies: [], advancedSupport: {} }))
  if (empty.reason !== 'none' || empty.selection !== null) throw new Error(`empty policy must report reason=none, got ${empty.reason}`)
})

check('save #1 echoes a peak the picker can render', async () => {
  const first = await call('set', { config: flatInput })
  if (first.ok !== true) throw new Error(`set failed: ${JSON.stringify(first.error)}`)
  eqJson(clientReads(first.value.config.strategies[0].peak), PEAK, 'peak after save #1')
})

check('save #2 (unchanged re-save) does NOT collapse the peak onto the primary', async () => {
  const first = await call('set', { config: flatInput })
  const second = await call('set', { config: first.value.config })
  if (second.ok !== true) throw new Error(`set failed: ${JSON.stringify(second.error)}`)
  const strategy = second.value.config.strategies[0]
  eqJson(clientReads(strategy.peak), PEAK, 'peak after save #2')
  if (strategy.peak.provider === strategy.primary.provider && strategy.peak.model === strategy.primary.model) {
    throw new Error('peak collapsed onto the primary model')
  }
})

check('get returns the same flat peak', async () => {
  const got = await call('get', {})
  eqJson(clientReads(got.value.config.strategies[0].peak), PEAK, 'peak via get')
})

check('policy.json on disk stores the peak FLAT', () => {
  const peak = JSON.parse(readFileSync(join(pluginDir, 'policy.json'), 'utf8')).strategies[0].peak
  if (!isPlainString(peak.provider) || !isPlainString(peak.model)) throw new Error(`disk peak must be flat: ${JSON.stringify(peak)}`)
  eqJson({ provider: peak.provider, model: peak.model }, { provider: PEAK.provider, model: PEAK.model }, 'disk peak')
})

check('legacy nested peak.model is still accepted and normalized flat', () => {
  const legacy = mod.normalizeConfig({
    strategies: [{
      name: 'legacy',
      weekdays: [1, 2, 3, 4, 5],
      primary: { provider: 'deepseek-official', model: 'deepseek-flash' },
      peak: { enabled: true, windows: [['09:00', '12:00']], model: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } },
    }],
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  const peak = legacy.strategies[0].peak
  eqJson({ provider: peak.provider, model: peak.model, reasoningEffort: peak.reasoningEffort }, { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }, 'legacy peak')
})

check('an unset peak inherits the primary; primary/advancedSupport are untouched', () => {
  const c = mod.normalizeConfig({
    strategies: [{ weekdays: [1], primary: { provider: 'deepseek-official', model: 'deepseek-chat' }, peak: { enabled: false, windows: [] } }],
    advancedSupport: { provider: 'codex', model: 'gpt-6-astra' },
  })
  eqJson(c.strategies[0].primary, { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: undefined }, 'primary')
  // An explicitly supplied advancedSupport keeps the optional effort from DEFAULTS.
  eqJson(c.advancedSupport, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }, 'advancedSupport')
  eqJson(c.strategies[0].peak.provider, 'deepseek-official', 'peak inherits primary provider')
})

await runChecks()
console.log(failures === 0 ? 'roundtrip: 全部通过' : `roundtrip: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
