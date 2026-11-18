// The routing seam (§1): the plugin may only change a model through
// `agent.model.select()`, called synchronously from `agent/inbox/inserted` (before
// wakeDriver) or from `agent/turn-stopping` (queued next turn). Nothing may be
// rewritten in `agent/request` — core 0.2.2-rc.1 throws after step preparation.
//
// Assertions U6: immediate effect, ordering, non-user messages, freeze,
// queued followup, switch off, select failure, unroutable + fallback, unknown
// catalog, effort validation, default-model seam.
// Run: node scripts/inbox-routing.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const routing = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { DEFAULTS } = await import(new URL('../lib/text.js', import.meta.url))

console.error = () => {}

const ROUTED = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const SEED = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}

// ---------- fake host ----------

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
  codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

let dirCounter = 0
function makeHost(options = {}) {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-inbox-${process.pid}-${(dirCounter += 1)}`)
  rmSync(root, { recursive: true, force: true })
  const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify(options.state ?? { enabled: true }))
  if (options.policy) writeFileSync(join(pluginDir, 'policy.json'), JSON.stringify(options.policy))

  const listeners = new Map()
  const routes = new Map()
  const registrations = []
  const modelsByProvider = options.models ?? MODELS
  const listModels = options.listModels ?? (async (provider) => modelsByProvider[provider] ?? [])
  const llm = options.llm === false ? null : {
    listProviders: () => PROVIDERS,
    listModels,
    resolveModelInfo: options.resolveModelInfo ?? (async (provider, id) => ({
      provider,
      id,
      name: id,
      reasoning: { efforts: EFFORTS.map((effort) => ({ id: effort, name: effort })) },
    })),
  }
  const agentsService = {
    turnBoundaryOf: (session) => {
      if (!session?.__boundary) throw new Error('fake session has no boundary')
      return session.__boundary
    },
  }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
  const ctx = {
    llm,
    get: (n) => {
      if (n === 'llm') return llm
      if (n === 'agents') return options.agents === false ? undefined : agentsService
      return undefined
    },
    on: (event, fn, opts) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ fn, opts })
      registrations.push({ event, opts })
      return () => {}
    },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    effect: (fn) => { fn(); return () => {} },
  }
  index.apply(ctx, options.config)
  return {
    root,
    pluginDir,
    routes,
    registrations,
    rawListeners: listeners,
    call: async (endpoint, payload) => {
      const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
      if (!route) throw new Error(`no route for ${endpoint}`)
      const request = new Request('http://x/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
      })
      return (await (await route.fetch(request)).json()).result
    },
    // emit = what the harness does for agent notifications: call every listener
    // synchronously and contain throws, like dsh-agent's dispatch.emit().
    emit: (event, payload) => {
      const errors = []
      for (const { fn } of listeners.get(event) ?? []) {
        try { fn(payload) } catch (error) { errors.push(error) }
      }
      return errors
    },
    waterfall: async (event, payload, next) => {
      const chain = (listeners.get(event) ?? []).map((entry) => entry.fn)
      // The last listener is the outermost registered one; invoke in order with
      // the next() tail, mirroring cordis waterfall semantics closely enough.
      let tail = next
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const inner = tail
        tail = () => chain[i](payload, inner)
      }
      return tail()
    },
    debugLog: () => {
      try { return readFileSync(join(pluginDir, 'debug.log'), 'utf8') } catch { return '' }
    },
  }
}

function makeAgent({
  id = 's1',
  provider = SEED.provider,
  model = SEED.model,
  effort = SEED.reasoningEffort,
  withSelect = true,
  selectThrows = false,
} = {}) {
  const boundary = { openTurnStartSeq: null, lastTurn: 0, lastStepStartSeq: null, lastStepBoundary: null }
  const events = []
  const selectCalls = []
  let current = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  const session = {
    header: { id },
    __boundary: boundary,
    append: (type, data) => {
      events.push({ type, data })
      if (type === 'model/selection') current = { ...data }
      return { seq: events.length }
    },
    requestHeader: () => { events.push({ type: 'request/header-read' }); return undefined },
  }
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: withSelect ? {
      current: () => ({ ...current }),
      select: (selection) => {
        selectCalls.push({ ...selection })
        if (selectThrows) throw new Error('injected select failure')
        const next = { provider: selection.provider, model: selection.model }
        if (selection.reasoningEffort !== undefined) next.reasoningEffort = selection.reasoningEffort
        if (JSON.stringify(next) === JSON.stringify(current)) return
        current = next
        events.push({ type: 'select', data: next })
      },
    } : { current: () => ({ ...current }) },
  }
  return {
    agent,
    boundary,
    events,
    selectCalls,
    getCurrent: () => ({ ...current }),
    startTurn: (turn = 1) => { boundary.openTurnStartSeq = 100 + turn; boundary.lastTurn = turn },
    endTurn: () => { boundary.openTurnStartSeq = null },
  }
}

const userMessage = (id, text = 'do the thing') => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
const contextMessage = (id) => ({ id, source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context' }] })

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- checks ----------

check('select is registered on agent/inbox/inserted with { global: true }', () => {
  const host = makeHost()
  const reg = host.registrations.find((entry) => entry.event === 'agent/inbox/inserted')
  if (!reg) throw new Error('agent/inbox/inserted listener was not registered')
  if (reg.opts?.global !== true) throw new Error('inbox listener must use { global: true } to receive other scopes')
  const stopping = host.registrations.find((entry) => entry.event === 'agent/turn-stopping')
  if (!stopping) throw new Error('agent/turn-stopping listener was not registered')
  const request = host.registrations.find((entry) => entry.event === 'agent/request')
  if (!request) throw new Error('agent/request observer was not registered')
  if (request.opts?.prepend === true) throw new Error('the request observer must not prepend/replace anything')
})

check('an idle user message selects the routed target synchronously (before request/header)', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(errors, [], 'the listener must not throw')
  // Read immediately after emit returns: this is preStep()'s synchronous read.
  eq(fake.getCurrent(), ROUTED, 'model.current() right after insert')
  eq(fake.selectCalls.length, 1, 'select called exactly once')
  if (fake.events.some((event) => event.type === 'request/header-read')) throw new Error('select must happen before any request header is read')
  const got = await host.call('get', {})
  eq(got.value.lastDecision.outcome, 'selected', 'outcome')
  eq(got.value.lastDecision.costReason, 'peak-disabled', 'cost reason from the shipped defaults')
})

check('a non-user message (runtime context / notice) never selects', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  const message = contextMessage('c1')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.selectCalls.length, 0, 'no select for a non-user message')
})

check('without an internal/get read the default-model seam is reported missing (never faked)', async () => {
  // Measured on core 0.2.2-rc.1 (headless): agentDefaultModel is resolved
  // directly, so `internal/get` is never dispatched and the wrapper is not in the
  // resolution path. The plugin must say so and keep routing on select().
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  const got = await host.call('get', {})
  eq(got.value.host.defaultSeam, false, 'defaultSeam must report false')
  eq(got.value.host.modelSelect, true, 'modelSelect must report true')
  const log = host.debugLog()
  if (!log.includes('host: default-seam missing')) throw new Error(`the missing default seam must be logged:\n${log}`)
  if (!log.includes('host: model-select present; default-seam missing')) throw new Error(`host summary must say missing:\n${log}`)
})

check('switch off is fully transparent (0 select calls)', async () => {
  const host = makeHost({ state: { enabled: false } })
  await wait()
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.selectCalls.length, 0, 'select calls')
  eq(fake.getCurrent(), SEED, 'model untouched')
  const got = await host.call('get', {})
  eq(got.value.lastDecision, null, 'no decision recorded while disabled')
})

check('a per-session override gates the inbox seam', async () => {
  const host = makeHost({ state: { enabled: false, sessions: { on: true } } })
  await wait()
  const on = makeAgent({ id: 'on' })
  on.agent.inbox.nextTurn.push(userMessage('a'))
  host.emit('agent/inbox/inserted', { agent: on.agent, message: on.agent.inbox.nextTurn[0] })
  eq(on.selectCalls.length, 1, 'override ON routes')
  const off = makeAgent({ id: 'off' })
  off.agent.inbox.nextTurn.push(userMessage('b'))
  host.emit('agent/inbox/inserted', { agent: off.agent, message: off.agent.inbox.nextTurn[0] })
  eq(off.selectCalls.length, 0, 'no override follows the global OFF')
})

check('a mid-turn steer is frozen once the turn has a decision', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  const first = userMessage('m1')
  fake.agent.inbox.nextTurn.push(first)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: first })
  eq(fake.selectCalls.length, 1, 'first select')
  fake.startTurn(1) // turn 1 starts with our decision
  const steer = userMessage('m2')
  fake.agent.inbox.nextStep.push(steer)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: steer })
  eq(fake.selectCalls.length, 1, 'a steer inside the same turn must not re-select')
})

check('a queued next-turn message waits for turn-stopping', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  fake.startTurn(1)
  const queued = userMessage('q1')
  fake.agent.inbox.nextTurn.push(queued)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: queued })
  eq(fake.selectCalls.length, 0, 'a queued followup must NOT select while the turn runs')
  await host.waterfall('agent/turn-stopping', { agent: fake.agent, turn: 1 }, () => {})
  eq(fake.selectCalls.length, 1, 'turn-stopping selects for the next turn')
  eq(fake.getCurrent(), ROUTED, 'target applied')
})

check('turn-stopping does nothing when another listener keeps the turn open', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  fake.startTurn(1)
  fake.agent.inbox.nextTurn.push(userMessage('q1'))
  fake.agent.inbox.nextStep.push(userMessage('s1')) // steered open
  await host.waterfall('agent/turn-stopping', { agent: fake.agent, turn: 1 }, () => {})
  eq(fake.selectCalls.length, 0, 'must not spend the next-turn decision on the current turn')
})

check('select throwing does not reject the event dispatch and produces a warning', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent({ selectThrows: true })
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  // Contains-throws dispatch: this mirrors dsh-agent's emit, which must never
  // reject because one listener misbehaved.
  await assert.doesNotReject(async () => {
    const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
    if (errors.length) throw errors[0]
  })
  const got = await host.call('get', {})
  const warning = got.value.warnings.find((entry) => entry.kind === 'select-failed')
  if (!warning) throw new Error('select-failed warning missing')
  eq(warning.severity, 'error', 'select failure is red')
  eq(got.value.lastDecision.outcome, 'select-failed', 'decision outcome')
})

check('an unroutable model keeps the current model and warns (red)', async () => {
  const policy = routing.normalizeConfig({
    ...DEFAULTS,
    targets: {
      low: { valley: { provider: 'deepseek-official', model: 'does-not-exist' }, costRouting: true, peak: { enabled: false, weekdays: [1], windows: [] , provider: 'deepseek-official', model: 'deepseek-flash' } },
      mid: { share: 'low' },
      high: { share: 'low' },
    },
  })
  const host = makeHost({ policy })
  await wait()
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(errors, [], 'no throw')
  eq(fake.selectCalls.length, 0, 'must not select an unavailable target')
  eq(fake.getCurrent(), SEED, 'current model kept')
  const got = await host.call('get', {})
  const warning = got.value.warnings.find((entry) => entry.kind === 'model')
  if (!warning) throw new Error(`model warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq(warning.severity, 'error', 'severity')
  eq(warning.target, { provider: 'deepseek-official', model: 'does-not-exist' }, 'warning target')
})

