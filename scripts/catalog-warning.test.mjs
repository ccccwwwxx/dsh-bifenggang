// Visible routing warnings (t8): two severities, bounded history, throttling,
// auto-clear on recovery, fail-open, and the legacy-extra-strategies notice.
//
// Red (error) = the target is KNOWN unavailable; yellow (info) = we cannot tell
// yet (catalog/effort cold, llm missing) or a compatibility note. Neither may
// change the fail-open contract: unknown information never selects and never
// throws. Run: node scripts/catalog-warning.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const routing = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { normalizeConfig } = routing

console.error = () => {}

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const BASE_MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }],
  codex: [{ id: 'gpt-6-astra' }],
}
const LOW = { provider: 'deepseek-official', model: 'deepseek-flash' }
const MISSING = { provider: 'deepseek-official', model: 'missing-model' }
const RECOVERED = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const ADV = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

function table(valley) {
  return { valley, costRouting: true, peak: { enabled: false, weekdays: [1, 2, 3, 4, 5], windows: [], ...valley } }
}
function policyWith(valley) {
  return normalizeConfig({
    utcOffsetMinutes: 480,
    holidays: [],
    tierRouting: { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 },
    targets: { low: table(valley), mid: { share: 'low' }, high: { share: 'low' } },
    advancedSupport: ADV,
  })
}
const V1_TWO = {
  utcOffsetMinutes: 480,
  holidays: [],
  strategies: [
    { name: 'first', weekdays: [1, 2, 3, 4, 5, 6, 7], primary: { provider: 'codex', model: 'gpt-6-astra' }, peak: { enabled: false, windows: [] } },
    { name: 'second', weekdays: [6, 7], primary: { provider: 'deepseek-official', model: 'deepseek-flash' }, peak: { enabled: false, windows: [] } },
  ],
  advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
}
const V1_ONE = { ...V1_TWO, strategies: [V1_TWO.strategies[0]] }

let dirCounter = 0
function makeHost(options = {}) {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-warn-${process.pid}-${(dirCounter += 1)}`)
  rmSync(root, { recursive: true, force: true })
  const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify(options.state ?? { enabled: true }))
  const policyPath = join(pluginDir, 'policy.json')
  if (options.policyFile) writeFileSync(policyPath, JSON.stringify(options.policyFile))
  else if (options.policy) writeFileSync(policyPath, JSON.stringify(options.policy))

  const listeners = new Map()
  const routes = new Map()
  const modelState = { models: JSON.parse(JSON.stringify(options.models ?? BASE_MODELS)) }
  const listModels = options.listModels ?? (async (provider) => modelState.models[provider] ?? [])
  const llm = options.llm === false ? null : {
    listProviders: () => PROVIDERS,
    listModels,
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
  const emit = (event, payload) => {
    const errors = []
    for (const fn of listeners.get(event) ?? []) {
      try { fn(payload) } catch (error) { errors.push(error) }
    }
    return errors
  }
  return {
    root,
    pluginDir,
    policyPath,
    call,
    emit,
    debugLog: () => {
      try { return readFileSync(join(pluginDir, 'debug.log'), 'utf8') } catch { return '' }
    },
    setModels: (models) => { modelState.models = models },
    notifyAdapters: () => emit('llm/adapters-updated', {}),
  }
}

function makeAgent(id = 's1') {
  const boundary = { openTurnStartSeq: null, lastTurn: 0 }
  const selectCalls = []
  let current = { ...LOW }
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
        current = next
      },
    },
  }
  return { agent, selectCalls, getCurrent: () => ({ ...current }) }
}

let messageSeq = 0
const send = (host, fake, text = '跑一下测试') => {
  const message = { id: `m${(messageSeq += 1)}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }
  fake.agent.inbox.nextTurn.push(message)
  return host.emit('agent/inbox/inserted', { agent: fake.agent, message })
}
const findWarning = (result, kind) => (result.warnings ?? []).find((warning) => warning.kind === kind)

// ---------- red / yellow ----------

