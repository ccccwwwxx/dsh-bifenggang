// AgentTeams member deliveries are user intent (t17).
//
// Root cause fixed here: `agent/inbox/inserted` used to accept only
// `source.kind === 'user'`. AgentTeams delivers member/captain instructions with
// `{ kind: 'agent-teams' }` (see @nanmicoder/dsh-agent-teams
// members.js#agentTeamsSource), so members were never routed. Injected context
// (`runtime-context`, `system-prompt`, `model-selection`, `subagent-settled`)
// must stay excluded.
//
// Run: node scripts/agent-teams-source.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const classifier = await import(pathToFileURL(join(here, '..', 'lib', 'classifier.js')).href)
const routing = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { normalizeConfig } = routing

console.error = () => {}

const LOW = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' }
const HIGH = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }
const SEED = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
  codex: [{ id: 'gpt-6-astra' }],
}

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

const policy = normalizeConfig({
  utcOffsetMinutes: 480,
  holidays: [],
  tierRouting: { enabled: true, concreteThreshold: 0.55, mediumThreshold: 0.28 },
  targets: {
    low: { valley: LOW, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], ...LOW } },
    mid: { valley: LOW, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], ...LOW } },
    high: { valley: HIGH, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], ...HIGH } },
  },
  advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
})

