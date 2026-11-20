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
  const gate = options.gate ?? { fail: false }
  const llm = {
    listProviders: () => PROVIDERS,
    listModels: async (provider) => {
      if (gate.fail === true) throw new Error('injected catalog failure')
      return MODELS[provider] ?? []
    },
    resolveModelInfo: async (provider, id) => {
      if (gate.fail === true) throw new Error('injected effort failure')
      return {
        provider,
        id,
        name: id,
        reasoning: { efforts: EFFORTS.map((effort) => ({ id: effort, name: effort })) },
      }
    },
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
// 0.2.2-rc.5 persists plugin-authored messages as this wrapper; AgentTeams uses
// it for every member prompt on such hosts.
const wrappedTeamMessage = (id, text) => ({
  id,
  source: { kind: 'plugin', plugin: '@nanmicoder/dsh-agent-teams' },
  content: [{ type: 'text', text }],
})
// A dispatched team task carries its record on the message source; the envelope
// body (assignment prose + contract) must not influence the score.
const taskMessage = (id, task, body) => ({
  id,
  source: { kind: 'plugin', plugin: '@nanmicoder/dsh-agent-teams', agentTeamsTask: task },
  content: [{ type: 'text', text: body }],
})
const ENVELOPE = 'AgentTeams automatic task assignment from the shared task list.\n\nYou are executing as configured member "验证者".\nDo not start a teammate\'s assigned task.\n\nTeam goal:\ndesign a scalable multi-stage architecture\n\nContract:\nKind: work\nAcceptance: explain the trade-offs and justify the evidence\n'
const foreignPluginMessage = (id, text) => ({
  id,
  source: { kind: 'plugin', plugin: 'some-other-plugin' },
  content: [{ type: 'text', text }],
})
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

check('the very first message may be the task itself: the role applies immediately', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  // AgentTeams reserves the child id and binds the role BEFORE spawning, so the
  // startup prompt (which may be the task body) is already routed by role.
  const ack = { ok: false, reason: 'no-listener' }
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' }, ack)
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  eq({ ok: ack.ok, reason: ack.reason }, { ok: true, reason: 'bound' }, 'ack bound before spawn')
  // The emitter awaits this before creating the child: it must be a real promise
  // that settles, not undefined (that is what makes the first task warm).
  if (typeof ack.ready?.then !== 'function') throw new Error('ack.ready must be a promise for role rules')
  await ack.ready
  member.startTurn(1)
  const first = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [first]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: first })
  eq(member.selectCalls, [MID_TARGET], 'first message routed by the role rule')
})

check('member-started binds the role and acknowledges the emitter', async () => {
  const host = makeHost()
  await wait()
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  const ack = { ok: false, reason: 'no-listener' }
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' }, ack)
  eq({ ok: ack.ok, reason: ack.reason }, { ok: true, reason: 'bound' }, 'ack')
  const got = await host.call('get')
  eq(got.value.roles, { 'session-member-1': '验证者' }, 'role persisted')
})

check('the first formal task is routed by the role rule, not the tier table', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  host.emit('subagent/start', { id: 'session-member-1', parentSessionId: 'session-captain-1' })
  member.startTurn(1)
  const task = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [task]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: task })
  eq(member.selectCalls, [MID_TARGET], 'mid task -> Sol High')
  const got = await host.call('get')
  eq(got.value.lastDecision.tierReason, 'role-tier:验证者:mid', 'why it selected')
})

check('a recovered member keeps its role and re-selects for the new task', async () => {
  const host = makeHost()
  await wait()
  // Cold resume: the member session already exists; AgentTeams re-announces the
  // same role, and each new task is classified again (mid -> high).
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
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
  // Re-announcing the same role on resume must not disturb or duplicate anything.
  const ack = { ok: false, reason: 'no-listener' }
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' }, ack)
  eq({ ok: ack.ok, reason: ack.reason }, { ok: true, reason: 'bound' }, 'resume ack')
  const got = await host.call('get')
  eq(got.value.roles, { 'session-member-1': '验证者' }, 'one role, no duplicate entries')
})

check('an ordinary subagent (no member role) keeps the normal policy', async () => {
  const host = makeHost()
  await wait()
  const child = makeAgent({ id: 'session-child-plain' })
  host.emit('subagent/start', { id: 'session-child-plain', parentSessionId: 'session-parent' })
  child.startTurn(1)
  const message = teamMessage('t1', HIGH_TEXT)
  child.agent.inbox.nextTurn = [message]
  host.emit('agent/inbox/inserted', { agent: child.agent, message })
  if (child.selectCalls.length !== 1) throw new Error('ordinary subagent must still be routed')
  const got = await host.call('get')
  if (String(got.value.lastDecision.tierReason).startsWith('role-')) throw new Error('ordinary subagent must not use a role rule')
  eq(got.value.roles, {}, 'no role bound')
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

check('the plugin-wrapped AgentTeams dispatch is intent (0.2.2-rc.5 shape)', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const task = wrappedTeamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [task]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: task })
  eq(member.selectCalls, [MID_TARGET], 'wrapped dispatch routed by role')
})

