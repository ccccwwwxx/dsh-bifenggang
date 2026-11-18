// `agent/request` must be OBSERVATION ONLY.
//
// Core 0.2.2-rc.1's prepareRequest() compares provider/model/reasoningEffort with
// the selection fixed during step preparation and THROWS on any difference:
//   agent "…": agent/request proposed "x/y" after step preparation fixed "a/b";
//   use agent.model.select() before step preparation
// So this file pins two independent things:
//   1. Source level: the agent/request handler contains no field assignment and
//      returns the downstream config by identity.
//   2. Behaviour level: driving the real handler returns a deep-equal config.
// It also carries a NEGATIVE CONTROL: the same detector must flag the 0.15
// rewrite snippet, so a weakened check cannot silently pass.
// Run: node scripts/request-passthrough.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')
const index = await import(pathToFileURL(join(libDir, 'index.js')).href)
const { DEFAULTS } = await import(new URL('../lib/text.js', import.meta.url))

console.error = () => {}
process.env.DSH_HOME = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-pv-passthrough-${process.pid}`)

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}

// ---------- static detector ----------

// Extract the agent/request listener body. Everything between the registration
// and the next top-level `}, { global: true })` is the handler; finding it by
// marker keeps this test honest when the file is rearranged.
function extractRequestHandler(source) {
  const start = source.indexOf("ctx.on('agent/request'")
  if (start < 0) throw new Error('agent/request listener not found in lib/index.js')
  const end = source.indexOf('}, { global: true })', start)
  if (end < 0) throw new Error('cannot find the end of the agent/request registration')
  return source.slice(start, end)
}

// A rewrite means assigning/overriding provider/model/reasoningEffort on the
// returned config, or rebuilding it with a spread. A read-only observer may only
// format the config for a log line.
function findRewrite(source) {
  const handler = extractRequestHandler(source)
  const problems = []
  for (const match of handler.matchAll(/\b(config|resolved|proposedConfig)\.(provider|model|reasoningEffort)\s*=/g)) {
    problems.push(`assigns ${match[1]}.${match[2]}`)
  }
  if (/\.\.\.\s*(config|resolved|proposedConfig)\s*,\s*\n?\s*(provider|model|reasoningEffort)\s*:/.test(handler)) problems.push('rebuilds the config with an overridden field')
  if (/\bprovider\s*:\s*selection\.provider/.test(handler)) problems.push('injects the routed selection provider')
  if (/\breturn\s*\{\s*\.\.\.\s*(config|resolved)/.test(handler)) problems.push('returns a copy with overridden fields')
  if (!/\breturn\s+config\b/.test(handler)) problems.push('does not return the downstream config unchanged')
  return problems
}

const source = readFileSync(join(libDir, 'index.js'), 'utf8')

check('control: the detector flags the 0.15 agent/request rewrite', () => {
  // Verbatim shape of the 0.15.0 handler (lib/index.js:699-746 at v0.15.0).
  const legacy = `
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const selection = resolveSelectionDetailed(new Date(), cfg).selection
    return {
      ...resolved,
      provider: selection.provider,
      model: selection.model,
      ...((selection.reasoningEffort || !sameModel) ? { reasoningEffort: selection.reasoningEffort || undefined } : {}),
    }
  }, { global: true })
  `
  const problems = findRewrite(legacy)
  if (problems.length === 0) throw new Error('the detector is broken: it accepted the old rewrite')
  if (!problems.some((problem) => problem.includes('provider'))) throw new Error(`unexpected problems: ${JSON.stringify(problems)}`)
})

check('control: the detector flags a direct field assignment on the resolved config', () => {
  const legacy = `
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    config.model = 'deepseek-flash'
    config.reasoningEffort = 'low'
    return config
  }, { global: true })
  `
  const problems = findRewrite(legacy)
  if (problems.length < 2) throw new Error(`expected assignments to be flagged, got ${JSON.stringify(problems)}`)
})

check('the real agent/request handler performs no rewrite (source level)', () => {
  const problems = findRewrite(source)
  if (problems.length > 0) throw new Error(`agent/request still rewrites: ${problems.join('; ')}`)
})

check('the old override log lines are gone (they would confuse the new seam)', () => {
  const forbidden = ['agent/request: overriding', 'agent/request: routed', 'agent/request: routed ->']
  for (const needle of forbidden) {
    if (source.includes(needle)) throw new Error(`stale log line still present: ${needle}`)
  }
})

check('lib/ never prepends an agent/request listener', () => {
  if (/agent\/request[\s\S]{0,200}prepend\s*:\s*true/.test(source)) throw new Error('agent/request is still registered with prepend: true')
})

// ---------- behavioural check ----------

function makeHost() {
  const listeners = new Map()
  const routes = new Map()
  const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codex', name: 'Codex' }]
  const models = {
    'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }],
    codex: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
  }
  const llm = {
    listProviders: () => providers,
    listModels: async (provider) => models[provider] ?? [],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] } }),
  }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
  const connCtx = { get: (n) => (n === 'connection' ? connection : undefined), effect: (fn) => { fn(); return () => {} } }
  index.apply({
    llm,
    get: (n) => (n === 'llm' ? llm : undefined),
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    inject: (deps, cb) => { if (deps.includes('connection')) cb(connCtx) },
    effect: (fn) => { fn(); return () => {} },
  })
  return { listeners }
}

const host = makeHost()
await new Promise((resolve) => setTimeout(resolve, 60))
const requestListener = host.listeners.get('agent/request')?.[0]
if (typeof requestListener !== 'function') throw new Error('agent/request listener not registered')

check('the returned config is the downstream object by identity (switch ON)', async () => {
  const config = {
    provider: 'codex',
    model: 'gpt-6-astra',
    reasoningEffort: 'high',
    maxTokens: 4096,
    tools: [{ name: 'read' }],
  }
  const agent = { session: { header: { id: 's1' } }, id: 's1' }
  const out = await requestListener({ agent, turn: 1, step: 1 }, async () => config)
  assert.equal(out, config, 'the observer must return the exact same object')
  eq(out, config, 'deep equality')
})

check('an effort-only difference is still passed through untouched (switch ON)', async () => {
  // The routed target is deepseek-flash@low; a handler that still rewrote would
  // force low here and trip 0.2.2-rc.1's post-step check.
  const config = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }
  const agent = { session: { header: { id: 's1' } }, id: 's1' }
  const out = await requestListener({ agent, turn: 1, step: 1 }, async () => config)
  assert.equal(out, config, 'identity')
  eq(out.reasoningEffort, 'max', 'effort untouched')
})

check('a rejected downstream call propagates instead of being swallowed', async () => {
  const agent = { session: { header: { id: 's1' } }, id: 's1' }
  await assert.rejects(
    () => requestListener({ agent, turn: 1, step: 1 }, async () => { throw new Error('downstream boom') }),
    /downstream boom/,
  )
})

check('the observation does not depend on the shipped policy (switch ON)', () => {
  if (DEFAULTS.schemaVersion !== 2) throw new Error('expected the v2 defaults')
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
console.log(failures === 0 ? 'request-passthrough: 全部通过' : `request-passthrough: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