check('a KNOWN-unavailable model raises a red warning and keeps the current model', async () => {
  const host = makeHost({ policy: policyWith(MISSING) })
  await wait()
  const fake = makeAgent()
  const errors = send(host, fake)
  eq(errors, [], 'the event must not throw')
  eq(fake.selectCalls.length, 0, 'an unavailable target is never selected')
  eq(fake.getCurrent(), LOW, 'current model kept')
  const got = await host.call('get', {})
  const warning = findWarning(got.value, 'model')
  if (!warning) throw new Error(`model warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq([warning.severity, warning.reason], ['error', 'model'], 'red + reason')
  eq(warning.target, MISSING, 'target')
  eq(warning.kept, LOW, 'kept')
  if (typeof warning.at !== 'string' || !warning.at.includes('T')) throw new Error('warning.at must be an ISO timestamp')
})

check('a COLD catalog raises a yellow warning and still does not select (fail-open)', async () => {
  const host = makeHost({ policy: policyWith(RECOVERED), listModels: () => new Promise(() => {}) })
  await wait(40) // deliberately still cold
  const fake = makeAgent()
  const errors = send(host, fake)
  eq(errors, [], 'no throw')
  eq(fake.selectCalls.length, 0, 'cold catalog never selects')
  const got = await host.call('get', {})
  const warning = findWarning(got.value, 'unverified')
  if (!warning) throw new Error(`unverified warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq([warning.severity, warning.reason], ['info', 'catalog-cold'], 'yellow + reason')
})

check('llm unavailable is a yellow warning and routing stays transparent', async () => {
  const host = makeHost({ policy: policyWith(LOW), llm: false })
  await wait()
  const fake = makeAgent()
  const errors = send(host, fake)
  eq(errors, [], 'no throw')
  eq(fake.selectCalls.length, 0, 'no select without llm')
  const got = await host.call('get', {})
  const warning = findWarning(got.value, 'llm-unavailable')
  if (!warning) throw new Error(`llm-unavailable warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq(warning.severity, 'info', 'yellow')
})

// ---------- throttling / bounds / history ----------

check('the same reason is throttled to one warning and one log line', async () => {
  const host = makeHost({ policy: policyWith(MISSING) })
  await wait()
  const fake = makeAgent()
  for (let i = 0; i < 4; i += 1) send(host, fake)
  const got = await host.call('get', {})
  const modelWarnings = (got.value.warnings ?? []).filter((warning) => warning.kind === 'model')
  eq(modelWarnings.length, 1, 'one deduped warning')
  if (modelWarnings[0].count < 4) throw new Error(`count must accumulate, got ${modelWarnings[0].count}`)
  const log = host.debugLog()
  const lines = log.split('\n').filter((line) => line.includes('warning: model '))
  eq(lines.length, 1, 'a repeated failure logs once')
})

check('active warnings are bounded and recentWarnings keeps a bounded history', async () => {
  const host = makeHost({ policy: policyWith(MISSING) })
  await wait()
  for (let i = 0; i < 60; i += 1) {
    const fake = makeAgent(`session-${i}`)
    send(host, fake)
  }
  const got = await host.call('get', {})
  eq((got.value.warnings ?? []).length, 20, 'active warnings are capped at 20')
  const history = got.value.recentWarnings ?? []
  eq(history.length, 50, 'history is capped at 50')
  const newest = history[0]
  if (newest.event !== 'raised' || newest.kind !== 'model' || !newest.sessionId) {
    throw new Error(`unexpected newest history entry: ${JSON.stringify(newest)}`)
  }
  if (!['raised', 'cleared'].includes(newest.event)) throw new Error('event must be raised|cleared')
  if (!['error', 'info'].includes(newest.severity)) throw new Error('severity must be error|info')
  if (newest.reason !== 'model') throw new Error(`reason: ${newest.reason}`)
})

// ---------- recovery / auto-clear ----------

check('a recovered target auto-clears the warning after a catalog refresh, and routing resumes', async () => {
  const host = makeHost({ policy: policyWith(RECOVERED) })
  await wait()
  const first = makeAgent('session-a')
  send(host, first)
  let got = await host.call('get', {})
  eq(findWarning(got.value, 'model')?.severity, 'error', 'red first')
  eq(first.selectCalls.length, 0, 'not selected while missing')

  // The provider catalog gains the model; the adapter update triggers a refresh.
  host.setModels({ 'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], codex: [{ id: 'gpt-6-astra' }] })
  host.notifyAdapters()
  await wait(200)

  got = await host.call('get', {})
  eq((got.value.warnings ?? []).filter((warning) => warning.kind === 'model').length, 0, 'warning auto-cleared')
  const cleared = (got.value.recentWarnings ?? []).find((entry) => entry.event === 'cleared' && entry.kind === 'model')
  if (!cleared) throw new Error('the clear event must be in the history')
  eq(cleared.reason, 'model', 'clear keeps the reason')
  if (!host.debugLog().includes('warning: cleared model')) throw new Error('the clear must be logged')

  const second = makeAgent('session-b')
  send(host, second)
  eq(second.getCurrent(), RECOVERED, 'routing resumes once the catalog knows the target')
})

// ---------- legacy-extra-strategies ----------

check('v1 with TWO strategies raises a yellow legacy-extra-strategies warning', async () => {
  const host = makeHost({ policyFile: V1_TWO })
  await wait()
  const got = await host.call('get', {})
  const warning = findWarning(got.value, 'legacy-extra-strategies')
  if (!warning) throw new Error(`legacy warning missing: ${JSON.stringify(got.value.warnings)}`)
  eq([warning.severity, warning.reason, warning.extraCount], ['info', 'legacy-v1-migration', 1], 'yellow + count')
  if (!warning.detail.includes('strategies 2..2')) throw new Error(`detail must explain the dropped range: ${warning.detail}`)
  eq(got.value.config.legacy.strategies.length, 2, 'the legacy snapshot is kept read-only')
  const raised = (got.value.recentWarnings ?? []).find((entry) => entry.event === 'raised' && entry.kind === 'legacy-extra-strategies')
  if (!raised) throw new Error('the raise event must be in the history')
})

check('v1 with ONE strategy raises no legacy warning', async () => {
  const host = makeHost({ policyFile: V1_ONE })
  await wait()
  const got = await host.call('get', {})
  eq(findWarning(got.value, 'legacy-extra-strategies'), undefined, 'no warning for a single plan')
})

check('a v2 policy carries no legacy warning (nothing was dropped)', async () => {
  const host = makeHost({ policy: policyWith(LOW) })
  await wait()
  const got = await host.call('get', {})
  eq(findWarning(got.value, 'legacy-extra-strategies'), undefined, 'v2 has no migration warning')
})

check('red warnings sort before the yellow legacy notice (banner headline matches colour)', async () => {
  // V1_TWO's first strategy points at codex/gpt-6-astra, which this host's
  // catalog omits -> a red model warning must become warnings[0].
  const host = makeHost({
    policyFile: V1_TWO,
    models: { 'deepseek-official': [{ id: 'deepseek-flash' }], codex: [{ id: 'gpt-5.6-luna' }] },
  })
  await wait()
  const fake = makeAgent()
  send(host, fake)
  const got = await host.call('get', {})
  const list = got.value.warnings ?? []
  if (list.length < 2) throw new Error(`expected both warnings, got ${JSON.stringify(list)}`)
  eq(list[0].severity, 'error', 'headline is the red one')
  if (!list.some((warning) => warning.kind === 'legacy-extra-strategies')) throw new Error('legacy notice still present')
})

check('saving the migrated config dismisses the legacy notice (and it stays gone)', async () => {
  const host = makeHost({ policyFile: V1_TWO })
  await wait()
  const before = await host.call('get', {})
  if (!findWarning(before.value, 'legacy-extra-strategies')) throw new Error('precondition: legacy warning present')
  const saved = await host.call('set', { config: before.value.config })
  eq(saved.ok, true, 'save succeeds')
  const after = await host.call('get', {})
  eq(findWarning(after.value, 'legacy-extra-strategies'), undefined, 'warning dismissed by the save')
  const cleared = (after.value.recentWarnings ?? []).find((entry) => entry.event === 'cleared' && entry.kind === 'legacy-extra-strategies')
  if (!cleared) throw new Error('dismissal must be recorded in the history')
  eq(cleared.reason, 'legacy-v1-migration', 'history keeps the reason')

  // A fresh process reading the (now v2) file must not re-raise it.
  const restarted = makeHost({ policy: JSON.parse(readFileSync(host.policyPath, 'utf8')) })
  await wait()
  const reloaded = await restarted.call('get', {})
  eq(findWarning(reloaded.value, 'legacy-extra-strategies'), undefined, 'no warning after restart')
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
console.log(failures === 0 ? 'catalog-warning: 全部通过' : `catalog-warning: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
