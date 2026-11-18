// t21: get.firstRun — the onboarding note's authoritative flag.
//
// Semantics: true means "at startup there was no policy.json". A v1 file counts
// as an existing policy (never first run). The first SUCCESSFUL set flips it to
// false (write reached disk); a rejected set leaves it true. No schema or extra
// file is involved.
//
// Run: node scripts/first-run.test.mjs
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const text = await import(pathToFileURL(join(here, '..', 'lib', 'text.js')).href)
const routing = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { normalizeConfig, DEFAULTS } = { normalizeConfig: routing.normalizeConfig, DEFAULTS: text.DEFAULTS }

console.error = () => {}

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }]
const MODELS = { 'deepseek-official': [{ id: 'deepseek-flash' }] }
let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

let dirCounter = 0
function makeHost(options = {}) {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-first-run-${process.pid}-${(dirCounter += 1)}`)
  rmSync(root, { recursive: true, force: true })
  const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify({ enabled: true }))
  const policyPath = join(pluginDir, 'policy.json')
  if (options.policyFile) writeFileSync(policyPath, JSON.stringify(options.policyFile))
  const listeners = new Map()
  const routes = new Map()
  const llm = {
    listProviders: () => PROVIDERS,
    listModels: async (provider) => MODELS[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'max', name: 'max' }] } }),
  }
  const agentsService = { turnBoundaryOf: (session) => session.__boundary }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
  index.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : n === 'agents' ? agentsService : undefined),
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    effect: (fn) => { fn(); return () => {} },
  })
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
  return {
    pluginDir,
    policyPath,
    call,
    hasPolicy: () => existsSync(policyPath),
    debugLog: () => {
      try { return readFileSync(join(pluginDir, 'debug.log'), 'utf8') } catch { return '' }
    },
  }
}

const V1_POLICY = {
  utcOffsetMinutes: 480,
  holidays: [],
  strategies: [
    { name: 'first', weekdays: [1, 2, 3, 4, 5, 6, 7], primary: { provider: 'deepseek-official', model: 'deepseek-flash' }, peak: { enabled: false, windows: [] } },
  ],
  advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
}

check('no policy.json at startup -> get.firstRun = true', async () => {
  const host = makeHost()
  await wait()
  const got = await host.call('get', {})
  eq(got.ok, true, 'get ok')
  eq(got.value.firstRun, true, 'first run')
  eq(host.hasPolicy(), false, 'precondition: no policy file')
  // The flag is top-level, next to config/enabled/warnings.
  eq(typeof got.value.config, 'object', 'config present')
  eq(typeof got.value.enabled, 'boolean', 'enabled present')
  eq(Array.isArray(got.value.warnings), true, 'warnings present')
  // Polling carries the same current value every time.
  eq((await host.call('get', {})).value.firstRun, true, 'still true on repeated get')
})

check('a successful set flips firstRun to false and persists policy.json', async () => {
  const host = makeHost()
  await wait()
  const before = await host.call('get', {})
  eq(before.value.firstRun, true, 'starts as first run')
  const saved = await host.call('set', { config: before.value.config, expectedRevision: before.value.configRevision })
  eq(saved.ok, true, 'set succeeds')
  eq(host.hasPolicy(), true, 'policy file written')
  const after = await host.call('get', {})
  eq(after.value.firstRun, false, 'first run cleared after save')
})

check('a v1 policy.json at startup is not a first run', async () => {
  const host = makeHost({ policyFile: V1_POLICY })
  await wait()
  const got = await host.call('get', {})
  eq(got.value.firstRun, false, 'existing v1 file counts as configured')
  eq(got.value.config.schemaVersion, 2, 'migrated in memory')
  if (!got.value.config.legacy) throw new Error('v1 migration snapshot expected')
  // Saving the migrated config keeps it false (idempotent).
  const saved = await host.call('set', { config: got.value.config })
  eq(saved.ok, true, 'save v1-migrated config')
  eq((await host.call('get', {})).value.firstRun, false, 'still false after save')
})

check('a REJECTED set leaves firstRun untouched (true) and writes no file', async () => {
  const host = makeHost()
  await wait()
  const got = await host.call('get', {})
  const bad = JSON.parse(JSON.stringify(got.value.config))
  bad.targets.low = { valley: { provider: 'deepseek-official' } } // missing model
  const rejected = await host.call('set', { config: bad })
  eq(rejected.ok, false, 'set rejected')
  eq(host.hasPolicy(), false, 'no file written on rejection')
  eq((await host.call('get', {})).value.firstRun, true, 'still a first run')
})

check('invalid-holidays kind matches the t19 copy keys (no rename drift)', async () => {
  // Service emits kind `invalid-holidays`; text.js owns the localized labels the
  // client maps that kind to. Assert both sides of the contract in one place.
  const raw = JSON.parse(JSON.stringify(normalizeConfig(DEFAULTS)))
  raw.holidays = [[2026, 10, 1], [2026, 2, 30]]
  const host = makeHost({ policyFile: raw })
  await wait()
  const got = await host.call('get', {})
  const warning = (got.value.warnings ?? []).find((entry) => entry.kind === 'invalid-holidays')
  if (!warning) throw new Error('invalid-holidays warning expected')
  eq(warning.extraCount, 1, 'dropped count')
  for (const key of ['warnKindInvalidHolidays', 'warningInvalidHolidays']) {
    for (const locale of ['zh', 'en']) {
      const value = text[locale]?.[key]
      if (typeof value !== 'string' || value.length === 0) throw new Error(`text.js.${locale} is missing ${key}`)
    }
  }
  // The kind name is part of the public RPC surface: changing it needs a client
  // update, so pin the literal here.
  eq(warning.kind, 'invalid-holidays', 'kind literal')
  // A polluted file still counts as configured (firstRun false).
  eq(got.value.firstRun, false, 'existing policy (even with dropped dates) is not first run')
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
console.log(failures === 0 ? 'first-run: 全部通过' : `first-run: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