check('a cold model catalog means "do not select yet" with an info warning', async () => {
  const host = makeHost({ listModels: () => new Promise(() => {}) })
  await wait(30) // still cold: the listModels promise never settles
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(errors, [], 'no throw')
  eq(fake.selectCalls.length, 0, 'cold catalog must not select')
  const got = await host.call('get', {})
  const warning = got.value.warnings.find((entry) => entry.kind === 'unverified')
  if (!warning) throw new Error(`unverified warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq(warning.severity, 'info', 'cold catalog is yellow, not red')
})

check('llm unavailable means no select and an llm-unavailable info warning', async () => {
  const host = makeHost({ llm: false })
  await wait()
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(errors, [], 'no throw')
  eq(fake.selectCalls.length, 0, 'no select without llm')
  const got = await host.call('get', {})
  const warning = got.value.warnings.find((entry) => entry.kind === 'llm-unavailable')
  if (!warning) throw new Error(`llm-unavailable warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq(warning.severity, 'info', 'severity')
})

check('an unsupported reasoning effort is not selected (red)', async () => {
  const policy = routing.normalizeConfig({
    ...DEFAULTS,
    targets: {
      low: { valley: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'ultra' }, costRouting: true, peak: { enabled: false, weekdays: [1], windows: [], provider: 'deepseek-official', model: 'deepseek-flash' } },
      mid: { share: 'low' },
      high: { share: 'low' },
    },
  })
  const host = makeHost({ policy })
  await wait()
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.selectCalls.length, 0, 'must not select an unsupported effort')
  const got = await host.call('get', {})
  const warning = got.value.warnings.find((entry) => entry.kind === 'effort')
  if (!warning) throw new Error(`effort warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq(warning.severity, 'error', 'severity')
})

check('a target equal to the current model still calls select once and reports noop-same', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent({ provider: ROUTED.provider, model: ROUTED.model, effort: ROUTED.reasoningEffort })
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.selectCalls.length, 1, 'select is always called; the core dedupes')
  const got = await host.call('get', {})
  eq([got.value.lastDecision.outcome, got.value.lastDecision.changed], ['noop-same', false], 'outcome/changed')
})

check('two idle messages in the same pre-turn batch re-decide and keep the last target', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  const first = userMessage('m1', 'first')
  const second = userMessage('m2', 'second')
  fake.agent.inbox.nextTurn.push(first)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: first })
  fake.agent.inbox.nextTurn.push(second)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: second })
  eq(fake.getCurrent(), ROUTED, 'last target in force')
  const got = await host.call('get', {})
  const sameTurn = got.value.recentDecisions.filter((decision) => decision.turn === 1)
  eq(sameTurn.length, 2, 'both inserts decided for turn 1 (turn had not started yet)')
})

check('a core without agent.model.select degrades to host-unsupported (no throw)', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent({ withSelect: false })
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(errors, [], 'no throw')
  const got = await host.call('get', {})
  const warning = got.value.warnings.find((entry) => entry.kind === 'host-unsupported')
  if (!warning) throw new Error(`host-unsupported warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq(got.value.host.modelSelect, false, 'host badge')
})

