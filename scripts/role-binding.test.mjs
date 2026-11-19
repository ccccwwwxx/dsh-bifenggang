// Role binding (0.17): a team member must be bound to its role BEFORE its first
// formal task is routed. This drives the real plugin through the exact event
// sequence the host produces:
//
//   subagent/start  ->  agent/inbox/inserted (welcome)  ->  agent-teams/member-started
//                   ->  agent/inbox/inserted (first task)  ->  ... more tasks
//
// and asserts what `agent.model.select()` was called with at each step.
// Run: node scripts/role-binding.test.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { classify } = await import(new URL('../lib/classifier.js', import.meta.url))
const { DEFAULTS } = await import(new URL('../lib/text.js', import.meta.url))

console.error = () => {}

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
  codex: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-astra' }],
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const VERIFIER = {
  name: '验证者',
  match: ['verifier'],
  tiers: {
    mid: { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' },
    high: { provider: 'codex', model: 'gpt-6.2-astra', reasoningEffort: 'max' },
  },
}
const IMPLEMENTER = {
  name: '实现者',
  match: ['implementer'],
  target: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
}
// Peak windows are midnight-wide so the test does not depend on the clock; the
// role rules are what these checks are about.
const PEAK_ALL_DAY = {
  enabled: true,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  windows: [['00:00', '23:59']],
}
const POLICY = {
  ...DEFAULTS,
  utcOffsetMinutes: 480,
  holidays: [],
  tierRouting: { enabled: true, concreteThreshold: 0.55, mediumThreshold: 0.28 },
  targets: {
    low: {
      valley: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
      costRouting: true,
      peak: { ...PEAK_ALL_DAY, provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' },
    },
    mid: { share: 'low' },
    high: { share: 'low' },
  },
  advancedSupport: { provider: 'codex', model: 'gpt-6.2-astra', reasoningEffort: 'max' },
  roleRules: [VERIFIER, IMPLEMENTER],
}

let dirCounter = 0
function makeHost(options = {}) {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-role-${process.pid}-${(dirCounter += 1)}`)
  rmSync(root, { recursive: true, force: true })
  const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify(options.state ?? { enabled: true }))
  writeFileSync(join(pluginDir, 'policy.json'), JSON.stringify(options.policy ?? POLICY))

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
  const ctx = {
    llm,
    get: (n) => (n === 'llm' ? llm : n === 'agents' ? agentsService : undefined),
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    effect: (fn) => { fn(); return () => {} },
  }
  index.apply(ctx, options.config)
  return {
    root,
    pluginDir,
    listeners,
    emit: (event, payload, extra) => (listeners.get(event) ?? []).map((fn) => fn(payload, extra)),
    call: async (endpoint, payload = {}) => {
      const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
      if (!route) throw new Error(`no route for ${endpoint}`)
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

function makeAgent({ id, provider = 'deepseek-official', model = 'deepseek-flash', effort = 'low' } = {}) {
  const boundary = { openTurnStartSeq: null, lastTurn: 0 }
  const selectCalls = []
  let current = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  const agent = {
    id,
    session: { header: { id }, __boundary: boundary },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: {
      current: () => ({ ...current }),
      select: (selection) => {
        selectCalls.push({ ...selection })
        const next = { provider: selection.provider, model: selection.model }
        if (selection.reasoningEffort !== undefined) next.reasoningEffort = selection.reasoningEffort
        current = next
      },
    },
  }
  return {
    agent,
    selectCalls,
    getCurrent: () => ({ ...current }),
    startTurn: (turn = 1) => { boundary.lastTurn = turn; boundary.openTurnStartSeq = null },
  }
}

const teamMessage = (id, text) => ({ id, source: { kind: 'agent-teams' }, content: [{ type: 'text', text }] })
const userMessage = (id, text) => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
// The catalog is warmed asynchronously after apply; a decision taken before it is
// warm is deliberately not applied (catalog-cold), so give it room.
const wait = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms))

// Pick one text per tier with the real classifier, so the tier assertions are not
// guesses about the scoring thresholds.
function textForTier(wanted) {
  const candidates = [
    '跑一下回归测试，然后把结果贴出来',
    '把这个函数改成异步，并补上单元测试',
    '解释这次重构的取舍，并对照契约说明测试覆盖的边界',
    '请裁决两份互相矛盾的证据，说明哪一份可信以及为什么',
    '设计一个可扩展的多阶段架构，权衡一致性、延迟与运维成本',
    '为什么会出现这种不一致？请给出可能的根因和验证方式',
  ]
  for (const text of candidates) {
    const verdict = classify(text, false)
    if (verdict.tier === wanted) return text
  }
  throw new Error(`no candidate text classifies as ${wanted}`)
}

const MID_TEXT = textForTier('mid')
const HIGH_TEXT = textForTier('high')
const MID_TARGET = { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' }
const HIGH_TARGET = { provider: 'codex', model: 'gpt-6.2-astra', reasoningEffort: 'max' }
const IMPLEMENTER_TARGET = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

check('the welcome turn of a freshly spawned member is not routed', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1', provider: 'spawn', local: true })
  const welcome = teamMessage('w1', 'You are 验证者, a member of the team "t"')
  member.agent.inbox.nextTurn.push(welcome)
  host.emit('agent/inbox/inserted', { agent: member.agent, message: welcome })
  eq(member.selectCalls.length, 0, 'no select on the welcome message')
  eq(member.getCurrent(), { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' }, 'member keeps its creation model')
})

check('member-started binds the role and acknowledges the emitter', async () => {
  const host = makeHost()
  await wait()
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  const ack = { ok: false, reason: 'no-listener' }
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' }, ack)
  eq(ack, { ok: true, reason: 'bound' }, 'ack')
  const got = await host.call('get')
  eq(got.value.roles, { 'session-member-1': '验证者' }, 'role persisted')
})

check('the first formal task is routed by the role rule, not the tier table', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  const welcome = teamMessage('w1', 'welcome')
  member.agent.inbox.nextTurn.push(welcome)
  host.emit('agent/inbox/inserted', { agent: member.agent, message: welcome })
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const task = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [task]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: task })
  eq(member.selectCalls, [MID_TARGET], 'mid task -> Sol High')
  const got = await host.call('get')
  eq(got.value.lastDecision.tierReason, 'role-tier:验证者:mid', 'why it selected')
})

check('the same verifier switches from mid to high without re-binding', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const mid = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [mid]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: mid })
  member.startTurn(2)
  const high = teamMessage('t2', HIGH_TEXT)
  member.agent.inbox.nextTurn = [high]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: high })
  eq(member.selectCalls, [MID_TARGET, HIGH_TARGET], 'mid then high')
})

check('the implementer stays on one fixed model whatever the tier', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-impl-1', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' })
  host.emit('subagent/start', { id: 'session-impl-1', parentSessionId: 'session-captain-1' })
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-impl-1', name: '实现者', role: '实现者' })
  member.startTurn(1)
  const low = teamMessage('t1', textForTier('low'))
  member.agent.inbox.nextTurn = [low]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: low })
  member.startTurn(2)
  const high = teamMessage('t2', HIGH_TEXT)
  member.agent.inbox.nextTurn = [high]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: high })
  eq(member.selectCalls, [IMPLEMENTER_TARGET, IMPLEMENTER_TARGET], 'fixed target for both tiers')})

check('an explicit per-session override still wins over the role', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1' })
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  const off = await host.call('toggle', { sessionId: 'session-member-1', enabled: false })
  eq(off.value.sessionEnabled, false, 'switch off')
  member.startTurn(1)
  const task = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [task]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: task })
  eq(member.selectCalls.length, 0, 'switch off beats the role rule')
})

check('a session without a role keeps the normal peak-valley policy', async () => {
  const host = makeHost()
  await wait()
  const plain = makeAgent({ id: 'session-plain-1' })
  plain.startTurn(1)
  const message = userMessage('u1', MID_TEXT)
  plain.agent.inbox.nextTurn = [message]
  host.emit('agent/inbox/inserted', { agent: plain.agent, message })
  eq(plain.selectCalls.length, 1, 'plain session is routed')
  const got = await host.call('get')
  eq(got.value.roles, {}, 'no role recorded')
  if (String(got.value.lastDecision.tierReason).startsWith('role-')) throw new Error('plain session must not use a role rule')
})

check('roles survive a restart (new process, same DSH_HOME)', async () => {
  const first = makeHost()
  await wait()
  first.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  first.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  await wait()

  process.env.DSH_HOME = first.root
  const listeners = new Map()
  const routes = new Map()
  const llm = {
    listProviders: () => PROVIDERS,
    listModels: async (provider) => MODELS[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: EFFORTS.map((effort) => ({ id: effort, name: effort })) } }),
  }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  index.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : n === 'agents' ? { turnBoundaryOf: (s) => s.__boundary } : undefined),
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb({ get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }) },
    effect: (fn) => { fn(); return () => {} },
  })
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  member.startTurn(1)
  const task = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [task]
  for (const fn of listeners.get('agent/inbox/inserted') ?? []) fn({ agent: member.agent, message: task })
  eq(member.selectCalls, [MID_TARGET], 'binding still applies after restart')
})

check('binding failures are reported instead of silently ignored', async () => {
  const host = makeHost()
  await wait()
  const missing = { ok: false, reason: 'no-listener' }
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: '', name: 'x', role: '验证者' }, missing)
  eq(missing, { ok: false, reason: 'missing-session-id' }, 'missing id is a failure')

  const noRole = { ok: false, reason: 'no-listener' }
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 's-x', name: 'x', role: '' }, noRole)
  eq(noRole, { ok: true, reason: 'no-role' }, 'no role is valid, not a failure')

  const unknown = { ok: false, reason: 'no-listener' }
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 's-y', name: 'y', role: '旁观者' }, unknown)
  eq(unknown, { ok: true, reason: 'no-matching-rule' }, 'unknown role is recorded but unused')
  const got = await host.call('get')
  eq(got.value.roles['s-y'], '旁观者', 'unknown role still queryable')
})

for (const [name, fn] of checks) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
if (failures > 0) {
  console.log(`role-binding: ${failures} 项失败`)
  process.exit(1)
}
console.log('role-binding: 全部通过')
