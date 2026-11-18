// t10 independent checks (verifier-written): request-seam passthrough + probe purity/edges.
// Run: node scripts/t10-seam-checks.mjs
// This does not modify lib/.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const indexSrc = readFileSync(join(repo, 'lib', 'index.js'), 'utf8')

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push([name, 'ok', ''])
  } catch (error) {
    results.push([name, 'FAIL', error.message])
  }
}

// ---------- 1. static: the request handler cannot rewrite the selection ----------
check('static: agent/request block contains no provider/model/effort assignment', () => {
  const start = indexSrc.indexOf("ctx.on('agent/request'")
  assert.notEqual(start, -1, 'agent/request listener not found')
  const end = indexSrc.indexOf('}, { global: true })', start)
  assert.notEqual(end, -1, 'listener end not found')
  const block = indexSrc.slice(start, end)
  for (const field of ['provider', 'model', 'reasoningEffort']) {
    const assignment = new RegExp(`(^|[^.\\w])${field}\\s*=(?!=)`, 'm')
    assert.equal(assignment.test(block), false, `assignment to ${field} found in agent/request block:\n${block}`)
  }
  assert.match(block, /return config/, 'handler must return the downstream config untouched')
})

// ---------- harness: plugin apply with fake host ----------
process.env.DSH_HOME = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-t10-seam-${process.pid}`)
const home = process.env.DSH_HOME
const pluginDir = join(home, 'plugins', 'dsh-peak-valley-router')
rmSync(home, { recursive: true, force: true })
mkdirSync(pluginDir, { recursive: true })
console.error = () => {}

const LOW = { provider: 'deepseek-official', model: 'deepseek-flash' }
const LOW_PEAK = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const HIGH = { provider: 'deepseek-official', model: 'deepseek-chat' }

const policy = {
  schemaVersion: 2,
  revision: 1,
  utcOffsetMinutes: 480,
  holidays: [],
  tierRouting: { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 },
  targets: {
    low: {
      valley: LOW,
      costRouting: true,
      // Wednesday only, so 2026-11-18 (Wed) exercises the window and other days do not.
      peak: { enabled: true, weekdays: [3], windows: [['09:00', '12:00']], ...LOW_PEAK },
    },
    mid: { share: 'low' },
    high: { valley: HIGH, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], ...HIGH } },
  },
  advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
}
const policyPath = join(pluginDir, 'policy.json')
const statePath = join(pluginDir, 'state.json')
const logPath = join(pluginDir, 'debug.log')
writeFileSync(policyPath, JSON.stringify(policy))
writeFileSync(statePath, JSON.stringify({ enabled: false, sessions: {} }))

const routes = new Map()
const listeners = new Map()
const llm = {
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
  listModels: async () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-chat' }],
  resolveModelInfo: async (provider, id) => ({
    provider,
    id,
    name: id,
    reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }] },
  }),
}
const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
const index = await import(pathToFileURL(join(repo, 'lib', 'index.js')).href)
index.apply({
  llm,
  get: (n) => (n === 'llm' ? llm : undefined),
  on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
  inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
  effect: (fn) => { fn(); return () => {} },
})
await new Promise((resolve) => setTimeout(resolve, 100))

const call = async (endpoint, payload) => {
  const route = routes.get(`/api/dsh-peak-valley-router.${endpoint}`)
  assert.ok(route, `no route for ${endpoint}`)
  const request = new Request('http://x/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: `dsh-peak-valley-router.${endpoint}`, payload }),
  })
  return (await (await route.fetch(request)).json()).result
}

// ---------- 2. dynamic: request handler returns next() unchanged ----------
const requestListeners = listeners.get('agent/request') ?? []
const downstream = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxTokens: 1234,
  nested: { a: [1, 2, { b: 'c' }] },
  extraFlag: true,
}
const returned = await requestListeners[0]({ agent: { id: 'sess-x' } }, async () => downstream)
check('dynamic: agent/request returns a deep-equal object (no field rewrite)', () => {
  assert.equal(returned, downstream, 'handler must return the exact downstream object (no clone/rewrite)')
  assert.deepEqual(returned, downstream)
})

// ---------- 3. probe purity and window edges ----------
const snapshotFile = (path) => {
  try {
    return { size: statSync(path).size, bytes: readFileSync(path).toString('base64') }
  } catch {
    return null
  }
}
const before = {
  policy: snapshotFile(policyPath),
  state: snapshotFile(statePath),
  log: snapshotFile(logPath),
  get: JSON.stringify((await call('get', {})).value),
}

const probe = (payload) => call('probe', payload)

const at = async (iso) => (await probe({ text: 'npm run verify', at: iso })).value

const nine = await at('2026-11-18T09:00:00+08:00')
const eleven59 = await at('2026-11-18T11:59:00+08:00')
const twelve = await at('2026-11-18T12:00:00+08:00')
const late = await at('2026-11-18T23:30:00+08:00')
const sundaySameTime = await at('2026-11-15T09:00:00+08:00')

check('probe: 09:00 is inside the peak window (inclusive start)', () => {
  assert.equal(nine.target.model, 'deepseek-v4-pro')
  assert.equal(nine.reason, 'peak')
})
check('probe: 11:59 is inside', () => assert.equal(eleven59.target.model, 'deepseek-v4-pro'))
check('probe: 12:00 is outside the peak window (exclusive end)', () => {
  assert.equal(twelve.target.model, 'deepseek-flash')
  assert.notEqual(twelve.reason, 'peak')
})
check('probe: 23:30 does not match a 09:00-12:00 window (no cross-midnight bleed)', () => {
  assert.equal(late.target.model, 'deepseek-flash')
})
check('probe: the same clock time on a non-configured weekday is not peak', () => {
  assert.equal(sundaySameTime.target.model, 'deepseek-flash')
})

const forcedHigh = await probe({ text: 'whatever', tier: 'high', at: '2026-11-18T12:00:00+08:00' })
check('probe: forced tier uses that tier (trial run works while tierRouting is off)', () => {
  assert.equal(forcedHigh.value.tier, 'high')
  assert.equal(forcedHigh.value.target.model, 'deepseek-chat')
})

const beforeAfter = {
  policy: snapshotFile(policyPath),
  state: snapshotFile(statePath),
  log: snapshotFile(logPath),
  get: JSON.stringify((await call('get', {})).value),
}
check('probe: policy.json/state.json/debug.log bytes and get() are unchanged', () => {
  for (const key of ['policy', 'state', 'log']) {
    assert.deepEqual(beforeAfter[key], before[key], `${key} changed after probe`)
  }
  assert.equal(beforeAfter.get, before.get, 'get() value changed after probe')
})

const bad = await probe({ text: 'x', at: 'not-a-date' })
check('probe: invalid `at` is a bad-request, not an invented tier', () => {
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bad-request')
})
const badTier = await probe({ tier: 'medium' })
check('probe: invalid tier is a bad-request', () => {
  assert.equal(badTier.ok, false)
  assert.equal(badTier.error.code, 'bad-request')
})

const candidate = {
  ...policy,
  targets: { ...policy.targets, high: { valley: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, costRouting: false, peak: { enabled: false, weekdays: [1], windows: [], ...LOW } } },
}
const candidateProbe = await probe({ text: 'x', tier: 'high', config: candidate })
check('probe: a candidate config is used without persisting it', () => {
  assert.equal(candidateProbe.value.target.model, 'deepseek-v4-pro')
  assert.deepEqual(snapshotFile(policyPath), before.policy)
})

// costRouting=false must keep the valley target even inside an active peak window.
const costOff = {
  ...policy,
  targets: {
    ...policy.targets,
    low: { ...policy.targets.low, costRouting: false, peak: { enabled: true, weekdays: [3], windows: [['09:00', '12:00']], ...LOW_PEAK } },
  },
}
const costOffProbe = await probe({ text: 'npm run verify', at: '2026-11-18T10:00:00+08:00', config: costOff })
check('probe: costRouting=false stays on the valley target inside a peak window', () => {
  assert.equal(costOffProbe.value.target.model, 'deepseek-flash')
  assert.equal(costOffProbe.value.costReason, 'cost-off')
})
const costOnProbe = await probe({ text: 'npm run verify', at: '2026-11-18T10:00:00+08:00', config: { ...costOff, targets: { ...costOff.targets, low: { ...costOff.targets.low, costRouting: true } } } })
check('probe: costRouting=true uses the peak target in the same window', () => {
  assert.equal(costOnProbe.value.target.model, 'deepseek-v4-pro')
  assert.equal(costOnProbe.value.reason, 'peak')
})

console.log('== t10 seam checks ==')
let failed = 0
for (const [name, status, message] of results) {
  if (status === 'FAIL') failed += 1
  console.log(`${status === 'ok' ? 'ok  ' : 'FAIL'} ${name}${message ? `\n     ${message}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} passed`)
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