check('the pre-step / request observers record the effective model without changing it', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  const message = userMessage('m1')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  const selection = fake.getCurrent()
  const enter = { kind: 'enter', messages: [] }
  const preStep = await host.waterfall('agent/pre-step', {
    agent: fake.agent,
    messages: [message],
    turn: 1,
    step: 1,
    modelSelection: selection,
  }, async () => enter)
  assert.equal(preStep, enter, 'the pre-step observer must return the decision unchanged')
  const config = { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
  const observed = await host.waterfall('agent/request', { agent: fake.agent, turn: 1, step: 1 }, async () => config)
  assert.equal(observed, config, 'the request observer must return the config by identity')
  const log = host.debugLog()
  const selectAt = log.indexOf('inbox: select')
  const preStepAt = log.indexOf('pre-step:')
  const requestAt = log.indexOf('request: observed')
  if (selectAt < 0 || preStepAt < 0 || requestAt < 0) throw new Error(`expected select/pre-step/request log lines:\n${log}`)
  if (!(selectAt < preStepAt && preStepAt < requestAt)) throw new Error(`log order must be select -> pre-step -> request:\n${log}`)
  if (!log.includes('pre-step:') || !/match=true/.test(log)) throw new Error(`pre-step must report match=true:\n${log}`)
})

