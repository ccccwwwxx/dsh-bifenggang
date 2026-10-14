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

// The peak (secondary) model is stored FLAT — { provider, model, reasoningEffort }
// — because that is the shape lib/text.js DEFAULTS declare and the shape the
// settings client reads (it renders the peak picker from `peak.provider` /
// `peak.model`). An earlier revision instead wrote it NESTED as
// `peak.model = { provider, model, ... }`; that round-trip silently broke the
// GUI: the picker read `peak.provider` as undefined, so it rendered empty, and
// the leftover nested object made the server fall back to the PRIMARY model on
// the next save — the user's peak selection was replaced right after saving.
// Both layouts are still ACCEPTED on input so policy.json files written by that
// revision keep their choice; the output is always the flat one.
function peakModelSource(peak) {
  if (typeof peak.provider === 'string' || typeof peak.model === 'string') return peak
  if (peak.model && typeof peak.model === 'object' && !Array.isArray(peak.model)) return peak.model
  return peak
}

function normalizeStrategy(value) {
  if (!value || typeof value !== 'object') return null
  const primary = normalizeModel(value.primary, {})
  if (!primary.provider || !primary.model) return null
  const peak = value.peak && typeof value.peak === 'object' ? value.peak : {}
  const peakWindows = parseWindows(peak.windows)
  const peakModel = normalizeModel(peakModelSource(peak), primary)
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
      provider: peakModel.provider,
      model: peakModel.model,
      reasoningEffort: peakModel.reasoningEffort,
    },
  }
}

// Why a strategy will be dropped, phrased for the GUI error message.
function describeStrategyIssue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'is not a strategy object'
  const primary = value.primary && typeof value.primary === 'object' ? value.primary : {}
  const missing = []
  if (typeof primary.provider !== 'string' || !primary.provider) missing.push('a primary provider')
  if (typeof primary.model !== 'string' || !primary.model) missing.push('a primary model')
  return missing.length > 0 ? `needs ${missing.join(' and ')}` : 'has an invalid primary model'
}