check('another plugin context message stays non-intent', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1' })
  host.emit('agent-teams/member-started', { teamId: 'team-1', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const ctx = foreignPluginMessage('c1', MID_TEXT)
  member.agent.inbox.nextTurn = [ctx]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: ctx })
  eq(member.selectCalls.length, 0, 'foreign plugin context never routes')
})

check('a continued member keeps its model when the catalog is cold, with the reason recorded', async () => {
  const gate = { fail: true }
  const host = makeHost({ gate })
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const task = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [task]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: task })
  eq(member.selectCalls.length, 0, 'unverified target is never selected')
  const got = await host.call('get')
  eq(got.value.lastDecision.warningKind, 'unverified', 'reason recorded')
  eq(got.value.lastDecision.target, MID_TARGET, 'the intended role target is recorded')
})

check('once a refresh succeeds, the next task applies the role target', async () => {
  const gate = { fail: true }
  const host = makeHost({ gate })
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const first = teamMessage('t1', MID_TEXT)
  member.agent.inbox.nextTurn = [first]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: first })
  eq(member.selectCalls.length, 0, 'cold catalog: no select')
  // The catalog comes back (an adapter change clears and re-warms it, like the
  // real host does when a provider finishes registering).
  gate.fail = false
  host.emit('llm/adapters-updated', {})
  await wait(400)
  member.startTurn(2)
  const second = teamMessage('t2', MID_TEXT)
  member.agent.inbox.nextTurn = [second]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: second })
  eq(member.selectCalls, [MID_TARGET], 'the next task selects the role target')
})

check('a dispatched task is scored from its task record, not the envelope', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  // The envelope alone would classify as high; the task record is the mid sample.
  const task = { taskId: 't-mid', subject: '改端口', description: MID_TEXT }
  const message = taskMessage('m1', task, ENVELOPE)
  member.agent.inbox.nextTurn = [message]
  host.emit('agent/inbox/inserted', { agent: member.agent, message })
  eq(member.selectCalls, [MID_TARGET], 'scored by subject+description')
  const got = await host.call('get')
  eq(got.value.lastDecision.scoreSource, 'task:t-mid', 'the task id is recorded for cross-checking')
})

check('queued dispatches keep their own task text (no cross-talk)', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  const midMsg = taskMessage('m1', { taskId: 't-mid', subject: '覆盖', description: MID_TEXT }, ENVELOPE)
  const highMsg = taskMessage('m2', { taskId: 't-high', subject: '裁决', description: HIGH_TEXT }, ENVELOPE)
  // The host consumes each claimed message, so the inbox holds one at a time.
  member.agent.inbox.nextTurn = [midMsg]
  member.startTurn(1)
  host.emit('agent/inbox/inserted', { agent: member.agent, message: midMsg })
  member.agent.inbox.nextTurn = [highMsg]
  member.startTurn(2)
  host.emit('agent/inbox/inserted', { agent: member.agent, message: highMsg })
  eq(member.selectCalls, [MID_TARGET, HIGH_TARGET], 'each message scored from its own task record')
})

check('a message without a task record keeps the envelope-derived behaviour', async () => {
  const host = makeHost()
  await wait()
  const plain = makeAgent({ id: 'session-plain-1' })
  plain.startTurn(1)
  const message = foreignPluginMessage('c1', MID_TEXT)
  plain.agent.inbox.nextTurn = [message]
  host.emit('agent/inbox/inserted', { agent: plain.agent, message })
  eq(plain.selectCalls.length, 0, 'plugin context still never routes')
  const got = await host.call('get')
  eq(got.value.roles, {}, 'no role')
})

check('a member spawned for a task is scored by that task on its first turn', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  // The host creates the child's first prompt itself, so the task rides on the
  // binding event; the prompt body is the verbose assignment envelope.
  host.emit('agent-teams/member-started', {
    teamId: 't',
    sessionId: 'session-member-1',
    name: '验证者',
    role: '验证者',
    task: { taskId: 't-spawn', subject: '改端口', description: MID_TEXT },
  })
  member.startTurn(1)
  const first = { id: 'p1', source: { kind: 'user' }, content: [{ type: 'text', text: ENVELOPE }] }
  member.agent.inbox.nextTurn = [first]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: first })
  eq(member.selectCalls, [MID_TARGET], 'scored by the spawn task')
  const got = await host.call('get')
  eq(got.value.lastDecision.scoreSource, 'spawn-task:t-spawn', 'source recorded')
  // Consumed exactly once: the next turn falls back to normal scoring.
  member.startTurn(2)
  const second = { id: 'p2', source: { kind: 'user' }, content: [{ type: 'text', text: ENVELOPE }] }
  member.agent.inbox.nextTurn = [second]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: second })
  const after = await host.call('get')
  if (String(after.value.lastDecision.scoreSource ?? '').startsWith('spawn-task')) throw new Error('spawn task must be consumed once')
})

