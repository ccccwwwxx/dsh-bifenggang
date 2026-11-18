// t10: how many times does a pure routing read (message -> decision -> select)
// write state.json, and does merely re-applying the plugin write it?
// Run: node scripts/t10-state-io.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
console.error = () => {}

const home = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-t10-io-${process.pid}`)
const pluginDir = join(home, 'plugins', 'dsh-peak-valley-router')
rmSync(home, { recursive: true, force: true })
mkdirSync(pluginDir, { recursive: true })
process.env.DSH_HOME = home
const statePath = join(pluginDir, 'state.json')
const policyPath = join(pluginDir, 'policy.json')
writeFileSync(policyPath, JSON.stringify({
  schemaVersion: 2,
  revision: 1,
  utcOffsetMinutes: 480,
  holidays: [],
  tierRouting: { enabled: false, concreteThreshold: 0.55, mediumThreshold: 0.28 },
  targets: {
    low: { valley: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, costRouting: true, peak: { enabled: false, weekdays: [1, 2, 3, 4, 5, 6, 7], windows: [], provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    mid: { share: 'low' },
    high: { share: 'low' },
  },
  advancedSupport: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
}))
writeFileSync(statePath, JSON.stringify({ enabled: true, sessions: {} }))

const hash = () => createHash('sha1').update(readFileSync(statePath)).digest('hex')
const bytesOf = () => readFileSync(statePath, 'utf8')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const llm = {
  listProviders: () => [{ id: 'deepseek-official' }],
  listModels: async () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
  resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'low' }] } }),
}
const listeners = new Map()
const emitAll = (event, payload) => {
  for (const handler of listeners.get(event) ?? []) handler(payload)
}
const load = async () => {
  const index = await import(pathToFileURL(join(repo, 'lib', 'index.js')).href + `?v=${Math.random()}`)
  index.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : undefined),
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    inject: () => {},
    effect: (fn) => { fn(); return () => {} },
  })
  await sleep(80)
  // Warm the provider/model catalog the way the real host does.
  emitAll('llm/adapters-updated', {})
  await sleep(120)
}
await load()

let current = { provider: 'deepseek-official', model: 'deepseek-flash' }
const agent = {
  id: 'sess-io',
  status: 'idle',
  model: {
    current: () => ({ ...current }),
    select: (selection) => {
      current = { ...selection }
      append('select')
    },
  },
  inbox: { nextStep: [], nextTurn: [] },
  session: { header: { id: 'sess-io' }, requestHeader: () => undefined },
}
const timeline = []
let lastHash = hash()
let polling = true
const poll = (async () => {
  while (polling) {
    await sleep(2)
    const next = hash()
    if (next !== lastHash) {
      timeline.push({ at: Date.now(), bytes: bytesOf() })
      lastHash = next
    }
  }
})()
function append(kind) {
  timeline.push({ at: Date.now(), kind })
}

const inboxHandlers = listeners.get('agent/inbox/inserted') ?? []
const statusHandlers = listeners.get('agent/status') ?? []
const emits = async (i) => {
  // one completed turn per message: running -> idle, then the next message arrives
  // while the agent is idle (the followup case the real host wakes on).
  for (const handler of statusHandlers) handler({ agent, status: 'running' })
  for (const handler of statusHandlers) handler({ agent, status: 'idle' })
  const message = { id: `m${i}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'npm run verify' }] }
  agent.inbox.nextTurn.push(message)
  for (const handler of inboxHandlers) handler({ agent, message })
  agent.inbox.nextTurn.length = 0
  await sleep(40)
  return bytesOf()
}

const before = bytesOf()
const t0 = Date.now()
const afterFirst = await emits(1)
const afterSecond = await emits(2)
const afterThird = await emits(3)
polling = false
await poll

const writes = timeline.filter((entry) => entry.bytes !== undefined)
const json = (text) => JSON.parse(text)
const diffFields = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
}
console.log('== per-message state.json writes ==')
for (let i = 1; i <= 3; i += 1) {
  const snap = [afterFirst, afterSecond, afterThird][i - 1]
  console.log(`after message ${i}: revision=${json(snap).revision} applied=${Object.keys(json(snap).applied ?? {}).length} restore=${Object.keys(json(snap).restore ?? {}).length}`)
}
console.log(`\nobserved atomic writes in ${Date.now() - t0}ms window: ${writes.length}`)
console.log('fields changed vs before:', diffFields(json(before), json(afterThird)).join(', ') || '(none)')

// 2. re-apply (reload) without any message: must not write.
const settled = bytesOf()
const hashBeforeReload = hash()
listeners.clear()
await load()
await sleep(200)
const afterReload = bytesOf()
console.log('\n== reload ==')
console.log(`state.json changed by reload alone: ${afterReload !== settled}`)
console.log(`applied count after reload: ${Object.keys(JSON.parse(afterReload).applied ?? {}).length}`)

// 3. exact cost: how many bytes per message?
console.log(`\nstate.json size after 3 messages: ${afterThird.length} bytes (before: ${before.length})`)
try {
  const log = readFileSync(join(pluginDir, 'debug.log'), 'utf8').split('\n').filter(Boolean).slice(-12)
  console.log('\n== debug.log tail ==')
  for (const line of log) console.log(line)
} catch {
  console.log('\n(no debug.log)')
}
rmSync(home, { recursive: true, force: true })