export function normalizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  // A strategy that cannot be normalized is an ERROR, never a silent drop: the
  // GUI clears the model when the provider changes, so dropping it would discard
  // the user's edit while the save still reports success.
  const rawStrategies = Array.isArray(cfg.strategies) ? cfg.strategies : DEFAULTS.strategies
  const strategies = []
  const dropped = []
  rawStrategies.forEach((value, index) => {
    const normalized = normalizeStrategy(value)
    if (normalized) strategies.push(normalized)
    else dropped.push({ index, issue: describeStrategyIssue(value) })
  })
  if (dropped.length > 0) {
    const details = dropped.slice(0, 3).map(({ index, issue }) => `strategy #${index + 1} ${issue}`).join('; ')
    const rest = dropped.length > 3 ? ` (+${dropped.length - 3} more)` : ''
    throw new Error(`dsh-peak-valley-router: ${details}${rest} — every strategy needs primary.provider and primary.model`)
  }
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
      // Flat by construction (see normalizeStrategy): the peak model lives on the
      // same object as `enabled` / `windows`, exactly as the client and text.js
      // DEFAULTS express it.
      return { provider: s.peak.provider, model: s.peak.model, reasoningEffort: s.peak.reasoningEffort }
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
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null // no policy file yet -> text.js DEFAULTS
  }
  try {
    return normalizeConfig(JSON.parse(raw))
  } catch (error) {
    debugLog(`policy.json invalid, falling back to text.js DEFAULTS: ${error instanceof Error ? error.message : String(error)}`)
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
  // Loading must never fail because of a bad config: an invalid composition
  // config (cordis.patch.yml) or an invalid policy.json degrades to text.js
  // DEFAULTS with one log line. The `set` RPC stays strict on purpose — there
  // the user is actively saving and must see the validation error in the GUI.
  let cfg
  try {
    cfg = loadPolicyFile() ?? normalizeConfig(config)
  } catch (error) {
    debugLog(`composition config invalid, falling back to text.js DEFAULTS: ${error instanceof Error ? error.message : String(error)}`)
    cfg = normalizeConfig(undefined)
  }
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
  // Decision log. The switch also makes a session's DEFAULT model follow the
  // policy (see the internal/get seam above), so on most requests the resolved
  // model is ALREADY the routed target and there is nothing to rewrite. Logging
  // only the rewrites therefore made a healthy install indistinguishable from a
  // broken one: "did routing run at all?" had no answer in the log. So the
  // decision itself is logged, throttled per distinct outcome (never per request).
  const fmtSelection = (s) => `${s.provider}/${s.model}${s.reasoningEffort ? `@${s.reasoningEffort}` : ''}`
  let lastOverride = ''
  let lastKept = ''
  const logOverride = (selection, resolved) => {
    const key = fmtSelection(selection)
    const from = fmtSelection(resolved)
    const line = `${key}|${from}`
    if (line === lastOverride) return // throttle: log each distinct outcome once
    lastOverride = line
    debugLog(`agent/request: overriding -> ${key} (session model was ${from})`)
  }
  const logKept = (selection) => {
    const key = fmtSelection(selection)
    if (key === lastKept) return
    lastKept = key
    debugLog(`agent/request: routed -> ${key} (session already resolved to it; nothing to rewrite)`)
  }

  // Fail-safe for the routed target, in two levels:
  //   1. provider: unregistered / empty / unreadable catalog -> keep the
  //      resolved model (the list is synchronous, so it is read per request).
  //   2. model: a registered provider can still have lost the model (subscription
  //      logged out, model retired). That is judged from a short-TTL cache which
  //      is only ever refreshed in the BACKGROUND — the request path never awaits
  //      listModels(). Unknown/not-warmed data always passes through: never block
  //      a request on missing information.
  const modelCatalog = new Map() // providerId -> { ids: Set<modelId>, at: number }
  const MODEL_CATALOG_TTL_MS = 60_000
  let modelCatalogRefreshing = false
  let lastCatalogRefreshAt = 0
  let staleRefreshScheduled = false

  let lastUnroutable = ''
  const logUnroutable = (provider) => {
    if (provider === lastUnroutable) return
    lastUnroutable = provider
    debugLog(`agent/request: routed provider "${provider}" is not registered -> keeping the resolved model`)
  }
  let lastUnroutableModel = ''
  const logUnroutableModel = (selection) => {
    const key = `${selection.provider}/${selection.model}`
    if (key === lastUnroutableModel) return
    lastUnroutableModel = key
    debugLog(`agent/request: routed model "${key}" is not in the provider catalog -> keeping the resolved model`)
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

  // Background-only refresh (never awaited on the request path). A provider whose
  // model list fails or times out loses its entry, i.e. falls back to "unknown".
  const refreshModelCatalog = async (reason) => {
    if (modelCatalogRefreshing) return
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return
    modelCatalogRefreshing = true
    lastCatalogRefreshAt = Date.now()
    let okCount = 0
    let failedCount = 0
    try {
      let listed
      try {
        listed = llm.listProviders()
      } catch (error) {
        modelCatalog.clear()
        debugLog(`model catalog: listProviders failed (${reason}): ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const providers = (Array.isArray(listed) ? listed : [])
        .map(toProviderOption)
        .filter((provider) => provider !== null && !isSelfProviderId(provider.id))
      const seen = new Set(providers.map((provider) => provider.id))
      await Promise.all(providers.map(async (provider) => {
        try {
          const listedModels = await withTimeout(Promise.resolve(llm.listModels(provider.id)), MODELS_TIMEOUT_MS)
          const ids = new Set((Array.isArray(listedModels) ? listedModels : [])
            .map(toModelOption)
            .filter((model) => model !== null)
            .map((model) => model.id))
          modelCatalog.set(provider.id, { ids, at: Date.now() })
          okCount += 1
        } catch {
          modelCatalog.delete(provider.id) // unknown again -> routing is allowed
          failedCount += 1
        }
      }))
      for (const key of [...modelCatalog.keys()]) if (!seen.has(key)) modelCatalog.delete(key)
      debugLog(`model catalog refreshed (${reason}): ${okCount} ok, ${failedCount} failed, ${modelCatalog.size} cached`)
    } catch (error) {
      debugLog(`model catalog refresh (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      modelCatalogRefreshing = false
    }
  }
  const requestModelCatalogRefresh = (reason) => {
    refreshModelCatalog(reason).catch((error) => {
      debugLog(`model catalog refresh (${reason}) rejected: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const isRoutable = (selection) => {
    const ids = catalogProviderIds()
    if (!ids || !ids.has(selection.provider)) {
      logUnroutable(selection.provider)
      return false
    }
    const entry = modelCatalog.get(selection.provider)
    if (!entry) return true // not warmed / refresh failed -> unknown, never block
    if (Date.now() - entry.at > MODEL_CATALOG_TTL_MS) {
      // Stale data never blocks, and the refresh it triggers is DEFERRED out of
      // this synchronous request path: starting it here would issue listModels
      // synchronously for every provider while the request is being resolved.
      if (!staleRefreshScheduled && Date.now() - lastCatalogRefreshAt > MODEL_CATALOG_TTL_MS) {
        staleRefreshScheduled = true
        setTimeout(() => {
          staleRefreshScheduled = false
          requestModelCatalogRefresh('stale')
        }, 0)
      }
      return true
    }
    if (!entry.ids.has(selection.model)) {
      logUnroutableModel(selection)
      return false
    }
    return true
  }

  // Refresh triggers: startup prewarm, adapter changes, and switching the plugin on.
  requestModelCatalogRefresh('apply')
  ctx.on('llm/adapters-updated', () => {
    modelCatalog.clear() // an adapter change invalidates every cached model list
    requestModelCatalogRefresh('adapters-updated')
  }, { global: true })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next() // downstream failures propagate untouched, never swallowed
    if (!enabled || !resolved || typeof resolved !== 'object') return resolved
    try {
      const selection = resolveSelection(new Date(), cfg)
      if (!selection || !selection.provider || !selection.model) return resolved
      if (!isRoutable(selection)) return resolved
      if (resolved.provider === selection.provider && resolved.model === selection.model) {
        logKept(selection)
        return resolved
      }
      logOverride(selection, resolved)
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
          // Log the rejection too: without it a GUI save failure is invisible in
          // debug.log, which is exactly what made the peak-model shape bug hard
          // to see (the save "succeeded", so only successes were ever logged).
          debugLog(`set rejected: ${error instanceof Error ? error.message : String(error)}`)
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
      // the routing gate above reacts without a restart. Switching on prewarms
      // the model catalog in the background (never on the request path).
      toggle: async (payload) => {
        const next = payload?.enabled === undefined ? enabled : Boolean(payload.enabled)
        await saveStateFile({ enabled: next })
        enabled = next
        if (enabled) requestModelCatalogRefresh('toggle')
        debugLog(`toggle: enabled -> ${enabled}`)
        return { ok: true, value: { enabled } }
      },
    }

    for (const [endpoint, handler] of Object.entries(handlers)) {
      connCtx.effect(() => register(fetchRouteFor(endpoint, handler)), `dsh-peak-valley-router: /api/${RPC_PREFIX}${endpoint}`)
    }
  })
}
