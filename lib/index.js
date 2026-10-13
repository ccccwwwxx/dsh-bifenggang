// dsh-peak-valley-router — multi-model routing policy engine for DeepSeek Harness.
//
// Policy model (policy.json written by the GUI; defaults live in lib/text.js):
//   strategies: ordered list; the first matching strategy wins.
//     each strategy = { name, description, weekdays, primary, peak }
//       primary = { provider, model, reasoningEffort }                 (off-peak model)
//       peak    = { enabled, windows, provider, model, reasoningEffort } (secondary model)
//   advancedSupport: fallback (escalation) used when NO strategy matches (REQUIRED).
//
// 避峰岗 is a SELECTION LAYER ABOVE providers, never a provider itself: this
// module registers no adapter, so the session model picker stays clean and no
// self-referential provider can appear in the catalog.
//
// On/off switch is persisted separately from the policy in state.json (default
// false). While it is off the plugin is fully transparent: `internal/get` is
// passed through untouched and no routing decision is ever applied.
//
// Routing has two seams, both gated by the same switch:
//   1. `internal/get` -> agentDefaultModel.currentSelection(): the UI default for
//      new sessions (session/modelCatalog.default reads it).
//   2. `agent/request` waterfall (prepended, so it runs outside the model
//      selection layer): the model a request actually resolves to. This is what
//      makes the switch functionally authoritative, because the client's session
//      model picker cannot be disabled by a third-party plugin; while the switch
//      is on, an already-selected session model is overridden here.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULTS } from './text.js'

export const name = 'dsh-peak-valley-router'

// Declare the service dependency so the harness resolves `ctx.llm` into this
// plugin's fiber before `apply` runs. Without it `ctx.llm` throws
// `cannot get property "llm" without inject` and the provider catalog stays empty.
export const inject = ['llm']

const RPC_PREFIX = 'dsh-peak-valley-router.'

// Provider ids that must never be offered as a routing target: the virtual
// provider this plugin used to register, its own id, and its display name.
const SELF_PROVIDER_IDS = new Set(['bifenggang', 'dsh-peak-valley-router', '避峰岗'])

const MODELS_TIMEOUT_MS = 10_000

function pluginDir() {
  const home = process.env.DSH_HOME
  if (!home) return null
  return join(home, 'plugins', 'dsh-peak-valley-router')
}

function policyFilePath() {
  const dir = pluginDir()
  return dir ? join(dir, 'policy.json') : null
}

function stateFilePath() {
  const dir = pluginDir()
  return dir ? join(dir, 'state.json') : null
}