check('a declared judgement replaces text scoring', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  // The text alone would score mid; the declaration says "just run it and record".
  const execute = taskMessage('m1', { taskId: 't-exec', subject: '执行', description: MID_TEXT, judgement: 'execute' }, ENVELOPE)
  member.agent.inbox.nextTurn = [execute]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: execute })
  const got = await host.call('get')
  eq(got.value.lastDecision.tierReason, 'declared:execute', 'declared tier reason')
  eq(got.value.lastDecision.scoreSource, 'declared:t-exec:execute', 'task id + declaration recorded')
  // low tier falls through to the policy: the fixture's low table has an all-day
  // peak window, so the policy's own peak target is the expected selection.
  eq(got.value.lastDecision.target, { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' }, 'execute -> low tier -> policy table')
})

check('a declared judgement outranks a member created at max reasoning', async () => {
  const policy = {
    ...POLICY,
    targets: {
      low: {
        valley: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
        costRouting: false,
        peak: { enabled: false },
      },
      mid: {
        valley: { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' },
        costRouting: false,
        peak: { enabled: false },
      },
      high: {
        valley: { provider: 'codex', model: 'gpt-6.2-astra', reasoningEffort: 'max' },
        costRouting: false,
        peak: { enabled: false },
      },
    },
    roleRules: [],
  }
  const host = makeHost({ policy })
  await wait()
  // This is the integrator shape seen on 81: the member was created at max and
  // has no role rule. The declaration, not the creation snapshot, must decide.
  const member = makeAgent({ id: 'session-integrator-max', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'max' })
  member.startTurn(1)
  const execute = taskMessage('m1', { taskId: 't-exec-max', subject: '记录退出码', description: '执行并记录结果', judgement: 'execute' }, ENVELOPE)
  member.agent.inbox.nextTurn = [execute]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: execute })
  const got = await host.call('get')
  eq(got.value.lastDecision.tierReason, 'declared:execute', 'declaration still drives the tier')
  eq(got.value.lastDecision.axis, 'tier', 'max baseline must not force the advanced axis')
  eq(got.value.lastDecision.target, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }, 'execute -> low target')
  if (!host.debugLog().includes('declared-overrides-max')) throw new Error('max suppression must be auditable in debug.log')
})

check('a failing command does not escalate: execute stays low even for risky text', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const risky = taskMessage('m1', { taskId: 't-risk', subject: '跑测试', description: HIGH_TEXT, judgement: 'execute' }, ENVELOPE)
  member.agent.inbox.nextTurn = [risky]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: risky })
  const got = await host.call('get')
  eq(got.value.lastDecision.tier, 'low', 'execute keeps the low tier')
})

check('adjudicate and coverage map to the high and mid tiers', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const coverage = taskMessage('m1', { taskId: 't-cov', subject: '覆盖', description: 'x', judgement: 'coverage' }, ENVELOPE)
  member.agent.inbox.nextTurn = [coverage]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: coverage })
  eq(member.selectCalls.at(-1), MID_TARGET, 'coverage -> mid -> Sol High')
  member.startTurn(2)
  const adjudicate = taskMessage('m2', { taskId: 't-adj', subject: '裁决', description: 'x', judgement: 'adjudicate' }, ENVELOPE)
  member.agent.inbox.nextTurn = [adjudicate]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: adjudicate })
  eq(member.selectCalls.at(-1), HIGH_TARGET, 'adjudicate -> high -> Astra Max')
})

check('an old task without a declaration still uses text scoring', async () => {
  const host = makeHost()
  await wait()
  const member = makeAgent({ id: 'session-member-1', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
  host.emit('agent-teams/member-started', { teamId: 't', sessionId: 'session-member-1', name: '验证者', role: '验证者' })
  member.startTurn(1)
  const legacy = taskMessage('m1', { taskId: 't-old', subject: '改端口', description: MID_TEXT }, ENVELOPE)
  member.agent.inbox.nextTurn = [legacy]
  host.emit('agent/inbox/inserted', { agent: member.agent, message: legacy })
  const got = await host.call('get')
  eq(got.value.lastDecision.tierReason, 'role-tier:验证者:mid', 'text scoring still drives the tier')
  eq(got.value.lastDecision.scoreSource, 'task:t-old', 'task id recorded')
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
