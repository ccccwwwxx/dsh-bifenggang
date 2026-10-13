// dsh-peak-valley-router — multi-model routing policy engine for DeepSeek Harness.
//
// Policy model (patch config, or policy.json written by the GUI):
//   strategies: ordered list; the first matching strategy wins.
//     each strategy = { name, description, weekdays, primary, peak }
//       primary = { provider, model, reasoningEffort }                 (off-peak model)
//       peak    = { enabled, windows, provider, model, reasoningEffort } (secondary model)
//   exclusive: fallback selection used when NO strategy matches (REQUIRED).
//
// Routing intercepts ctx.agentDefaultModel.currentSelection(), so a user's
// explicit per-session model choice (stored on the session) always wins.

import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'dsh-peak-valley-router'

const DEFAULTS = Object.freeze({
  utcOffsetMinutes: 480, // UTC+8; China observes no DST
})

const RPC_PREFIX = 'dsh-peak-valley-router.'

function policyFilePath() {
  const home = process.env.DSH_HOME
  if (!home) return null
  return join(home, 'plugins', 'dsh-peak-valley-router', 'policy.json')
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
  const strategies = (Array.isArray(cfg.strategies) ? cfg.strategies : [])
    .map(normalizeStrategy)
    .filter(Boolean)
  const exclusive = normalizeModel(cfg.exclusive, {})
  if (strategies.length > 0 && (!exclusive.provider || !exclusive.model)) {
    throw new Error('dsh-peak-valley-router: exclusive strategy (互斥策略) is required when strategies are configured')
  }
  return {
    utcOffsetMinutes: Number.isFinite(Number(cfg.utcOffsetMinutes)) ? Number(cfg.utcOffsetMinutes) : DEFAULTS.utcOffsetMinutes,
    holidays: parseHolidays(cfg.holidays),
    strategies,
    exclusive,
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
  if (cfg.exclusive.provider && cfg.exclusive.model) return { ...cfg.exclusive }
  return null
}

export function selectFor(date, config) {
  return resolveSelection(date, normalizeConfig(config))
}

// ---------- persisted config ----------

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
  const normalized = normalizeConfig(config)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
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
  let llm = null
  try { llm = ctx.llm } catch { /* llm service unavailable; providers list stays empty */ }
  if (typeof ctx.logger?.warn === 'function') {
    ctx.logger.warn(
      `[dsh-peak-valley-router] ${cfg.strategies.length} strategies, ` +
      `exclusive -> ${cfg.exclusive.provider}/${cfg.exclusive.model}`
    )
  }

  // Intercept the default-model service. Everything except `agentDefaultModel`
  // passes straight through, so unrelated service access is unaffected.
  ctx.on('internal/get', (child, name, error, next) => {
    if (name !== 'agentDefaultModel') return next()
    const base = next()
    if (!base) return base
    const wrapper = Object.create(base)
    wrapper.currentSelection = () =>
      resolveSelection(new Date(), cfg) ?? (typeof base.currentSelection === 'function' ? base.currentSelection() : null)
    return wrapper
  }, { global: true })

  // RPC for the GUI (get/set policy + list configured providers/models).
  ctx.inject(['connection'], (connCtx) => {
    const connection = connCtx.get('connection')
    if (!connection || typeof connection.fetch?.register !== 'function') return
    const register = connection.fetch.register

    const handlers = {
      get: async () => ({ ok: true, value: cfg }),
      set: async (payload) => {
        const next = normalizeConfig(payload?.config)
        cfg = next
        await savePolicyFile(next)
        return { ok: true, value: next }
      },
      providers: async () => {
        if (!llm || typeof llm.listProviders !== 'function') return { ok: true, value: { providers: [], models: {} } }
        const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
        try {
          const providers = await withTimeout(llm.listProviders(), 5000)
          const models = {}
          for (const p of providers) {
            try { models[p.id] = await withTimeout(llm.listModels(p.id), 5000) } catch { models[p.id] = [] }
          }
          return { ok: true, value: { providers, models } }
        } catch (e) {
          return { ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e), details: { issues: [] } } }
        }
      },
    }

    for (const [endpoint, handler] of Object.entries(handlers)) {
      connCtx.effect(() => register(fetchRouteFor(endpoint, handler)), `dsh-peak-valley-router: /api/${RPC_PREFIX}${endpoint}`)
    }
  })
}