check('the default-model seam (internal/get) is kept, fail-open, and never flattens max', async () => {
  const host = makeHost()
  await wait()
  const listener = host.rawListeners.get('internal/get')?.[0]?.fn
  if (typeof listener !== 'function') throw new Error('internal/get listener was not registered')
  const base = { currentSelection: () => ({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }) }
  const wrapper = listener(undefined, 'agentDefaultModel', undefined, () => base)
  // New sessions preview the routed default (low tier + its peak table).
  eq(wrapper.currentSelection(), ROUTED, 'default seam previews the routed target')
  eq(Object.getPrototypeOf(wrapper), base, 'the wrapper must inherit every other base method')
  // An explicit max default is the user's max axis: never flattened to the plan.
  const maxBase = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }) }
  const maxWrapper = listener(undefined, 'agentDefaultModel', undefined, () => maxBase)
  eq(maxWrapper.currentSelection(), maxBase.currentSelection(), 'max default preserved')
  // Unrelated service requests pass straight through.
  const passthrough = listener(undefined, 'somethingElse', undefined, () => 'base-value')
  eq(passthrough, 'base-value', 'pass-through for other services')
  const got = await host.call('get', {})
  eq(got.value.host.defaultSeam, true, 'the seam observation is reported to the GUI')
  // When routing is off the wrapper must not change anything.
  const offHost = makeHost({ state: { enabled: false } })
  await wait()
  const offListener = offHost.rawListeners.get('internal/get')[0].fn
  const offWrapper = offListener(undefined, 'agentDefaultModel', undefined, () => base)
  eq(offWrapper, base, 'switch off returns the base object untouched')
})

check('the fallback candidate is low.valley, and only for high/mid decisions', () => {
  const cfg = routing.normalizeConfig(DEFAULTS)
  eq(routing.fallbackSelection(cfg, { axis: 'tier', tier: 'high' }), cfg.targets.low.valley, 'high -> low valley')
  eq(routing.fallbackSelection(cfg, { axis: 'tier', tier: 'mid' }), cfg.targets.low.valley, 'mid -> low valley')
  eq(routing.fallbackSelection(cfg, { axis: 'tier', tier: 'low' }), null, 'low itself never diverts')
  eq(routing.fallbackSelection(cfg, { axis: 'max', tier: 'high' }), null, 'the max axis never degrades')
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
console.log(failures === 0 ? 'inbox-routing: 全部通过' : `inbox-routing: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
