// Tier routing end-to-end on the real seam: classify at `agent/inbox/inserted`,
// resolve the tier's cost table, then `agent.model.select()`.
//
// Covers the t6 contract: three tiers reach their own target, one decision per
// turn (a steer must not re-tier / downgrade), tierRouting.enabled=false is
// always low, max keeps its own axis, classifier failures fall back to low,
// cost routing composes on top of the tier, hysteresis spans turns, and
// `agent/request` still never rewrites anything.
// Run: node scripts/tier-routing.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const routing = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { normalizeConfig } = routing

console.error = () => {}

const LOW = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const MID = { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' }
const HIGH = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }
const ADV = { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' }
const SEED = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
  codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}

function table(valley, { costRouting = false, peak } = {}) {
  return {
    valley,
    costRouting,
    peak: peak ?? { enabled: false, weekdays: [1, 2, 3, 4, 5], windows: [], ...valley },
  }
}

function makePolicy(patch = {}) {
  return normalizeConfig({
    utcOffsetMinutes: 480,
    holidays: [],
    tierRouting: { enabled: true, concreteThreshold: 0.55, mediumThreshold: 0.28 },
    targets: {
      low: table(LOW, { costRouting: true }),
      mid: table(MID),
      high: table(HIGH),
    },
    advancedSupport: ADV,
    ...patch,
  })
}