let dirCounter = 0
function makeHost() {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-teams-${process.pid}-${(dirCounter += 1)}`)
  rmSync(root, { recursive: true, force: true })
  const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify({ enabled: true }))
  writeFileSync(join(pluginDir, 'policy.json'), JSON.stringify(policy))
  const listeners = new Map()
  const routes = new Map()
  const llm = {
    listProviders: () => PROVIDERS,
    listModels: async (provider) => MODELS[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({
      provider,
      id,
      name: id,
      reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'max', name: 'max' }] },
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
  return {
    pluginDir,
    emit: (event, payload) => {
      const errors = []
      for (const fn of listeners.get(event) ?? []) {
        try { fn(payload) } catch (error) { errors.push(error) }
      }
      return errors
    },
    call: async (endpoint, payload) => {
      const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
      const request = new Request('http://x/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
      })
      return (await (await route.fetch(request)).json()).result
    },
    debugLog: () => {
      try { return readFileSync(join(pluginDir, 'debug.log'), 'utf8') } catch { return '' }
    },
  }
}

function makeAgent({ id = 'member-session-1', seed = SEED } = {}) {
  const boundary = { openTurnStartSeq: null, lastTurn: 0 }
  const selectCalls = []
  let current = { ...seed }
  const session = { header: { id }, __boundary: boundary, append: (type, data) => { if (type === 'model/selection') current = { ...data } } }
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: {
      current: () => ({ ...current }),
      select: (selection) => {
        selectCalls.push({ ...selection })
        const next = { provider: selection.provider, model: selection.model }
        if (selection.reasoningEffort !== undefined) next.reasoningEffort = selection.reasoningEffort
        if (JSON.stringify(next) === JSON.stringify(current)) return
        current = next
      },
    },
  }
  return {
    agent,
    boundary,
    selectCalls,
    getCurrent: () => ({ ...current }),
    startTurn: (turn = 1) => { boundary.openTurnStartSeq = 100 + turn; boundary.lastTurn = turn },
  }
}

let messageSeq = 0
const message = (text, kind = 'agent-teams') => ({
  id: `m${(messageSeq += 1)}`,
  source: { kind },
  content: [{ type: 'text', text }],
})
const deliver = (host, fake, text, kind = 'agent-teams') => {
  const msg = message(text, kind)
  fake.agent.inbox.nextTurn.push(msg)
  return host.emit('agent/inbox/inserted', { agent: fake.agent, message: msg })
}

// ---------- prefix stripping (pure) ----------

check('stripDeliveryPrefix removes the AgentTeams / Agent sent-a-message header only', () => {
  eq(classifier.stripDeliveryPrefix('AgentTeams message from member t7:\n\n跑一下测试'), '跑一下测试', 'agent-teams header')
  eq(classifier.stripDeliveryPrefix('AgentTeams message from member core-engineer:\n\n请修一下'), '请修一下', 'member header')
  eq(classifier.stripDeliveryPrefix('Agent b36eb7a1 sent a message:\n\n跑一下测试'), '跑一下测试', 'agent sent header')
  eq(classifier.stripDeliveryPrefix('跑一下测试'), '跑一下测试', 'plain text unchanged')
  eq(classifier.stripDeliveryPrefix('AgentTeams 是一个多智能体协作插件'), 'AgentTeams 是一个多智能体协作插件', 'ordinary text unchanged')
  eq(classifier.stripDeliveryPrefix(''), '', 'empty')
  const signals = classifier.collectFromMessages([
    { source: { kind: 'agent-teams' }, content: [{ type: 'text', text: 'AgentTeams message from member t7:\n\n跑一下测试' }] },
  ])
  eq(signals.text, '跑一下测试', 'collectFromMessages strips the header')
})

check('a prefixed body classifies exactly like the bare body', () => {
  const prefixed = classifier.classify(classifier.collectFromMessages([
    { source: { kind: 'agent-teams' }, content: [{ type: 'text', text: 'AgentTeams message from member t7:\n\n把 lib/state.js 的写入顺序改成先 merge 再写盘。' }] },
  ]))
  const bare = classifier.classify('把 lib/state.js 的写入顺序改成先 merge 再写盘。')
  eq([prefixed.tier, prefixed.score, prefixed.reasons], [bare.tier, bare.score, bare.reasons], 'same verdict')
  eq(prefixed.tier, 'mid', 'the prefix does not drag a scoped edit around')
})

// ---------- plugin-level: agent-teams deliveries are routed ----------

check('source.kind="agent-teams" triggers a decision and select', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  const errors = deliver(host, fake, '跑一下测试')
  eq(errors, [], 'no throw')
  eq(fake.selectCalls.length, 1, 'select was called')
  eq(fake.getCurrent(), LOW, 'routed to the low target')
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.tier, decision.outcome, decision.sessionId], ['low', 'selected', 'member-session-1'], 'decision recorded')
  eq(typeof decision.score, 'number', 'score present')
  if (!host.debugLog().includes('inbox: decision')) throw new Error('the decision must be logged for member sessions')
})

check('a prefixed agent-teams message routes identically to a bare user message', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent({ id: 'member-session-2' })
  deliver(host, fake, 'AgentTeams message from member t7:\n\n跑一下测试')
  const memberDecision = (await host.call('get', {})).value.lastDecision
  const userFake = makeAgent({ id: 'user-session' })
  deliver(host, userFake, '跑一下测试', 'user')
  const userDecision = (await host.call('get', {})).value.lastDecision
  eq(
    [memberDecision.tier, memberDecision.score, memberDecision.reasons, memberDecision.tierReason],
    [userDecision.tier, userDecision.score, userDecision.reasons, userDecision.tierReason],
    'same classification after prefix stripping',
  )
  eq(fake.getCurrent(), userFake.getCurrent(), 'same target')
})

check('"Agent <id> sent a message" prefixes are stripped too', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent({ id: 'member-session-3' })
  deliver(host, fake, 'Agent b36eb7a1 sent a message:\n\n为什么这样设计？')
  const decision = (await host.call('get', {})).value.lastDecision
  eq([decision.tier, decision.tierReason], ['high', 'tier-high'], 'abstract body stays abstract')
  eq(fake.getCurrent(), HIGH, 'high target selected')
})

check('injected context and notices never trigger a decision', async () => {
  const host = makeHost()
  await wait()
  const cases = [
    ['runtime-context', 'Current runtime context: workspace …'],
    ['system-prompt', 'You are a helpful agent.'],
    ['model-selection', 'model changed: assistant turns above were generated by A'],
    ['subagent-settled', 'subagent finished'],
  ]
  for (const [kind, text] of cases) {
    const fake = makeAgent({ id: `skip-${kind}` })
    const errors = deliver(host, fake, text, kind)
    eq(errors, [], `no throw for ${kind}`)
    eq(fake.selectCalls.length, 0, `no select for ${kind}`)
  }
  eq((await host.call('get', {})).value.lastDecision, null, 'no decision recorded')
})

check('an unknown source kind is skipped and logged once (throttled), without changing behavior', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent({ id: 'unknown-kind' })
  deliver(host, fake, '跑一下测试', 'mystery-delivery')
  deliver(host, fake, '再跑一次', 'mystery-delivery')
  eq(fake.selectCalls.length, 0, 'unknown kinds never route')
  eq((await host.call('get', {})).value.lastDecision, null, 'no decision')
  const lines = host.debugLog().split('\n').filter((line) => line.includes('unknown source.kind "mystery-delivery"'))
  eq(lines.length, 1, 'the unknown kind is logged once')
})

check('one decision per turn still holds for agent-teams steers', async () => {
  const host = makeHost()
  await wait()
  const fake = makeAgent({ id: 'member-turn' })
  deliver(host, fake, '跑一下测试')
  eq(fake.selectCalls.length, 1, 'first decision')
  eq(fake.getCurrent(), LOW, 'first target')
  fake.startTurn(1)
  const steer = message('为什么这样设计？')
  fake.agent.inbox.nextStep.push(steer)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message: steer })
  eq(fake.selectCalls.length, 1, 'steer must not re-decide inside the same turn')
  eq(fake.getCurrent(), LOW, 'target frozen for the turn')
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
console.log(failures === 0 ? 'agent-teams-source: 全部通过' : `agent-teams-source: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
