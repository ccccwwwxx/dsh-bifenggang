// Randomized property test (differential oracle) for per-session routing.
//
// Independence: the EXPECTED behaviour is recomputed here straight from
// state.json, never from the plugin's own helpers, and the plugin is judged
// only by observable behaviour — identity passthrough when off, a rewritten
// model when on. Session ids include hostile keys (`__proto__`, `constructor`),
// empty/near-empty ids, unicode and an over-long id.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

function freshHost() {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  process.env.DSH_HOME = root
  writeFileSync(join(pluginDir, 'state.json'), JSON.stringify({ enabled: false }))
  const listeners = []
  const routes = new Map()
  const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
  const models = {
    'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
    codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
  }
  const llm = { listProviders: () => providers, listModels: async (p) => models[p] ?? [] }
  const connection = { fetch: { register: (r) => { routes.set(r.path, r); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
  mod.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : undefined),
    on: (event, fn) => { if (event === 'agent/request') listeners.push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
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
  return { call, listener: () => listeners[0] }
}

// The oracle: recomputed from disk, with no knowledge of the plugin's code.
const diskState = () => JSON.parse(readFileSync(join(pluginDir, 'state.json'), 'utf8'))
const expected = (state, id) => {
  const map = state.sessions && typeof state.sessions === 'object' ? state.sessions : {}
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] === true : state.enabled === true
}

const SEED = { provider: 'seed-provider', model: 'seed-model', reasoningEffort: 'low' }
let failures = 0
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`) }

const host = freshHost()
const call = host.call
const listener = host.listener()

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
    const out = await listener({ agent: { session: { header: { id: probe } } } }, async () => SEED)
    const rewrote = out !== SEED
    if (want && !rewrote) fail(`op ${i}: expected routing for ${JSON.stringify(probe)} but got identity passthrough`)
    if (!want && rewrote) fail(`op ${i}: expected passthrough for ${JSON.stringify(probe)} but it was rewritten to ${out.provider}/${out.model}`)
  }
}

// 2. no session id at all -> the global default decides.
{
  const state = diskState()
  const out = await listener({ agent: undefined }, async () => SEED)
  const rewrote = out !== SEED
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
  const before = diskState()
  const listeners = []
  const routes = new Map()
  const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
  const models = { 'deepseek-official': [{ id: 'deepseek-flash' }], codex: [{ id: 'gpt-5.6-luna' }] }
  const llm = { listProviders: () => providers, listModels: async (p) => models[p] ?? [] }
  const connection = { fetch: { register: (r) => { routes.set(r.path, r); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
  mod.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : undefined),
    on: (event, fn) => { if (event === 'agent/request') listeners.push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
  })
  const after = diskState()
  for (const probe of IDS) {
    const want = expected(after, probe)
    const out = await listeners[0]({ agent: { session: { header: { id: probe } } } }, async () => SEED)
    const rewrote = out !== SEED
    if (want !== rewrote) fail(`after reload, id ${JSON.stringify(probe)}: expected ${want ? 'routing' : 'passthrough'}`)
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) fail('state.json changed across a reload')
}

console.log(failures === 0
  ? `\nfuzz: 全部通过（${OPS} 次随机操作 × ${IDS.length} 个探针 id，差分判据来自 state.json）`
  : `\nfuzz: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