let dirCounter = 0
function makeHost(options = {}) {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-tier-${process.pid}-${(dirCounter += 1)}`)
  rmSync(root, { recursive: true, force: true })
  const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify(options.state ?? { enabled: true }))
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
      reasoning: { efforts: EFFORTS.map((effort) => ({ id: effort, name: effort })) },
    }),
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
    const req = new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
    })
    return (await (await route.fetch(req)).json()).result
  }
  const emit = (event, payload) => {
    const errors = []
    for (const fn of listeners.get(event) ?? []) {
      try { fn(payload) } catch (error) { errors.push(error) }
    }
    return errors
  }
  const waterfall = async (event, payload, next) => {
    const chain = (listeners.get(event) ?? []).map((fn) => fn)
    let tail = next
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const inner = tail
      tail = () => chain[i](payload, inner)
    }
    return tail()
  }
  const debugLog = () => {
    try { return readFileSync(join(pluginDir, 'debug.log'), 'utf8') } catch { return '' }
  }
  return { root, pluginDir, call, emit, waterfall, debugLog, listeners }
}

function makeAgent({ id = 's1', seed = SEED, throwFor = [] } = {}) {
  const boundary = { openTurnStartSeq: null, lastTurn: 0 }
  const events = []
  const selectCalls = []
  let current = { ...seed }
  const session = {
    header: { id },
    __boundary: boundary,
    append: (type, data) => { events.push({ type, data }); if (type === 'model/selection') current = { ...data } },
  }
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: {
      current: () => ({ ...current }),
      select: (selection) => {
        selectCalls.push({ ...selection })
        if (throwFor.includes(selection.model)) throw new Error(`injected select failure for ${selection.model}`)
        const next = { provider: selection.provider, model: selection.model }
        if (selection.reasoningEffort !== undefined) next.reasoningEffort = selection.reasoningEffort
        if (JSON.stringify(next) === JSON.stringify(current)) return
        current = next
        events.push({ type: 'select', data: next })
      },
    },
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

let messageSeq = 0
const userMessage = (text, extra = {}) => ({ id: `m${(messageSeq += 1)}`, source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra })
const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- checks ----------

check('abstract request selects the HIGH tier target and reports score/reasons', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(errors, [], 'listener must not throw')
  eq(fake.getCurrent(), HIGH, 'high target selected')
  const got = await host.call('get', {})
  const decision = got.value.lastDecision
  eq([decision.tier, decision.tierReason], ['high', 'tier-high'], 'tier fields')
  if (typeof decision.score !== 'number') throw new Error(`score must be a number, got ${decision.score}`)
  if (!decision.reasons.includes('abstract')) throw new Error(`reasons must explain the tier: ${JSON.stringify(decision.reasons)}`)
  if (!host.debugLog().includes('tier=high')) throw new Error('the decision log must record tier=high')
})

check('a short command selects the LOW tier target', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const message = userMessage('跑一下测试')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.getCurrent(), LOW, 'low target')
  const got = await host.call('get', {})
  eq(got.value.lastDecision.tier, 'low', 'tier')
})

check('a concrete file edit selects the MID tier target', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const message = userMessage('帮我改 lib/index.js 第 120 行')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.getCurrent(), MID, 'mid target')
  eq((await host.call('get', {})).value.lastDecision.tier, 'mid', 'tier')
})

check('a steer inside the same turn never re-tiers or downgrades', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const first = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(first)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: first })
  eq(fake.getCurrent(), HIGH, 'first decision is high')
  fake.startTurn(1)
  const steer = userMessage('跑一下测试')
  fake.agent.inbox.nextStep.push(steer)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: steer })
  eq(fake.selectCalls.length, 1, 'the steer must not select again')
  eq(fake.getCurrent(), HIGH, 'the turn keeps its first tier (no downgrade)')
})

check('tierRouting.enabled=false always resolves to low, even for abstract text', async () => {
  const host = makeHost({ policy: makePolicy({ tierRouting: { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 } }) })
  await wait()
  const fake = makeAgent()
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.getCurrent(), LOW, 'low target')
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.tier, decision.tierReason, decision.score], ['low', 'tier-disabled', null], 'disabled verdict')
})

check('the max axis wins over tiers (and never falls back to low)', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent({ seed: { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' } })
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.getCurrent(), ADV, 'advanced target')
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.axis, decision.tierReason, decision.costReason], ['max', 'max-advanced', null], 'max axis')
})

check('a classifier failure falls back to low without breaking the event', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const message = {
    id: 'bomb',
    source: { kind: 'user' },
    content: [{ type: 'text', get text() { throw new Error('injected classifier failure') } }],
  }
  fake.agent.inbox.nextTurn.push(message)
  await assert.doesNotReject(async () => {
    const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
    if (errors.length) throw errors[0]
  })
  eq(fake.getCurrent(), LOW, 'fallback target is low')
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.tier, decision.tierReason], ['low', 'tier-fallback-low'], 'fallback verdict')
  const log = host.debugLog()
  if (!log.includes('classify failed')) throw new Error('the failure must be logged')
})

check('cost routing composes on top of the tier (peak window of the HIGH table)', async () => {
  const local = routing.localParts(new Date(), 480)
  const start = Math.max(0, local.minutes - 60)
  const end = Math.min(1439, local.minutes + 60)
  const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const peakTarget = { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
  const policy = makePolicy({
    targets: {
      low: table(LOW, { costRouting: true }),
      mid: table(MID),
      high: table(HIGH, {
        costRouting: true,
        peak: {
          enabled: true,
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          windows: [[hhmm(start), hhmm(end)]],
          ...peakTarget,
        },
      }),
    },
  })
  const host = makeHost({ policy })
  await wait()
  const fake = makeAgent()
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  const decision = (await host.call('get', {})).value.lastDecision
  const expectedPeak = routing.timeInWindows(local.minutes, [[hhmm(start), hhmm(end)]])
  if (expectedPeak) {
    eq([decision.costReason, decision.target], ['peak', peakTarget], 'high-tier peak target')
    eq(fake.getCurrent(), peakTarget, 'selected peak target')
  } else {
    // Only possible in the final minute of a local day (end is exclusive).
    eq([decision.costReason, decision.target], ['peak-outside', HIGH], 'outside the window')
  }
})

check('hysteresis keeps a neighbouring tier across turns', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  // Turn 1: 0.33 -> mid.
  const first = userMessage('帮我改 lib/index.js 第 120 行')
  fake.agent.inbox.nextTurn.push(first)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: first })
  eq(fake.getCurrent(), MID, 'turn 1 is mid')
  fake.startTurn(1)
  fake.endTurn()
  // The loop claims messages when a turn starts; simulate that so turn 2 sees
  // only the new message (the real inbox no longer holds the claimed one).
  fake.agent.inbox.nextTurn.length = 0
  // Turn 2: 0.55 sits exactly on the concrete boundary and is adjacent to mid.
  const second = userMessage('git status')
  fake.agent.inbox.nextTurn.push(second)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: second })
  eq(fake.getCurrent(), MID, 'hysteresis keeps the mid target')
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.tier, decision.hysteresis], ['mid', true], 'decision reports hysteresis')
  if (!host.debugLog().includes('tier-hysteresis')) throw new Error('hysteresis must be logged')
})

check('turn-stopping classifies the queued next-turn text', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  fake.startTurn(1)
  const queued = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(queued)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: queued })
  eq(fake.selectCalls.length, 0, 'queued followup waits')
  await host.waterfall('agent/turn-stopping', { agent: fake.agent, turn: 1 }, () => {})
  eq(fake.getCurrent(), HIGH, 'turn-stopping applies the classified tier')
  const got = await host.call('get', {})
  eq(got.value.lastDecision.via, 'turn-stopping', 'decision source')
})

check('pre-step only observes (no second select, returns the decision unchanged)', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  const selected = fake.getCurrent()
  const enter = { kind: 'enter', messages: [] }
  const out = await host.waterfall('agent/pre-step', {
    agent: fake.agent,
    messages: [message],
    turn: 1,
    step: 1,
    modelSelection: selected,
  }, async () => enter)
  assert.equal(out, enter, 'pre-step decision must be returned unchanged')
  eq(fake.selectCalls.length, 1, 'no extra select from pre-step')
  if (!/pre-step: .*match=true/.test(host.debugLog())) throw new Error('pre-step must observe match=true')
})

check('agent/request still returns the downstream config by identity after a tier decision', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  const listener = host.listeners.get('agent/request')?.[0]
  if (typeof listener !== 'function') throw new Error('agent/request observer missing')
  const config = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }
  const out = await listener({ agent: fake.agent, turn: 1, step: 1 }, async () => config)
  assert.equal(out, config, 'agent/request must never rewrite')
})

check('an image-only message has no text and uses the low fallback', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent()
  const message = { id: 'img', source: { kind: 'user' }, content: [{ type: 'image' }] }
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(fake.getCurrent(), LOW, 'low target')
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.tier, decision.tierReason, decision.score], ['low', 'tier-fallback-low', null], 'fallback verdict')
})

check('a failed select falls back to low for a tier target', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const fake = makeAgent({ throwFor: ['gpt-6-astra'] })
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  const errors = host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  eq(errors, [], 'the event must not throw')
  const decision = (await host.call('get', {})).value.lastDecision
  eq(decision.warningKind, 'select-failed', 'warning kind')
  eq(decision.fallback, 'low', 'fallback marker')
  eq(decision.appliedTarget, LOW, 'the applied target is the low valley')
  eq(fake.getCurrent(), LOW, 'current model is the low target')
  const warning = (await host.call('get', {})).value.warnings.find((entry) => entry.kind === 'select-failed')
  if (!warning) throw new Error('select-failed warning missing')
})

check('a failed select on the max axis never falls back to low', async () => {
  const host = makeHost({ policy: makePolicy() })
  await wait()
  const seed = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }
  const fake = makeAgent({ seed, throwFor: ['deepseek-chat'] })
  const message = userMessage('为什么这样设计？')
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.axis, decision.outcome, decision.fallback], ['max', 'select-failed', null], 'max keeps current')
  eq(fake.getCurrent(), seed, 'the max request is not silently degraded to low')
  if (fake.selectCalls.some((call) => call.model === 'deepseek-flash')) throw new Error('the max axis must not retry the low target')
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
console.log(failures === 0 ? 'tier-routing: 全部通过' : `tier-routing: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
