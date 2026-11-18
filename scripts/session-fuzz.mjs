// Randomized property test (differential oracle) for per-session routing.
//
// Independence: the EXPECTED behaviour is recomputed here straight from
// state.json, never from the plugin's own helpers, and the plugin is judged only
// by observable behaviour — no `select` when off, the routed target when on.
// Session ids include hostile keys (`__proto__`, `constructor`), empty/near-empty
// ids, unicode and an over-long id.
//
// 0.16.0 seam: the observation point is `agent/inbox/inserted` + the fake agent's
// `model.current()` (the old `agent/request` rewrite is gone; core 0.2.2-rc.1
// throws on it).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
console.error = () => {}

const root = join(process.env.TEMP ?? '.', `pv-fuzz-${process.pid}`)
const pluginDir = join(root, 'plugins', 'dsh-peak-valley-router')

let seed = Number(process.argv[2] ?? 20261014)
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length]

const IDS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf',
  'normal-session-1', 'normal-session-2', '中文会话', 'id with spaces', 'x'.repeat(300), '0']

const PROVIDERS = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
const MODELS = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
  codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
}
// Seed model differs from the routed default so "changed" is observable.
const SEED = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'low' }
const ROUTED = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

function freshHost() {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify({ enabled: false }))
  return applyHost()
}

function applyHost() {
  const listeners = new Map()
  const routes = new Map()
  const llm = {
    listProviders: () => PROVIDERS,
    listModels: async (provider) => MODELS[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({
      provider,
      id,
      name: id,
      reasoning: { efforts: ['low', 'high', 'max'].map((effort) => ({ id: effort, name: effort })) },
    }),
  }
  const agentsService = { turnBoundaryOf: (session) => session.__boundary }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
  mod.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : n === 'agents' ? agentsService : undefined),
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    effect: (fn) => { fn(); return () => {} },
  })
  const call = async (endpoint, payload) => {
    const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
    const req = new Request('http://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
    })
    return (await (await route.fetch(req)).json()).result
  }
  // Dispatch one user message for `id` through the real seam. Returns the model
  // the fake agent reports immediately afterwards.
  const route = (id) => {
    let current = { ...SEED }
    const session = {
      __boundary: { openTurnStartSeq: null, lastTurn: 0 },
      append: (type, data) => { if (type === 'model/selection') current = { ...data } },
    }
    if (id === undefined) {
      session.header = {}
    } else {
      session.header = { id }
    }
    const agent = {
      id: id,
      session,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      model: {
        current: () => ({ ...current }),
        select: (selection) => {
          const next = { provider: selection.provider, model: selection.model }
          if (selection.reasoningEffort !== undefined) next.reasoningEffort = selection.reasoningEffort
          if (JSON.stringify(next) === JSON.stringify(current)) return
          current = next
        },
      },
    }
    const message = { id: `m-${Math.random().toString(36).slice(2)}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }
    agent.inbox.nextTurn.push(message)
    for (const fn of listeners.get('agent/inbox/inserted') ?? []) fn({ agent, message })
    return { current: { ...current }, agent }
  }
  return { call, route, listeners }
}

// The oracle: recomputed from disk, with no knowledge of the plugin's code.
const diskState = () => JSON.parse(readFileSync(join(pluginDir, 'state.json'), 'utf8'))
const expected = (state, id) => {
  if (id === undefined) return state.enabled === true
  const map = state.sessions && typeof state.sessions === 'object' ? state.sessions : {}
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] === true : state.enabled === true
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

let failures = 0
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`) }

let host = freshHost()
await wait()
const call = host.call

// 1. random operation sequence, checking the oracle after every step.
const OPS = 200
for (let i = 0; i < OPS; i++) {
  const id = pick(IDS)
  const roll = rnd()
  if (roll < 0.45) {
    await call('toggle', { enabled: rnd() < 0.5, sessionId: id })
  } else if (roll < 0.65) {
    await call('toggle', { sessionId: id, inherit: true })
  } else if (roll < 0.85) {
    await call('toggle', { enabled: rnd() < 0.5 })
  } else {
    // a no-op read must not change anything
    await call('get', {})
  }

  const state = diskState()
  if (Object.keys(state.sessions ?? {}).length > 500) fail(`op ${i}: sessions grew past the cap`)

  // Behavioural check against the oracle on a sample of ids.
  for (const probe of IDS) {
    const want = expected(state, probe)
    const { current } = host.route(probe)
    const rewrote = !same(current, SEED)
    if (want && !rewrote) fail(`op ${i}: expected routing for ${JSON.stringify(probe)} but the model stayed ${JSON.stringify(current)}`)
    if (!want && rewrote) fail(`op ${i}: expected no routing for ${JSON.stringify(probe)} but it was changed to ${JSON.stringify(current)}`)
    if (want && rewrote && !same(current, ROUTED)) fail(`op ${i}: routed ${JSON.stringify(probe)} to ${JSON.stringify(current)} instead of ${JSON.stringify(ROUTED)}`)
  }
}

// 2. no session id at all -> the global default decides.
{
  const state = diskState()
  const { current } = host.route(undefined)
  const rewrote = !same(current, SEED)
  if (state.enabled === true && !rewrote) fail('unreadable id must fall back to the global default (ON)')
  if (state.enabled !== true && rewrote) fail('unreadable id must fall back to the global default (OFF)')
}

// 3. every id the fuzzer touched is either absent or an OWN key (no prototype weirdness).
{
  const state = diskState()
  const map = state.sessions ?? {}
  for (const id of IDS) {
    const has = Object.prototype.hasOwnProperty.call(map, id)
    const listed = Object.keys(map).includes(id)
    if (has !== listed) fail(`id ${JSON.stringify(id)}: own-key detection disagrees with Object.keys`)
    if (has && typeof map[id] !== 'boolean') fail(`id ${JSON.stringify(id)}: value is not a boolean`)
  }
}

// 4. persistence: re-apply the module against the SAME directory and re-check the
//    oracle, so the overrides must have survived a reload from disk.
{
  // v2 persists routing metadata (applied/restore) on a microtask; drain any
  // queued write from the last probe so the snapshot is taken at a quiet point.
  await new Promise((resolve) => setTimeout(resolve, 30))
  const before = diskState()
  host = applyHost()
  await wait()
  const after = diskState()
  for (const probe of IDS) {
    const want = expected(after, probe)
    const { current } = host.route(probe)
    if (want !== !same(current, SEED)) fail(`after reload, id ${JSON.stringify(probe)}: expected ${want ? 'routing' : 'no routing'}`)
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) fail('state.json changed across a reload')
}

console.log(failures === 0
  ? `\nfuzz: 全部通过（${OPS} 次随机操作 × ${IDS.length} 个探针 id，差分判据来自 state.json）`
  : `\nfuzz: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
