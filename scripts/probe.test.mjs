// `probe` RPC: the settings page's "样例试算".
//
// Contract: a PURE trial run — classify the pasted text and show the target it
// WOULD get. It must never select, never write, never record a decision/warning,
// and never mutate the in-memory config. Invalid input must be reported, never
// turned into an invented tier.
// Run: node scripts/probe.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const routing = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { DEFAULTS } = await import(new URL('../lib/text.js', import.meta.url))
const { normalizeConfig } = routing

console.error = () => {}

const LOW = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const MID = { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' }
const HIGH = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }
const PEAK = { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium' }

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
  codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
}

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}

function policy(overrides = {}) {
  return normalizeConfig({
    utcOffsetMinutes: 480,
    holidays: [],
    // Disabled on purpose: the trial run must still work before the user opts in.
    tierRouting: { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 },
    targets: {
      low: { valley: LOW, costRouting: true, peak: { enabled: false, weekdays: [1], windows: [], ...LOW } },
      mid: { valley: MID, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], ...MID } },
      high: { valley: HIGH, costRouting: true, peak: { enabled: true, weekdays: [1, 2, 3, 4, 5, 6, 7], windows: [['09:00', '12:00']], ...PEAK } },
    },
    advancedSupport: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' },
    ...overrides,
  })
}

