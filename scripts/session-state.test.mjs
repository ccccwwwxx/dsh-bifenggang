// Per-session switch state: routing is gated per session, a session with no
// override follows the global default, and an override can be cleared.
//
// The session id comes from the agent/request payload (`agent.session.header.id`)
// — this is the contract the whole feature rests on, so it is asserted here.
// Run: node scripts/session-state.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { DEFAULTS } = await import(new URL('../lib/text.js', import.meta.url))

// The plugin reports through console.error as well as debug.log; the cap test
// alone would print 500 lines otherwise, burying the assertions.
console.error = () => {}

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const base = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-session-${process.pid}`)
const pluginDir = join(base, 'plugins', 'dsh-peak-valley-router')
const statePath = join(pluginDir, 'state.json')

/** Fake host: enough of the two seams plus the RPC channel to exercise routing. */
function makeHostWithListener(options = {}) {
  const recorded = { 'agent/request': [] }
  const originalApply = mod.apply
  const host = (() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(pluginDir, { recursive: true })
    process.env.DSH_HOME = base
    writeFileSync(statePath, options.legacyState
      ? JSON.stringify({ enabled: options.enabled === true })
      : JSON.stringify({ enabled: options.enabled === true, sessions: options.sessions ?? {} }))
    const routes = new Map()
    const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
    const models = {
      'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
      codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
    }
    const llm = { listProviders: () => providers, listModels: async (p) => models[p] ?? [] }
    const connection = { fetch: { register: (r) => { routes.set(r.path, r); return () => {} } } }
    const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
    originalApply({
      llm,
      get: (n) => (n === 'llm' ? llm : undefined),
      on: (event, fn) => { (recorded[event] ??= []).push(fn); return () => {} },
      inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    })
    return { routes, llm }
  })()
  const call = async (endpoint, payload) => {
    const route = host.routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
    if (!route) throw new Error(`no route for ${endpoint}`)
    const req = new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
    })
    return (await (await route.fetch(req)).json()).result
  }
  const agentFor = (id) => (id === null ? undefined
    : options.sessionIdPath === 'getter' ? { session: { id } } : { session: { header: { id } } })
  /** Run the plugin's agent/request listener for one session. */
  const route = async (sessionId, seed) => {
    const listener = recorded['agent/request'][0]
    if (!listener) throw new Error('agent/request listener was not registered')
    let nextCalls = 0
    return listener({ agent: agentFor(sessionId) }, async () => { nextCalls += 1; return seed })
  }
  return { call, route, readState: () => JSON.parse(readFileSync(statePath, 'utf8')) }
}

const SEED = { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'low', sessionId: 'x' }

check('global off + no override -> the resolved request is returned by identity', async () => {
  const host = makeHostWithListener({ enabled: false })
  const out = await host.route('sessionA', SEED)
  if (out !== SEED) throw new Error('a disabled session must pass the exact object through')
})

check('a per-session override ON routes that session while others stay off', async () => {
  const host = makeHostWithListener({ enabled: false, sessions: { sessionA: true } })
  const a = await host.route('sessionA', SEED)
  const b = await host.route('sessionB', SEED)
  if (a === SEED) throw new Error('sessionA has an explicit ON override and must be routed')
  if (b !== SEED) throw new Error('sessionB has no override and must follow the global OFF default')
  console.log(`      sessionA -> ${a.provider}/${a.model}@${a.reasoningEffort}; sessionB untouched`)
})

check('a per-session override OFF suppresses routing while the default is ON', async () => {
  const host = makeHostWithListener({ enabled: true, sessions: { sessionA: false } })
  const a = await host.route('sessionA', SEED)
  const b = await host.route('sessionB', SEED)
  if (a !== SEED) throw new Error('sessionA has an explicit OFF override and must not be routed')
  if (b === SEED) throw new Error('sessionB must follow the global ON default')
})

check('the session id is read from agent.session.header.id (and from the id getter)', async () => {
  const viaHeader = makeHostWithListener({ enabled: false, sessions: { sessionA: true } })
  if (await viaHeader.route('sessionA', SEED) === SEED) throw new Error('header.id was not read')
  const viaGetter = makeHostWithListener({ enabled: false, sessions: { sessionA: true }, sessionIdPath: 'getter' })
  if (await viaGetter.route('sessionA', SEED) === SEED) throw new Error('session.id getter was not read')
})

check('an unreadable session id falls back to the global default (never silently off)', async () => {
  const host = makeHostWithListener({ enabled: true })
  const out = await host.route(null, SEED)
  if (out === SEED) throw new Error('with the default ON and no session id, routing must still apply')
})

check('a legacy state.json without `sessions` behaves exactly as before', async () => {
  const host = makeHostWithListener({ enabled: true, legacyState: true })
  const out = await host.route('sessionA', SEED)
  if (out === SEED) throw new Error('legacy state must still route when enabled')
  const got = await host.call('get', {})
  eq(got.value.sessions, {}, 'legacy state exposes an empty sessions map')
})

check('toggle with a sessionId sets and clears that session override', async () => {
  const host = makeHostWithListener({ enabled: false })
  const on = await host.call('toggle', { enabled: true, sessionId: 'sessionA' })
  eq([on.value.sessionEnabled, on.value.sessions.sessionA], [true, true], 'set override')
  if (await host.route('sessionA', SEED) === SEED) throw new Error('sessionA must now route')
  const inherited = await host.call('toggle', { sessionId: 'sessionA', inherit: true })
  eq([inherited.value.sessionEnabled, 'sessionA' in inherited.value.sessions], [false, false], 'cleared override')
  if (await host.route('sessionA', SEED) !== SEED) throw new Error('after clearing, sessionA must follow the global default')
})

check('toggle without a sessionId changes the default and leaves overrides alone', async () => {
  const host = makeHostWithListener({ enabled: false, sessions: { sessionA: true } })
  const res = await host.call('toggle', { enabled: true })
  eq(res.value.enabled, true, 'default enabled')
  eq(res.value.sessions.sessionA, true, 'existing override preserved')
  const st = host.readState()
  eq([st.enabled, st.sessions.sessionA], [true, true], 'persisted shape')
})

check('toggle with no `enabled` flips the effective session value', async () => {
  const host = makeHostWithListener({ enabled: false })
  const first = await host.call('toggle', { sessionId: 'sessionA' })
  eq(first.value.sessionEnabled, true, 'flip off -> on')
  const second = await host.call('toggle', { sessionId: 'sessionA' })
  eq(second.value.sessionEnabled, false, 'flip on -> off')
})

check('an id like "__proto__" is stored as a normal own override', async () => {
  // On a plain object, `sessions['__proto__'] = true` is swallowed by the
  // prototype setter: the override would look saved and never gate anything.
  const host = makeHostWithListener({ enabled: false })
  const res = await host.call('toggle', { enabled: true, sessionId: '__proto__' })
  eq(res.value.sessionEnabled, true, 'toggle reports it on')
  if (await host.route('__proto__', SEED) === SEED) throw new Error('the override must actually gate routing')
  const st = host.readState()
  if (!Object.prototype.hasOwnProperty.call(st.sessions, '__proto__')) throw new Error('must be an own key on disk')
  eq(st.sessions['__proto__'], true, 'persisted value')
})

check('the override map is bounded and evicts the least recently written session', async () => {
  const cap = 500
  const host = makeHostWithListener({ enabled: false })
  for (let i = 0; i < cap + 5; i++) await host.call('toggle', { enabled: true, sessionId: `s${i}` })
  const st = host.readState()
  const ids = Object.keys(st.sessions)
  eq(ids.length, cap, 'map stays at the cap')
  if ('s0' in st.sessions) throw new Error('the oldest session should have been evicted')
  if (!(`s${cap + 4}` in st.sessions)) throw new Error('the newest session must be present')
})

check('get exposes the whole override map so the session list can render it', async () => {
  const host = makeHostWithListener({ enabled: false, sessions: { sessionA: true, sessionB: false } })
  const got = await host.call('get', {})
  eq(got.value.sessions, { sessionA: true, sessionB: false }, 'sessions map')
  eq(typeof got.value.version, 'string', 'version still exposed')
  eq(Boolean(got.value.config), true, 'config still exposed')
})

for (const [name, fn] of pending) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}
console.log(failures === 0 ? 'session-state: 全部通过' : `session-state: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