function debugLog(msg) {
  const line = `[dsh-peak-valley-router] ${msg}`
  try { console.error(line) } catch {}
  try {
    const dir = pluginDir()
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'debug.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// ---------- provider / model catalog normalization ----------

function isSelfProviderId(value) {
  return typeof value === 'string' && SELF_PROVIDER_IDS.has(value.trim().toLowerCase())
}

function isSelfProvider(entry) {
  return isSelfProviderId(entry?.id) || isSelfProviderId(entry?.name)
}

function toProviderOption(entry) {
  if (typeof entry === 'string') return entry ? { id: entry, name: entry } : null
  if (!entry || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' && entry.id ? entry.id : ''
  if (!id) return null
  return { id, name: typeof entry.name === 'string' && entry.name ? entry.name : id }
}

function toModelOption(entry) {
  if (typeof entry === 'string') return entry ? { id: entry, name: entry } : null
  if (!entry || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' && entry.id
    ? entry.id
    : (typeof entry.model === 'string' && entry.model ? entry.model : '')
  if (!id) return null
  return { id, name: typeof entry.name === 'string' && entry.name ? entry.name : id }
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---------- config normalization ----------

function normalizeModel(value, fallback) {
  const f = fallback || {}
  if (!value || typeof value !== 'object') {
    return { provider: f.provider, model: f.model, reasoningEffort: f.reasoningEffort }
  }
  return {
    provider: typeof value.provider === 'string' && value.provider ? value.provider : f.provider,
    model: typeof value.model === 'string' && value.model ? value.model : f.model,
    reasoningEffort: typeof value.reasoningEffort === 'string' && value.reasoningEffort ? value.reasoningEffort : f.reasoningEffort,
  }
}

function parseWindows(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((w) => Array.isArray(w) && w.length === 2)
    .map((w) => [String(w[0]), String(w[1])])
    .filter(([s, e]) => /^\d{1,2}:\d{2}$/.test(s) && /^\d{1,2}:\d{2}$/.test(e))
}

function parseHolidays(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((h) => Array.isArray(h) && h.length === 3)
    .map(([y, m, d]) => [Number(y), Number(m), Number(d)])
    .filter(([y, m, d]) => Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d))
}

function normalizeStrategy(value) {
  if (!value || typeof value !== 'object') return null
  const primary = normalizeModel(value.primary, {})
  if (!primary.provider || !primary.model) return null
  const peak = value.peak && typeof value.peak === 'object' ? value.peak : {}
  const peakWindows = parseWindows(peak.windows)
  const weekdays = (Array.isArray(value.weekdays) && value.weekdays.length
    ? value.weekdays.map(Number)
    : [1, 2, 3, 4, 5]).filter((n) => n >= 1 && n <= 7)
  return {
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : '',
    weekdays,
    primary,
    peak: {
      enabled: peak.enabled === true && peakWindows.length > 0,
      windows: peakWindows,
      model: normalizeModel(peak, primary),
    },
  }
}

export function normalizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const strategies = (Array.isArray(cfg.strategies) ? cfg.strategies : DEFAULTS.strategies)
    .map(normalizeStrategy)
    .filter(Boolean)
  // "advancedSupport omitted" and "advancedSupport explicitly empty" are NOT the
  // same thing: an omitted field falls back to text.js DEFAULTS (first install
  // keeps working), while an explicitly supplied-but-empty one is a user error
  // and is rejected once strategies exist. Only provider/model are mandatory, so
  // an explicit object still inherits the optional reasoning-effort default.
  const rawAdvancedSupport = cfg.advancedSupport ?? cfg.exclusive
  const explicitAdvancedSupport = rawAdvancedSupport !== undefined && rawAdvancedSupport !== null
  const advancedSupport = normalizeModel(
    rawAdvancedSupport,
    explicitAdvancedSupport ? { reasoningEffort: DEFAULTS.advancedSupport?.reasoningEffort } : DEFAULTS.advancedSupport,
  )
  if (strategies.length > 0 && (!advancedSupport.provider || !advancedSupport.model)) {
    throw new Error('dsh-peak-valley-router: advanced model support (高级模型支援) is required when strategies are configured')
  }
  return {
    utcOffsetMinutes: Number.isFinite(Number(cfg.utcOffsetMinutes)) ? Number(cfg.utcOffsetMinutes) : DEFAULTS.utcOffsetMinutes,
    holidays: parseHolidays(cfg.holidays ?? DEFAULTS.holidays),
    strategies,
    advancedSupport,
  }
}

// ---------- routing ----------

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map((n) => Number(n))
  return h * 60 + m
}

function timeInWindows(minutes, windows) {
  if (!windows || windows.length === 0) return false
  return windows.some(([s, e]) => minutes >= minutesOf(s) && minutes < minutesOf(e))
}

function isHoliday(year, month, day, holidays) {
  return holidays.some(([y, m, d]) => y === year && m === month && d === day)
}

// Resolve the model selection for a given instant against a NORMALIZED config.
export function resolveSelection(date, cfg) {
  const shifted = new Date(date.getTime() + cfg.utcOffsetMinutes * 60_000)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  const weekday = ((shifted.getUTCDay() + 6) % 7) + 1 // 1=Mon..7=Sun
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const holiday = isHoliday(year, month, day, cfg.holidays)

  for (const s of cfg.strategies) {
    if (!s.weekdays.includes(weekday)) continue
    if (s.peak.enabled && !holiday && timeInWindows(minutes, s.peak.windows)) {
      return { ...s.peak.model }
    }
    return { ...s.primary }
  }
  if (cfg.advancedSupport.provider && cfg.advancedSupport.model) return { ...cfg.advancedSupport }
  return null
}

export function selectFor(date, config) {
  return resolveSelection(date, normalizeConfig(config))
}

// ---------- persisted files (policy.json / state.json) ----------

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

function loadPolicyFile() {
  const path = policyFilePath()
  if (!path) return null
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

async function savePolicyFile(config) {
  const path = policyFilePath()
  if (!path) return
  await writeJsonAtomic(path, normalizeConfig(config))
}

// The on/off switch is stored apart from the policy so a policy save can never
// silently flip routing on (or off). Absent/corrupt state means "off".
function loadStateFile() {
  const path = stateFilePath()
  if (!path) return { enabled: false }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { enabled: raw?.enabled === true }
  } catch {
    return { enabled: false }
  }
}

async function saveStateFile(state) {
  const path = stateFilePath()
  if (!path) return
  await writeJsonAtomic(path, { enabled: state.enabled === true })
}

// ---------- RPC (fetch routes on the /api channel) ----------

function readEnvelope(body) {
  if (typeof body !== 'object' || body === null) return undefined
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') return undefined
  return { rpcId: body.rpcId, method: body.method, payload: body.payload }
}

function serverResponse(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

function rpcError(rpcId, code, message) {
  return serverResponse(rpcId, { ok: false, error: { code, message, details: { issues: [] } } })
}

function fetchRouteFor(endpoint, handler) {
  const method = `${RPC_PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        return rpcError('invalid-request', 'bad-request', 'invalid client-request message')
      }
      if (envelope.method !== method) {
        return rpcError(envelope.rpcId, 'bad-request', `method mismatch for ${method}`)
      }
      try {
        return serverResponse(envelope.rpcId, await handler(envelope.payload, request.signal))
      } catch (error) {
        return rpcError(envelope.rpcId, 'internal', error instanceof Error ? error.message : String(error))
      }
    },
  }
}

// ---------- plugin entry ----------

export function apply(ctx, config) {
  let cfg = loadPolicyFile() ?? normalizeConfig(config)
  let enabled = loadStateFile().enabled
  let llm = null
  try { llm = ctx.llm } catch (e) {
    debugLog(`ctx.llm failed: ${e?.message ?? e}`)
  }
  if (!llm) {
    try { llm = ctx.get?.('llm') } catch (e) { debugLog(`ctx.get('llm') failed: ${e?.message ?? e}`) }
  }
  debugLog(`apply: enabled=${enabled}, ${cfg.strategies.length} strategies, advancedSupport -> ${cfg.advancedSupport.provider}/${cfg.advancedSupport.model}, llm -> ${!!llm}`)

  // NOTE: no provider adapter is registered here on purpose. 避峰岗 routes by
  // intercepting the default-model service below; it must not appear in the
  // provider registry (that would pollute the session picker and self-loop).

  // Intercept the default-model service. Everything except `agentDefaultModel`
  // passes straight through, so unrelated service access is unaffected.
  ctx.on('internal/get', (child, name, error, next) => {
    if (name !== 'agentDefaultModel') return next()
    const base = next()
    // Gate 1: switch off (or no base service) -> untouched pass-through, exactly
    // as if this plugin were not installed.
    if (!enabled || !base || typeof base !== 'object') return base
    const wrapper = Object.create(base)
    wrapper.currentSelection = () => {
      // Gate 2: re-checked per call, so turning the switch off takes effect
      // immediately and a long-lived fiber stops being routed.
      if (!enabled) return typeof base.currentSelection === 'function' ? base.currentSelection() : null
      const selection = resolveSelection(new Date(), cfg)
      if (selection && selection.provider && selection.model) return selection
      return typeof base.currentSelection === 'function' ? base.currentSelection() : null
    }
    return wrapper
  }, { global: true })

  // Override the resolved model of every request. Registered with
  // `prepend: true` so this listener is the OUTERMOST one in the waterfall: it
  // runs before the harness's own model-selection listener, so it can rewrite
  // the value that layer resolved (session choice > request header > deployment
  // default). `global: true` is required to receive events dispatched from other
  // scopes. There is no recursion here: `next()` is called exactly once and its
  // result is only rewritten, never re-dispatched.
  let lastOverride = ''
  const logOverride = (selection) => {
    const key = `${selection.provider}/${selection.model}${selection.reasoningEffort ? `@${selection.reasoningEffort}` : ''}`
    if (key === lastOverride) return // throttle: log each routed target once
    lastOverride = key
    debugLog(`agent/request: overriding -> ${key}`)
  }

  // Fail-safe for the routed target: pointing a session at a provider that is
  // not registered would fail every request, so an unknown/empty/unreadable
  // catalog means "keep the resolved model" (plus one throttled log line).
  // listProviders() is synchronous and cheap, so it is read per request instead
  // of cached (no staleness when a subscription logs in or out).
  let lastUnroutable = ''
  const logUnroutable = (provider) => {
    if (provider === lastUnroutable) return
    lastUnroutable = provider
    debugLog(`agent/request: routed provider "${provider}" is not registered -> keeping the resolved model`)
  }
  let lastCatalogError = ''
  const catalogProviderIds = () => {
    if (!llm || typeof llm.listProviders !== 'function') return null
    try {
      const listed = llm.listProviders()
      if (!Array.isArray(listed)) return null
      return new Set(listed.map((p) => (typeof p === 'string' ? p : p?.id)).filter((id) => typeof id === 'string' && id))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastCatalogError) { // throttled: an unreadable catalog must not spam per request
        lastCatalogError = message
        debugLog(`agent/request: listProviders failed: ${message}`)
      }
      return null
    }
  }
  const isRoutable = (selection) => {
    const ids = catalogProviderIds()
    if (ids && ids.has(selection.provider)) return true
    logUnroutable(selection.provider)
    return false
  }

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next() // downstream failures propagate untouched, never swallowed
    if (!enabled || !resolved || typeof resolved !== 'object') return resolved
    try {
      const selection = resolveSelection(new Date(), cfg)
      if (!selection || !selection.provider || !selection.model) return resolved
      if (!isRoutable(selection)) return resolved
      if (resolved.provider === selection.provider && resolved.model === selection.model) return resolved
      logOverride(selection)
      return {
        ...resolved,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    } catch (error) {
      // Never let routing break a session: on any failure keep the resolved model.
      debugLog(`agent/request override failed: ${error instanceof Error ? error.message : String(error)}`)
      return resolved
    }
  }, { global: true, prepend: true })

  // RPC for the GUI: policy (get/set), switch (toggle), catalog (providers/models).
  ctx.inject(['connection'], (connCtx) => {
    const connection = connCtx.get('connection')
    if (!connection || typeof connection.fetch?.register !== 'function') return
    const register = connection.fetch.register

    const handlers = {
      // { config, enabled } — the switch rides along with the policy payload.
      get: async () => ({ ok: true, value: { config: cfg, enabled } }),

      // Validate + persist the policy, then echo the normalized config.
      // `value.config` is the normalized policy; the same fields are also spread
      // onto `value` so both `value` and `value.config` clients stay compatible.
      set: async (payload) => {
        if (!payload || typeof payload.config !== 'object' || payload.config === null) {
          return { ok: false, error: { code: 'bad-request', message: 'set: a config object is required', details: { issues: [] } } }
        }
        let next
        try {
          next = normalizeConfig(payload.config)
        } catch (error) {
          return {
            ok: false,
            error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error), details: { issues: [] } },
          }
        }
        await savePolicyFile(next)
        cfg = next
        debugLog(`set: ${cfg.strategies.length} strategies, advancedSupport -> ${cfg.advancedSupport.provider}/${cfg.advancedSupport.model}`)
        return { ok: true, value: { ...next, config: next } }
      },

      // Every registered provider (API keys and subscriptions alike), minus
      // this plugin itself. Unavailable/failed -> empty list, never an error.
      providers: async () => {
        if (!llm || typeof llm.listProviders !== 'function') {
          debugLog('providers: llm unavailable -> []')
          return { ok: true, value: { providers: [] } }
        }
        let listed
        try {
          listed = llm.listProviders()
        } catch (error) {
          debugLog(`providers: listProviders error -> []: ${error instanceof Error ? error.message : String(error)}`)
          return { ok: true, value: { providers: [] } }
        }
        const providers = (Array.isArray(listed) ? listed : [])
          .filter((entry) => !isSelfProvider(entry)) // <- self-filter: never offer 避峰岗
          .map(toProviderOption)
          .filter((entry) => entry !== null && !isSelfProviderId(entry.id))
        debugLog(`providers -> ${providers.map((p) => p.id).join(', ') || '(none)'}`)
        return { ok: true, value: { providers } }
      },

      // Models advertised by one provider, normalized to [{id,name}]. Unknown
      // provider, self provider, timeout or any failure -> [], never an error.
      models: async (payload) => {
        const provider = typeof payload?.provider === 'string' ? payload.provider.trim() : ''
        if (!provider || isSelfProviderId(provider)) {
          if (provider) debugLog(`models(${provider}) -> [] (self provider)`)
          return { ok: true, value: [] }
        }
        if (!llm || typeof llm.listModels !== 'function') {
          debugLog(`models(${provider}) -> [] (llm unavailable)`)
          return { ok: true, value: [] }
        }
        try {
          const listed = await withTimeout(Promise.resolve(llm.listModels(provider)), MODELS_TIMEOUT_MS)
          const models = (Array.isArray(listed) ? listed : [])
            .map(toModelOption)
            .filter((entry) => entry !== null)
          return { ok: true, value: models }
        } catch (error) {
          debugLog(`models(${provider}) -> []: ${error instanceof Error ? error.message : String(error)}`)
          return { ok: true, value: [] }
        }
      },

      // Persist the on/off switch; the in-memory flag mirrors it immediately so
      // the routing gate above reacts without a restart.
      toggle: async (payload) => {
        const next = payload?.enabled === undefined ? enabled : Boolean(payload.enabled)
        await saveStateFile({ enabled: next })
        enabled = next
        debugLog(`toggle: enabled -> ${enabled}`)
        return { ok: true, value: { enabled } }
      },
    }

    for (const [endpoint, handler] of Object.entries(handlers)) {
      connCtx.effect(() => register(fetchRouteFor(endpoint, handler)), `dsh-peak-valley-router: /api/${RPC_PREFIX}${endpoint}`)
    }
  })
}