const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-probe-${process.pid}`)
const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
rmSync(root, { recursive: true, force: true })
mkdirSync(pluginDir, { recursive: true })
process.env.DSH_HOME = root
writeFileSync(join(pluginDir, 'state.json'), JSON.stringify({ enabled: true }))
const policyPath = join(pluginDir, 'policy.json')
const statePath = join(pluginDir, 'state.json')
writeFileSync(policyPath, JSON.stringify(policy()))

const routes = new Map()
const listeners = new Map()
const llm = {
  listProviders: () => PROVIDERS,
  listModels: async (provider) => MODELS[provider] ?? [],
  resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }] } }),
}
const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
index.apply({
  llm,
  get: (n) => (n === 'llm' ? llm : undefined),
  on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
  inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
  effect: (fn) => { fn(); return () => {} },
})
await new Promise((resolve) => setTimeout(resolve, 80))

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
const probe = (payload) => call('probe', payload)
const log = () => {
  try { return readFileSync(join(pluginDir, 'debug.log'), 'utf8') } catch { return '' }
}

check('the probe handler is registered (the client contract check depends on it)', () => {
  if (!routes.has('/api/dsh-peak-valley-router.probe')) throw new Error('probe route missing')
})

check('probe returns tier/score/reasons/thresholds/target for the three tiers', async () => {
  const high = await probe({ text: '为什么这样设计？' })
  eq(high.ok, true, 'ok')
  eq(high.value.tier, 'high', 'abstract -> high')
  if (!high.value.reasons.includes('abstract')) throw new Error(`reasons: ${JSON.stringify(high.value.reasons)}`)
  eq(high.value.thresholds, { concrete: 0.55, medium: 0.28 }, 'thresholds echoed')
  eq(high.value.target, HIGH, 'high target (trial works while routing is off)')
  eq(high.value.features, high.value.reasons, 'features alias')

  const mid = await probe({ text: '帮我改 lib/index.js 第 120 行' })
  eq([mid.value.tier, mid.value.target], ['mid', MID], 'mid tier')

  const low = await probe({ text: '跑一下测试' })
  eq([low.value.tier, low.value.target], ['low', LOW], 'low tier')
  if (!(low.value.score >= 0.55)) throw new Error(`low score: ${low.value.score}`)
})

check('probe is deterministic and uses the provided instant for cost decisions', async () => {
  const a = await probe({ text: '为什么这样设计？', at: '2026-10-14T02:00:00Z' }) // Wed 10:00 Beijing
  eq([a.value.costReason, a.value.axis], ['peak', 'tier'], 'inside the high peak window')
  eq(a.value.target, PEAK, 'peak target')
  const b = await probe({ text: '为什么这样设计？', at: '2026-10-14T04:00:00Z' }) // Wed 12:00 Beijing (end exclusive)
  eq([b.value.costReason, b.value.target], ['peak-outside', HIGH], 'outside the window')
  const again = await probe({ text: '为什么这样设计？', at: '2026-10-14T02:00:00Z' })
  eq(again.value, a.value, 'same input -> same result')
})

check('probe has no side effects on config, state, decisions or warnings', async () => {
  const before = await call('get', {})
  const policyBytes = readFileSync(policyPath, 'utf8')
  const stateBytes = readFileSync(statePath, 'utf8')
  const logBefore = log()
  for (const text of ['为什么这样设计？', '跑一下测试', '帮我改 lib/index.js', '']) {
    const result = await probe({ text, at: '2026-10-14T02:00:00Z' })
    if (result.ok !== true) throw new Error(`probe failed: ${JSON.stringify(result)}`)
  }
  const after = await call('get', {})
  eq(after.value, before.value, 'get is byte-identical before/after probes')
  eq(readFileSync(policyPath, 'utf8'), policyBytes, 'policy.json untouched')
  eq(readFileSync(statePath, 'utf8'), stateBytes, 'state.json untouched')
  if (log() !== logBefore) throw new Error(`probe must not log/record anything:\n${log().slice(logBefore.length)}`)
})

check('probe accepts a candidate config without applying it', async () => {
  const strict = policy({ tierRouting: { enabled: false, concreteThreshold: 0.9, mediumThreshold: 0.4 } })
  const got = await probe({ text: '跑一下测试', config: strict })
  eq([got.value.tier, got.value.thresholds], ['mid', { concrete: 0.9, medium: 0.4 }], 'candidate thresholds')
  const current = await call('get', {})
  eq(current.value.config.tierRouting.concreteThreshold, 0.55, 'the live config is unchanged')
})

check('probe supports an explicit tier override (debugging aid)', async () => {
  const forced = await probe({ text: '为什么这样设计？', tier: 'low', at: '2026-10-14T04:00:00Z' })
  eq([forced.value.tier, forced.value.target], ['low', LOW], 'forced low')
  const forcedHigh = await probe({ text: '跑一下测试', tier: 'high', at: '2026-10-14T04:00:00Z' })
  eq([forcedHigh.value.tier, forcedHigh.value.target], ['high', HIGH], 'forced high')
})

check('probe reports invalid input instead of inventing a tier', async () => {
  const badText = await probe({ text: 42 })
  eq([badText.ok, badText.error.code], [false, 'bad-request'], 'non-string text')
  const badTier = await probe({ text: 'hi', tier: 'ultra' })
  eq([badTier.ok, badTier.error.code], [false, 'bad-request'], 'unknown tier')
  const badAt = await probe({ text: 'hi', at: 'not-a-date' })
  eq([badAt.ok, badAt.error.code], [false, 'bad-request'], 'bad timestamp')
  const invalid = JSON.parse(JSON.stringify(policy()))
  invalid.tierRouting.concreteThreshold = 0.1
  invalid.tierRouting.mediumThreshold = 0.9
  const badConfig = await probe({ text: 'hi', config: invalid })
  eq([badConfig.ok, badConfig.error.code], [false, 'bad-request'], 'invalid config')
  if (!badConfig.error.message.includes('concreteThreshold')) throw new Error(`config error should name the field: ${badConfig.error.message}`)
})

check('probe without text previews the low fallback (same as the active decision)', async () => {
  const empty = await probe({})
  eq([empty.value.tier, empty.value.score], ['low', null], 'empty -> low with no score')
  eq(empty.value.tierReason, 'tier-fallback-low', 'fallback reason')
  eq(empty.value.target, LOW, 'low valley target')
})

check('probe works with the shipped defaults (tierRouting off)', async () => {
  // The candidates come from DEFAULTS; verifying the shipped shape stays usable.
  const shipped = await probe({ text: '为什么这样设计？', config: DEFAULTS })
  eq(shipped.ok, true, 'ok')
  eq(shipped.value.tier, 'high', 'classification still runs')
  eq(shipped.value.target, DEFAULTS.targets.high.share === 'low' ? DEFAULTS.targets.low.valley : null, 'share resolution')
})

for (const [name, fn] of pending) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
console.log(failures === 0 ? 'probe: 全部通过' : `probe: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
