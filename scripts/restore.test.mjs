// restore persistence + closing paths (t9).
//
// state.json now persists `restore` (the model the session had before the plugin
// stepped in) and `applied` (what we last selected). The restore contract:
//   - closing the switch / decoupling / restore RPC / dispose puts the session
//     back on `restore` ONLY if the current model is still ours (`applied`);
//   - a user hand-pick is never overwritten (unless the user explicitly asks via
//     the restore RPC);
//   - when no live agent exists the restore is deferred (restorePending) and
//     applied the next time that session appears with the switch off.
// Run: node scripts/restore.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const routing = await import(pathToFileURL(join(here, '..', 'lib', 'routing.js')).href)
const { normalizeConfig } = routing

console.error = () => {}

const SEED = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const TARGET = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' }
const USER_PICK = { provider: 'codex', model: 'gpt-6-astra' }
const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
  codex: [{ id: 'gpt-6-astra' }],
}

const policy = normalizeConfig({
  utcOffsetMinutes: 480,
  holidays: [],
  tierRouting: { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 },
  targets: {
    low: { valley: TARGET, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], ...TARGET } },
    mid: { share: 'low' },
    high: { share: 'low' },
  },
  advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
})

let failures = 0
const pending = []
const check = (name, fn) => pending.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-restore-${process.pid}`)
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
process.env.DSH_HOME = root
const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')
const statePath = join(pluginDir, 'state.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))

function resetHome(stateValue = { enabled: true, sessions: {} }) {
  rmSync(pluginDir, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify(stateValue))
  writeFileSync(join(pluginDir, 'policy.json'), JSON.stringify(policy))
}

function makeHost() {
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const llm = {
    listProviders: () => PROVIDERS,
    listModels: async (provider) => MODELS[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'max', name: 'max' }] } }),
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
    emit: (event, payload) => {
      for (const fn of listeners.get(event) ?? []) fn(payload)
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
  }
}

function makeAgent({ id = 's1', seed = SEED } = {}) {
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
  return { agent, selectCalls, getCurrent: () => ({ ...current }), userPick: (selection) => agent.model.select(selection) }
}

let messageSeq = 0
const send = (host, fake) => {
  const message = { id: `m${(messageSeq += 1)}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }
  fake.agent.inbox.nextTurn.push(message)
  host.emit('agent/inbox/inserted', { agent: fake.agent, message })
}

check('routing persists restore (baseline) and applied (target) with timestamps', async () => {
  resetHome()
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  send(host, fake)
  eq(fake.getCurrent(), TARGET, 'target selected')
  await wait(50)
  const disk = readState()
  eq(disk.schemaVersion, 2, 'v2 file')
  eq(disk.restore.s1, SEED, 'restore persisted')
  eq([disk.applied.s1.provider, disk.applied.s1.model], [TARGET.provider, TARGET.model], 'applied persisted')
  if (typeof disk.applied.s1.at !== 'number') throw new Error('applied.at missing')
  const details = (await host.call('get', {})).value.sessionDetails
  eq(details.s1.restore, SEED, 'sessionDetails exposes restore')
})

check('closing the switch restores the pre-plugin model and clears applied', async () => {
  resetHome()
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  send(host, fake)
  eq(fake.getCurrent(), TARGET, 'routed')
  await host.call('toggle', { enabled: false })
  eq(fake.getCurrent(), SEED, 'restored')
  await wait(20)
  const disk = readState()
  eq(disk.applied.s1, null, 'applied tombstoned')
  eq(disk.restore.s1, SEED, 'restore kept for later')
  const details = (await host.call('get', {})).value.sessionDetails
  eq(details.s1.applied, null, 'applied null in sessionDetails')
})

check('a user hand-pick is not overwritten by closing the switch', async () => {
  resetHome()
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  send(host, fake)
  eq(fake.getCurrent(), TARGET, 'routed')
  fake.userPick(USER_PICK) // the human changed the model in the picker
  await host.call('toggle', { enabled: false })
  eq(fake.getCurrent(), USER_PICK, 'user choice respected')
})

check('the restore RPC is explicit and wins over a hand-pick', async () => {
  resetHome()
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  send(host, fake)
  fake.userPick(USER_PICK)
  const restored = await host.call('restore', { sessionId: 's1' })
  eq(restored.value.restored, true, 'restored')
  eq(fake.getCurrent(), SEED, 'back to the baseline')
  await wait(20)
  eq(readState().applied.s1, null, 'applied cleared')
})

check('dispose restores every live routed session', async () => {
  resetHome()
  const host = makeHost()
  await wait()
  const fake = makeAgent()
  send(host, fake)
  eq(fake.getCurrent(), TARGET, 'routed')
  for (const dispose of host.disposers.slice().reverse()) {
    try { dispose() } catch {}
  }
  eq(fake.getCurrent(), SEED, 'restored on dispose')
})

check('without a live agent the restore is deferred, then applied on next sight', async () => {
  resetHome()
  const hostA = makeHost()
  await wait()
  const fakeA = makeAgent({ id: 'deferred' })
  send(hostA, fakeA)
  eq(fakeA.getCurrent(), TARGET, 'routed by host A')
  await wait(30)
  const applied = readState().applied.deferred

  // A second process/host on the same home: it has no live agent for the session.
  const hostB = makeHost()
  await wait(60)
  await hostB.call('toggle', { enabled: false })
  const pendingState = readState()
  eq(pendingState.restorePending.deferred, true, 'restore deferred')

  // The session shows up again (switch still off) on the last applied model.
  const fakeB = makeAgent({
    id: 'deferred',
    seed: {
      provider: applied.provider,
      model: applied.model,
      ...(applied.reasoningEffort ? { reasoningEffort: applied.reasoningEffort } : {}),
    },
  })
  send(hostB, fakeB)
  eq(fakeB.getCurrent(), SEED, 'pending restore applied')
  await wait(30)
  const after = readState()
  eq(after.restorePending.deferred, undefined, 'pending flag cleared')
  eq(after.applied.deferred, null, 'applied cleared')
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
console.log(failures === 0 ? 'restore: 全部通过' : `restore: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
