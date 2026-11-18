// Per-session switch state on the NEW seam.
//
// 0.16.0 replaced the agent/request rewrite with `agent.model.select()` driven by
// `agent/inbox/inserted` (docs/ROUTING_V2_DESIGN.md §1). The per-session gate is
// unchanged in intent, so every 0.15 assertion is kept and re-pointed at the new
// observable: the model an agent's `model.current()` reports right after a user
// message enters the inbox.
// Run: node scripts/session-state.test.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
  codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
}

/** Fake host: the inbox seam, the default-model seam and the RPC channel. */
function makeHost(options = {}) {
  rmSync(base, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = base
  writeFileSync(statePath, options.legacyState
    ? JSON.stringify({ enabled: options.enabled === true })
    : JSON.stringify({ enabled: options.enabled === true, sessions: options.sessions ?? {} }))
  if (options.policy) writeFileSync(join(pluginDir, 'policy.json'), JSON.stringify(options.policy))
  const listeners = new Map()
  const routes = new Map()
  const llm = {
    listProviders: () => PROVIDERS,
    listModels: async (provider) => MODELS[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({
      provider,
      id,
      name: id,
      reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ id: effort, name: effort })) },
    }),
  }
  const agentsService = { turnBoundaryOf: (session) => session.__boundary }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
  mod.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : n === 'agents' ? (options.agents === false ? undefined : agentsService) : undefined),
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    effect: (fn) => { fn(); return () => {} },
  })
  const emit = (event, payload) => { for (const fn of listeners.get(event) ?? []) fn(payload) }
  const call = async (endpoint, payload) => {
    const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
    if (!route) throw new Error(`no route for ${endpoint}`)
    const req = new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
    })
    return (await (await route.fetch(req)).json()).result
  }
  // Build a fake agent whose session id is reachable through the 0.14/0.15 paths.
  const agentFor = (id, seed = SEED, { withSelect = true } = {}) => {
    let current = { ...seed }
    const boundary = { openTurnStartSeq: null, lastTurn: 0 }
    const session = { __boundary: boundary, append: (type, data) => { if (type === 'model/selection') current = { ...data } } }
    if (options.sessionIdPath === 'direct') session.__idDirect = id
    if (options.sessionIdPath === 'getter') session.id = id
    else session.header = { id }
    const agent = {
      id,
      session,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      model: withSelect ? {
        current: () => ({ ...current }),
        select: (selection) => {
          const next = { provider: selection.provider, model: selection.model }
          if (selection.reasoningEffort !== undefined) next.reasoningEffort = selection.reasoningEffort
          if (JSON.stringify(next) === JSON.stringify(current)) return
          current = next
          session.append('model/selection', next)
        },
      } : { current: () => ({ ...current }) },
    }
    if (options.sessionIdPath === 'direct') {
      Object.defineProperty(agent, 'id', { get: () => id })
      delete agent.session.header
    }
    return { agent, getCurrent: () => ({ ...current }) }
  }
  /** Put one user message in the inbox and dispatch the seam. Returns the model in force. */
  const route = (sessionId, seed) => {
    const fake = agentFor(sessionId, seed)
    const message = { id: `msg-${Math.random().toString(36).slice(2)}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    fake.agent.inbox.nextTurn.push(message)
    emit('agent/inbox/inserted', { agent: fake.agent, message })
    return fake.getCurrent()
  }
  return {
    call,
    route,
    agentFor,
    emit,
    readState: () => JSON.parse(readFileSync(statePath, 'utf8')),
    setState: (value) => writeFileSync(statePath, JSON.stringify(value)),
  }
}

const SEED = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }
const ROUTED = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

check('current core agent.id honors per-session overrides', async () => {
  const host = makeHost({ enabled: false, sessions: { sessionA: true }, sessionIdPath: 'direct' })
  await wait()
  eq(host.route('sessionA'), ROUTED, 'direct session id routed')
  eq(host.route('sessionB'), SEED, 'other session untouched')
})

check('global off + no override -> the model is returned untouched', async () => {
  const host = makeHost({ enabled: false })
  await wait()
  eq(host.route('sessionA'), SEED, 'a disabled session must stay on its model')
})

check('a per-session override ON routes that session while others stay off', async () => {
  const host = makeHost({ enabled: false, sessions: { sessionA: true } })
  await wait()
  eq(host.route('sessionA'), ROUTED, 'sessionA has an explicit ON override')
  eq(host.route('sessionB'), SEED, 'sessionB follows the global OFF default')
})

check('a per-session override OFF suppresses routing while the default is ON', async () => {
  const host = makeHost({ enabled: true, sessions: { sessionA: false } })
  await wait()
  eq(host.route('sessionA'), SEED, 'sessionA has an explicit OFF override')
  eq(host.route('sessionB'), ROUTED, 'sessionB follows the global ON default')
})

check('the session id is read from agent.session.header.id (and from the id getter)', async () => {
  const viaHeader = makeHost({ enabled: false, sessions: { sessionA: true } })
  await wait()
  eq(viaHeader.route('sessionA'), ROUTED, 'header.id was read')
  const viaGetter = makeHost({ enabled: false, sessions: { sessionA: true }, sessionIdPath: 'getter' })
  await wait()
  eq(viaGetter.route('sessionA'), ROUTED, 'session.id getter was read')
})

check('an unreadable session id falls back to the global default (never silently off)', async () => {
  const host = makeHost({ enabled: true })
  await wait()
  const fake = host.agentFor(undefined, SEED)
  delete fake.agent.session.header
  const message = { id: 'm', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.getCurrent(), ROUTED, 'with the default ON and no session id, routing must still apply')
})

check('a legacy state.json without `sessions` behaves exactly as before', async () => {
  const host = makeHost({ enabled: true, legacyState: true })
  await wait()
  eq(host.route('sessionA'), ROUTED, 'legacy state must still route when enabled')
  const got = await host.call('get', {})
  eq(got.value.sessions, {}, 'legacy state exposes an empty sessions map')
})

check('toggle with a sessionId sets and clears that session override', async () => {
  const host = makeHost({ enabled: false })
  await wait()
  const on = await host.call('toggle', { enabled: true, sessionId: 'sessionA' })
  eq([on.value.sessionEnabled, on.value.sessions.sessionA], [true, true], 'set override')
  eq(host.route('sessionA'), ROUTED, 'sessionA now routes')
  const inherited = await host.call('toggle', { sessionId: 'sessionA', inherit: true })
  eq([inherited.value.sessionEnabled, 'sessionA' in inherited.value.sessions], [false, false], 'cleared override')
  eq(host.route('sessionA'), SEED, 'after clearing, sessionA follows the global default')
})

check('toggle without a sessionId changes the default and leaves overrides alone', async () => {
  const host = makeHost({ enabled: false, sessions: { sessionA: true } })
  const res = await host.call('toggle', { enabled: true })
  eq(res.value.enabled, true, 'default enabled')
  eq(res.value.sessions.sessionA, true, 'existing override preserved')
  const st = host.readState()
  eq([st.enabled, st.sessions.sessionA], [true, true], 'persisted shape')
})

check('toggle with no `enabled` flips the effective session value', async () => {
  const host = makeHost({ enabled: false })
  const first = await host.call('toggle', { sessionId: 'sessionA' })
  eq(first.value.sessionEnabled, true, 'flip off -> on')
  const second = await host.call('toggle', { sessionId: 'sessionA' })
  eq(second.value.sessionEnabled, false, 'flip on -> off')
})

check('an id like "__proto__" is stored as a normal own override and actually gates', async () => {
  // On a plain object, `sessions['__proto__'] = true` is swallowed by the
  // prototype setter: the override would look saved and never gate anything.
  const host = makeHost({ enabled: false })
  await wait()
  const res = await host.call('toggle', { enabled: true, sessionId: '__proto__' })
  eq(res.value.sessionEnabled, true, 'toggle reports it on')
  eq(host.route('__proto__'), ROUTED, 'the override must actually gate routing')
  const st = host.readState()
  if (!Object.prototype.hasOwnProperty.call(st.sessions, '__proto__')) throw new Error('must be an own key on disk')
  eq(st.sessions['__proto__'], true, 'persisted value')
})

check('a malformed sessionId is rejected instead of silently becoming a global toggle', async () => {
  const host = makeHost({ enabled: true })
  for (const bad of [12345, true, {}, ['x'], '']) {
    const res = await host.call('toggle', { sessionId: bad, enabled: false })
    if (res?.ok !== false || res?.error?.code !== 'bad-request') {
      throw new Error(`sessionId=${JSON.stringify(bad)} must be bad-request, got ${JSON.stringify(res)}`)
    }
  }
  const st = host.readState()
  eq(st.enabled, true, 'a rejected toggle must not change the global default')
  eq(st.sessions, {}, 'a rejected toggle must not write an override')
})

check('toggle without `enabled` flips the global default too (same shape as the session branch)', async () => {
  const host = makeHost({ enabled: false })
  const first = await host.call('toggle', {})
  eq(first.value.enabled, true, 'flip off -> on')
  const second = await host.call('toggle', {})
  eq(second.value.enabled, false, 'flip on -> off')
})

check('a decoupled session keeps its own value across global flips (both directions)', async () => {
  const host = makeHost({ enabled: true })
  await wait()
  await host.call('toggle', { enabled: false, sessionId: 'sessionB' }) // decouple B at OFF
  eq(host.route('sessionB'), SEED, 'B must be off while decoupled at OFF')
  await host.call('toggle', { enabled: false }) // global off
  eq(host.route('sessionB'), SEED, 'B must not start routing when the global goes off')
  await host.call('toggle', { enabled: true }) // global sweeps back on
  eq(host.route('sessionB'), SEED, 'B must NOT follow the sweep back on')

  await host.call('toggle', { enabled: true, sessionId: 'sessionC' }) // decouple C at ON
  await host.call('toggle', { enabled: false }) // global off
  eq(host.route('sessionC'), ROUTED, 'C must keep routing although the global went off')

  await host.call('toggle', { sessionId: 'sessionC', inherit: true }) // re-couple
  eq(host.route('sessionC'), SEED, 'after re-coupling, C must follow the global (OFF)')
})

check('closing the switch restores the pre-plugin model of a routed live agent', async () => {
  const host = makeHost({ enabled: true })
  await wait()
  const fake = host.agentFor('sessionR', SEED)
  const message = { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.getCurrent(), ROUTED, 'routed')
  await host.call('toggle', { enabled: false })
  eq(fake.getCurrent(), SEED, 'restored to the pre-plugin model')
  const details = await host.call('get', {})
  eq(details.value.sessionDetails.sessionR.applied, null, 'applied cleared after restore')
})

check('the advanced thinking model is used ONLY when the baseline asks for max reasoning', async () => {
  // Separate axis from the time plans: max thinking -> advanced model; an
  // ordinary request is never escalated to it. This is the definition whose
  // absence silently pushed whole weekends onto the frontier model.
  const host = makeHost({ enabled: true })
  await wait()
  const advanced = host.route('sessionA', { ...SEED, reasoningEffort: 'max' })
  eq(advanced, {
    provider: DEFAULTS.advancedSupport.provider,
    model: DEFAULTS.advancedSupport.model,
    reasoningEffort: DEFAULTS.advancedSupport.reasoningEffort,
  }, 'max baseline target')

  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const out = host.route('sessionB', { ...SEED, reasoningEffort: effort })
    if (
      out.provider === DEFAULTS.advancedSupport.provider
      && out.model === DEFAULTS.advancedSupport.model
      && out.reasoningEffort === DEFAULTS.advancedSupport.reasoningEffort
    ) {
      throw new Error(`an effort=${effort} baseline must not be escalated to the advanced thinking model`)
    }
  }

  const shipped = [
    ...['low', 'mid', 'high'].map((tier) => ({ table: DEFAULTS.targets[tier], tier })),
    { table: { valley: DEFAULTS.advancedSupport }, tier: 'advancedSupport' },
  ]
  for (const { table, tier } of shipped) {
    const targets = [table.valley, table.peak].filter((target) => target && target.provider)
    for (const target of targets) {
      if (target.provider !== 'deepseek-official' || target.model !== 'deepseek-flash') {
        throw new Error(`quota-exhausted defaults must stay on the official DeepSeek Flash route (${tier})`)
      }
    }
  }
})

check('the default policy keeps peak disabled, so a peak-window instant resolves to the valley', async () => {
  const host = makeHost({ enabled: true })
  await wait()
  for (const [iso, label] of [
    ['2026-10-14T02:00:00Z', 'Wed 10:00 Beijing (09:00-12:00 window)'],
    ['2026-10-14T07:00:00Z', 'Wed 15:00 Beijing (14:00-18:00 window)'],
    ['2026-10-17T02:00:00Z', 'Sat 10:00 Beijing'],
  ]) {
    const at = new Date(iso)
    const decision = mod.decide(at, mod.normalizeConfig(DEFAULTS))
    eq(decision.costReason, 'peak-disabled', `${label}: defaults must not switch to peak`)
    eq(decision.tier, 'low', `${label}: tier must be low`)
    eq(decision.target, DEFAULTS.targets.low.valley, `${label} target`)
  }
  // and the seam agrees with the pure decision at "now" only by construction;
  // this assertion is about the shipped defaults, not the wall clock.
})

check('tierRouting.enabled=false is equivalent to 0.15 (always the low table)', () => {
  const cfg = mod.normalizeConfig(DEFAULTS)
  if (cfg.tierRouting.enabled !== false) throw new Error('defaults must keep tier routing off')
  const decision = mod.decide(new Date('2026-10-14T02:00:00Z'), cfg, { tier: 'high' })
  eq([decision.tier, decision.tierReason, decision.target], ['low', 'tier-disabled', cfg.targets.low.valley], 'forced low')
})

check('the override map is bounded and evicts the least recently written session', async () => {
  const cap = 500
  const host = makeHost({ enabled: false })
  for (let i = 0; i < cap + 5; i++) await host.call('toggle', { enabled: true, sessionId: `s${i}` })
  const st = host.readState()
  const ids = Object.keys(st.sessions)
  eq(ids.length, cap, 'map stays at the cap')
  if ('s0' in st.sessions) throw new Error('the oldest session should have been evicted')
  if (!(`s${cap + 4}` in st.sessions)) throw new Error('the newest session must be present')
})

check('an integer-like id is not evicted early (object key order would do exactly that)', async () => {
  // JS objects enumerate integer-like keys first, in ascending order, so a
  // delete-then-set does NOT move "0" to the end. With a plain object the
  // just-written override was evicted as if it were the oldest entry — the same
  // silent-drop class as the "__proto__" bug.
  const host = makeHost({ enabled: false })
  await wait()
  for (let i = 0; i < 498; i++) await host.call('toggle', { enabled: true, sessionId: `s${i}` })
  await host.call('toggle', { enabled: true, sessionId: '0' }) // most recently written
  if (!Object.keys(host.readState().sessions).includes('0')) throw new Error('"0" must be present right after being set')
  for (let i = 0; i < 3; i++) await host.call('toggle', { enabled: true, sessionId: `t${i}` })
  const st = host.readState()
  const ids = Object.keys(st.sessions)
  eq(ids.length, 500, 'map stays at the cap')
  if (!('0' in st.sessions)) throw new Error('the most recently written id "0" must survive the overflow')
  if ('s0' in st.sessions || 's1' in st.sessions) throw new Error('the least recently written ids must be evicted instead')
  eq(host.route('0'), ROUTED, '"0" must still gate routing')
})

check('get exposes the whole override map plus the v2 config and host facts', async () => {
  const host = makeHost({ enabled: false, sessions: { sessionA: true, sessionB: false } })
  await wait()
  const got = await host.call('get', {})
  eq(got.value.sessions, { sessionA: true, sessionB: false }, 'sessions map')
  eq(typeof got.value.version, 'string', 'version still exposed')
  eq(Boolean(got.value.config.targets?.low?.valley), true, 'config is canonical v2')
  eq(Boolean(got.value.effective?.high?.valley), true, 'effective tables exposed')
  eq(typeof got.value.host?.modelSelect, 'boolean', 'host badge exposed')
  eq(Array.isArray(got.value.warnings), true, 'warnings exposed')
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
