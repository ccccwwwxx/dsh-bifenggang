// Cross-window / multi-process state sync (t9).
//
// Two halves:
//   1. lib/state.js unit checks: v1->v2 read, per-key merge, tombstones, lock,
//      read-failure safety, bounds.
//   2. plugin-level: two plugin instances share one DSH_HOME; A changes session x,
//      B changes session y, neither loses the other; an external manual edit is
//      picked up by the poller.
// Run: node scripts/state-sync.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const state = await import(pathToFileURL(join(here, '..', 'lib', 'state.js')).href)
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

console.error = () => {}

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-sync-${process.pid}`)
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const statePath = join(root, 'state.json')
const lockPath = `${statePath}.lock`
process.env.DSH_HOME = root

const readDisk = () => JSON.parse(readFileSync(statePath, 'utf8'))
const writeDisk = (value) => writeFileSync(statePath, typeof value === 'string' ? value : JSON.stringify(value))
// The plugin's own file lives under plugins/<id>/, not at the HOME root.
const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
const pluginStatePath = join(pluginDir, 'state.json')
const readPluginState = () => JSON.parse(readFileSync(pluginStatePath, 'utf8'))
const writePluginState = (value) => {
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(pluginStatePath, JSON.stringify(value))
}
const newStore = (options = {}) => state.createStateStore({
  filePath: statePath,
  lockPath,
  log: () => {},
  debounceMs: 0,
  ...options,
})

// ---------- lib/state.js ----------

check('v1 state.json is read as v2 defaults (sessions stay booleans)', async () => {
  writeDisk({ enabled: true, sessions: { a: true, b: false } })
  const store = newStore()
  eq(store.state.enabled, true, 'enabled')
  eq(store.getSession('a').enabled, true, 'a')
  eq(store.getSession('b').enabled, false, 'b')
  eq(store.getSession('c').enabled, null, 'missing -> follow default')
  eq(store.sessionsJson(), { a: true, b: false }, 'sessions json')
  eq(store.state.schemaVersion, 2, 'schemaVersion')
})

check('per-key merge keeps both processes\' sessions (no whole-table overwrite)', async () => {
  writeDisk({ enabled: false, sessions: {} })
  const a = newStore()
  await a.setSessionEnabled('x', true)
  // B starts AFTER x exists, then writes its own key.
  const b = newStore()
  await b.setSessionEnabled('y', true)
  // A (stale memory: only x) writes z; the locked read-modify-write must keep y.
  await a.setSessionEnabled('z', false)
  const disk = readDisk()
  eq(disk.sessions, { x: true, y: true, z: false }, 'all three keys survive')
  eq(disk.schemaVersion, 2, 'schemaVersion')
  if (!(disk.revision >= 3)) throw new Error(`revision must grow, got ${disk.revision}`)
  const a2 = newStore()
  eq([a2.getSession('x').enabled, a2.getSession('y').enabled, a2.getSession('z').enabled], [true, true, false], 'reload sees all')
})

check('clearing an override writes a tombstone that a stale peer cannot resurrect', async () => {
  writeDisk({ enabled: false, sessions: {} })
  const a = newStore()
  const b = newStore() // stale snapshot before the clear
  await a.setSessionEnabled('x', true)
  await b.flushNow()
  await b.setSessionEnabled('x', false) // b saw x, sets explicit false
  await a.setSessionEnabled('x', null) // a clears (tombstone, newer)
  const disk = readDisk()
  if (Object.prototype.hasOwnProperty.call(disk.sessions, 'x')) throw new Error(`cleared override resurrected: ${JSON.stringify(disk.sessions)}`)
  if (!disk.tombstones.x) throw new Error('tombstone missing')
  const a2 = newStore()
  eq(a2.getSession('x').enabled, null, 'follow default after clear')
})

check('revision is monotonic and every write carries a schemaVersion', async () => {
  writeDisk({ enabled: false, sessions: {} })
  const store = newStore()
  let last = 0
  for (let i = 0; i < 3; i += 1) {
    await store.setSessionEnabled(`s${i}`, true)
    const disk = readDisk()
    if (!(disk.revision > last)) throw new Error(`revision did not grow: ${last} -> ${disk.revision}`)
    last = disk.revision
    eq(disk.schemaVersion, 2, 'schemaVersion')
  }
})

check('a held lock keeps the change in memory and leaves the file untouched', async () => {
  writeDisk({ enabled: false, sessions: {} })
  const before = readFileSync(statePath, 'utf8')
  writeFileSync(lockPath, JSON.stringify({ pid: 999_999, at: Date.now() })) // fresh, not stale
  const store = newStore({ lock: { retryMs: 1, maxAttempts: 2 } })
  const result = await store.setSessionEnabled('locked', true)
  eq(result.written, false, 'write reported as skipped')
  eq(result.reason, 'lock-timeout', 'reason')
  eq(readFileSync(statePath, 'utf8'), before, 'file untouched')
  eq(store.getSession('locked').enabled, true, 'the change still applies in memory')
  // A stale lock is cleaned up and the next write goes through.
  writeFileSync(lockPath, JSON.stringify({ pid: 1, at: Date.now() - 60_000 }))
  const retry = await store.setSessionEnabled('after-stale', true)
  eq(retry.written, true, 'write after stale-lock cleanup')
  if (existsSync(lockPath)) throw new Error('lock file must be released')
})

check('an unreadable state file is never treated as empty (no wipe)', async () => {
  writeDisk('{ this is not json')
  const store = newStore()
  const result = await store.setEnabled(true)
  eq(result.written, false, 'write skipped')
  eq(result.reason, 'read-failed', 'reason')
  eq(readFileSync(statePath, 'utf8'), '{ this is not json', 'the broken file is preserved for recovery')
  eq(store.state.enabled, true, 'memory still reflects the user action')
})

check('per-session maps are bounded (oldest updatedAt evicted)', async () => {
  writeDisk({ enabled: false, sessions: {} })
  const store = newStore({ maxSessions: 3 })
  for (const id of ['a', 'b', 'c', 'd', 'e']) await store.setSessionEnabled(id, true)
  const disk = readDisk()
  eq(Object.keys(disk.sessions).length, 3, 'cap enforced')
  eq(Object.keys(disk.sessions), ['c', 'd', 'e'], 'newest three survive')
})

check('reloadFromDisk adopts an external (manual) edit', async () => {
  writeDisk({ enabled: false, sessions: {} })
  const store = newStore()
  writeDisk({ enabled: true, sessions: { ext: true } })
  const changed = await store.reloadFromDisk('test')
  eq(changed, true, 'reload detected a change')
  eq(store.state.enabled, true, 'external enabled followed')
  eq(store.getSession('ext').enabled, true, 'external session followed')
})

// ---------- plugin level: two live instances on one DSH_HOME ----------

function makeHost() {
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
  const models = { 'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }], codex: [{ id: 'gpt-6-astra' }] }
  const llm = {
    listProviders: () => providers,
    listModels: async (provider) => models[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'low', name: 'low' }] } }),
  }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} } }
  index.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : undefined),
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
  })
  return {
    disposers,
    call: async (endpoint, payload) => {
      const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
      const request = new Request('http://x/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
      })
      return (await (await route.fetch(request)).json()).result
    },
  }
}

check('two plugin instances: A changes x, B changes y, both survive', async () => {
  writePluginState({ enabled: false, sessions: {} })
  const a = makeHost()
  const b = makeHost()
  await a.call('toggle', { enabled: true, sessionId: 'x' })
  await b.call('toggle', { enabled: true, sessionId: 'y' })
  await a.call('toggle', { enabled: true, sessionId: 'x' }) // A writes again with stale y-unknown memory
  const disk = readPluginState()
  eq(disk.sessions, { x: true, y: true }, 'both keys on disk')
  let got = await b.call('get', {})
  eq(got.value.sessions, { x: true, y: true }, 'B sees A\'s key')
  // The poller (1 s) makes A converge on B's key without a restart.
  await wait(1_400)
  got = await a.call('get', {})
  eq(got.value.sessions, { x: true, y: true }, 'A converges via the file poller')
  eq(typeof got.value.stateRevision, 'number', 'stateRevision exposed')
})

check('an external edit of state.json is picked up by the poller', async () => {
  writePluginState({ enabled: false, sessions: {} })
  const host = makeHost()
  writePluginState({ enabled: true, sessions: { manual: true } })
  await wait(1_400)
  const got = await host.call('get', {})
  eq(got.value.enabled, true, 'external enabled')
  eq(got.value.sessions, { manual: true }, 'external session')
})

check('an external policy.json edit reloads the config; a broken file keeps the old cfg', async () => {
  const { normalizeConfig } = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
  writePluginState({ enabled: false, sessions: {} })
  rmSync(join(pluginDir, 'policy.json'), { force: true })
  const host = makeHost()
  const before = (await host.call('get', {})).value.configRevision
  const external = normalizeConfig({
    revision: 7,
    targets: {
      low: { valley: { provider: 'deepseek-official', model: 'deepseek-flash' }, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], provider: 'deepseek-official', model: 'deepseek-flash' } },
      mid: { share: 'low' },
      high: { share: 'low' },
    },
    advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  })
  writeFileSync(join(pluginDir, 'policy.json'), JSON.stringify(external))
  await wait(1_400)
  let got = await host.call('get', {})
  eq(got.value.configRevision, 7, 'external policy reloaded')
  eq(got.value.config.targets.low.costRouting, false, 'external content applied')
  if (!(got.value.configRevision > before)) throw new Error('revision did not move')

  // A malformed policy must keep the old cfg and log, never fall back to DEFAULTS.
  writeFileSync(join(pluginDir, 'policy.json'), '{ broken json')
  await wait(1_400)
  got = await host.call('get', {})
  eq(got.value.configRevision, 7, 'broken policy keeps the previous cfg')
  eq(got.value.config.targets.low.costRouting, false, 'previous content retained')
  const log = readFileSync(join(pluginDir, 'debug.log'), 'utf8')
  if (!log.includes('policy: reload failed')) throw new Error('a failed policy reload must be logged')
})

check('set rejects a stale expectedRevision with code stale-revision', async () => {
  writePluginState({ enabled: false, sessions: {} })
  const host = makeHost()
  const got = await host.call('get', {})
  const stale = await host.call('set', { config: got.value.config, expectedRevision: (got.value.configRevision ?? 1) - 1 })
  eq([stale.ok, stale.error.code], [false, 'stale-revision'], 'stale rejected')
  if (!stale.error.details || typeof stale.error.details.revision !== 'number') throw new Error('details.revision missing')
  const fresh = await host.call('set', { config: got.value.config, expectedRevision: got.value.configRevision })
  eq(fresh.ok, true, 'matching revision accepted')
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
try { rmSync(root, { recursive: true, force: true }) } catch {}
console.log(failures === 0 ? 'state-sync: 全部通过' : `state-sync: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
