// dsh-peak-valley-router — multi-model routing policy engine for DeepSeek Harness.
//
// ⚠ 0.16.0 的接缝变了（docs/ROUTING_V2_DESIGN.md §1）：核心 0.2.2-rc.1 的
// `prepareRequest()` 会在 `agent/request` waterfall 返回后逐字段比较
// provider/model/reasoningEffort，只要与步骤准备时固定的 selection 不同就 throw
// （"use agent.model.select() before step preparation"）。所以本插件**不再**在
// `agent/request` 里改写任何字段，只在 `agent/inbox/inserted`（同步，且在
// wakeDriver 之前）与 `agent/turn-stopping`（排队的下一 turn）调用
// `agent.model.select()`。`agent/request` 与 `agent/pre-step` 只做只读观察，
// 用于日志与「目标是否真的生效」的回归断言。
//
// 策略模型（policy.json；默认值在 lib/text.js 的 DEFAULTS，schema v2）：
//   targets.low/mid/high：每档自己的 valley（谷时目标）+ peak（峰时目标/星期/窗口）
//   + costRouting（该档成本决策开关）。mid/high 可用 { share: 'low' } 共用低档表。
//   tierRouting.enabled：智能程度路由总开关（默认 false → 恒低档，等价 0.15）。
//   advancedSupport：仅会话 baseline 要求 max 思考时使用的独立轴，不是兜底。
//   holidays / utcOffsetMinutes：根级，全部档共享。
//
// v1（strategies + advancedSupport）仍可读：在内存里迁移成 v2（不写盘），用户
// 保存时才写 v2 并另存 policy.json.bak-v1-<ts>（§2.4）。
//
// 避峰岗 是 providers 之上的「选择层」，不注册任何 adapter（否则会污染会话模型
// 选择器并自我循环）。开关（state.json）默认关闭；关闭时插件完全透明。

import { readFileSync, appendFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  normalizeConfig,
  normalizeConfigDetailed,
  resolveTargets,
  decide,
  fallbackSelection,
  isV1Config,
  findRoleRule,
  TIERS,
} from './routing.js'
import { classify, collectFromMessages } from './classifier.js'
import { createStateStore, watchStateFiles, contentHash } from './state.js'

// Pure routing helpers are re-exported so tests, the GUI contract and downstream
// tasks (t6/t10) can import one module; the implementation lives in routing.js.
export {
  normalizeConfig,
  migrateV1,
  resolveTargets,
  resolveCost,
  decide,
  resolveSelectionDetailed,
  resolveSelection,
  selectFor,
  fallbackSelection,
  localParts,
  timeInWindows,
  isHoliday,
  isV1Config,
  findRoleRule,
  ConfigError,
  SCHEMA_VERSION,
  TIERS,
} from './routing.js'

export const name = 'dsh-peak-valley-router'

// Declare the service dependency so the harness resolves `ctx.llm` into this
// plugin's fiber before `apply` runs. `agents` is looked up lazily (optional):
// 0.2.0/0.2.1 have no `agent.model`, and a hard dependency would make the plugin
// unloadable there instead of transparently inert.
export const inject = ['llm']

// Message `source.kind` values that carry an EXECUTION INTENT for this session.
// Routing/classification must run on intent, never on injected context:
//   - `user`: real user prompts (dsh-llm createUserMessage default).
//   - `agent-teams`: AgentTeams member/captain deliveries. The plugin sends
//     `{ kind: 'agent-teams' }` (see @nanmicoder/dsh-agent-teams
//     members.js#agentTeamsSource) and the payload is an instruction to the
//     receiving member, so it is user-equivalent intent.
// Released-format hosts wrap that source as `{ kind: 'plugin' }`, which is why
// `plugin` is listed as a KNOWN non-intent source below (see agentTeamsSource
// hostSessionFormatVersion branch): plugins may also inject invisible context,
// and treating every plugin message as intent would be wrong.
const INTENT_SOURCE_KINDS = new Set(['user', 'agent-teams'])
// Known non-intent sources. They are injected context or notices, never prompts:
// system-prompt / runtime-context are harness-rendered context; model-selection is
// the "model changed" notice; subagent-settled is a subagent completion notice;
// plugin is the released-format AgentTeams wrapper (see above). They keep the
// unknown-kind log quiet but still never trigger routing.
const NON_INTENT_SOURCE_KINDS = new Set(['system-prompt', 'runtime-context', 'model-selection', 'subagent-settled', 'plugin'])

const RPC_PREFIX = 'dsh-peak-valley-router.'

// Provider ids that must never be offered as a routing target: the virtual
// provider this plugin used to register, its own id, and its display name.
const SELF_PROVIDER_IDS = new Set(['bifenggang', 'dsh-peak-valley-router', '避峰岗'])

const MODELS_TIMEOUT_MS = 10_000
const MODEL_CATALOG_TTL_MS = 60_000
const EFFORT_TTL_MS = 5 * 60_000
const MAX_WARNINGS = 20
const MAX_DECISIONS = 200

// The version lives in package.json and nowhere else — reading it here means the
// running code can always REPORT which build it is, which is what answers "did my
// change actually load?" (the failure mode that cost us a debugging round: the
// fix was on disk but the process still had the old module). Surfaced in the
// apply log line and in the `get` RPC (shown in the settings section).
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const VERSION = readVersion()

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

function cloneSelection(selection) {
  if (!selection || !selection.provider || !selection.model) return null
  const out = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) {
    out.reasoningEffort = String(selection.reasoningEffort)
  }
  return out
}

function sameSelection(a, b) {
  if (!a || !b) return false
  return a.provider === b.provider
    && a.model === b.model
    && (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined)
}

function fmtSelection(selection) {
  if (!selection) return '-'
  return `${selection.provider}/${selection.model}${selection.reasoningEffort ? `@${selection.reasoningEffort}` : ''}`
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

function readRawPolicy() {
  const path = policyFilePath()
  if (!path) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
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
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    debugLog(`policy.json invalid, falling back to text.js DEFAULTS: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  try {
    const detailed = normalizeConfigDetailed(parsed)
    const config = detailed.config
    const migrated = Boolean(parsed && typeof parsed === 'object' && parsed.targets === undefined)
    // v1 files are migrated in memory and left untouched on disk; only a user
    // save writes v2 (and backs the v1 file up first). `migrated` is what lets
    // apply() raise the visible legacy-extra-strategies compatibility warning.
    if (migrated) debugLog(`policy: read v1 (in-memory v2), revision ${config.revision}`)
    return { config, migrated, droppedHolidays: detailed.droppedHolidays }
  } catch (error) {
    debugLog(`policy.json invalid, falling back to text.js DEFAULTS: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// Before the first v2 write, keep the exact v1 file: the migration drops
// strategies[1..] from routing, and the user must be able to get them back.
function backupV1Policy() {
  const path = policyFilePath()
  if (!path) return null
  const raw = readRawPolicy()
  if (!raw || typeof raw !== 'object' || raw.targets !== undefined) return null
  const backup = `${path}.bak-v1-${Date.now()}`
  try {
    copyFileSync(path, backup)
    debugLog(`policy: v1 backed up -> ${backup}`)
    return backup
  } catch (error) {
    debugLog(`policy: v1 backup failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function savePolicyFile(config) {
  const path = policyFilePath()
  const text = JSON.stringify(config, null, 2)
  const hash = contentHash(text)
  if (!path) return hash
  backupV1Policy()
  await writeJsonAtomic(path, config)
  return hash
}

// The on/off switch is stored apart from the policy so a policy save can never
// silently flip routing on (or off). state.json v2 (per-key merge, lock, watch,
// restore persistence) lives in lib/state.js; this file owns only the host wiring.
// The `sessions` map there is a Map on purpose: object key order puts INTEGER-LIKE
// keys first, so delete-then-set on a plain object would evict a just-written id.

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
  let migratedFromV1 = false
  // t21: first-run flag for the GUI's onboarding note. "Startup had no
  // policy.json" is a process-local fact (no schema/file change): a v1 file
  // counts as an existing policy, and the first successful `set` flips it false.
  const startupPolicyPath = policyFilePath()
  let firstRun = !(startupPolicyPath && existsSync(startupPolicyPath))
  // Invalid holiday dates are dropped by normalizeConfigDetailed (never fatal);
  // the count is surfaced as an info warning after the warnings subsystem exists.
  let droppedHolidaysAtLoad = 0
  // Hash of the last policy.json we wrote ourselves. The fs.watch handler compares
  // against it so our own save does not trigger a reload loop.
  let lastPolicyHash = null
  try {
    const loaded = loadPolicyFile()
    if (loaded) {
      cfg = loaded.config
      migratedFromV1 = loaded.migrated
      droppedHolidaysAtLoad = loaded.droppedHolidays
    } else {
      const detailed = normalizeConfigDetailed(config)
      cfg = detailed.config
      migratedFromV1 = isV1Config(config)
      droppedHolidaysAtLoad = detailed.droppedHolidays
    }
  } catch (error) {
    debugLog(`composition config invalid, falling back to text.js DEFAULTS: ${error instanceof Error ? error.message : String(error)}`)
    cfg = normalizeConfig(undefined)
  }
  // state.json v2 (lib/state.js): per-key merge under a file lock, tombstones for
  // cleared overrides, restore/applied persisted, debounced routing metadata.
  // `enabled` is mirrored locally for synchronous gate reads; every write goes
  // through the store so a peer process cannot lose our keys.
  const stateStore = createStateStore({
    filePath: stateFilePath(),
    lockPath: stateFilePath() ? `${stateFilePath()}.lock` : null,
    log: debugLog,
    // applied/restore change at most once per turn, so no batching is needed;
    // flushing on the next microtask keeps short-lived processes and tests
    // deterministic (no timer can fire after a later host recreates the home).
    debounceMs: 0,
  })
  let enabled = stateStore.state.enabled === true

  // Per-session switch state. `enabled` is the default for sessions with no
  // entry; an explicit override (true/false) wins, a tombstone means "follow the
  // default again".
  const hasSessionOverride = (id) => typeof id === 'string' && id !== '' && stateStore.getSession(id).enabled !== null
  const sessionEnabled = (id) => (hasSessionOverride(id) ? stateStore.getSession(id).enabled === true : enabled)
  const setSessionOverride = (id, value) => {
    if (!id) return undefined
    return stateStore.setSessionEnabled(id, value === null ? null : value === true)
  }

  let llm = null
  try { llm = ctx.llm } catch (e) {
    debugLog(`ctx.llm failed: ${e?.message ?? e}`)
  }
  if (!llm) {
    try { llm = ctx.get?.('llm') } catch (e) { debugLog(`ctx.get('llm') failed: ${e?.message ?? e}`) }
  }

  const low = resolveTargets(cfg).low
  debugLog(`apply: v${VERSION}, enabled=${enabled}, tierRouting=${cfg.tierRouting.enabled ? 'on' : 'off'}, low.valley -> ${fmtSelection(low.valley)}, low.costRouting=${low.costRouting}, low.peak=${low.peak.enabled ? 'on' : 'off'}, advancedSupport -> ${fmtSelection(cfg.advancedSupport)}, llm -> ${!!llm}`)
  debugLog(`host: model-select unknown; default-seam pending; llm ${llm ? 'present' : 'missing'}`)

  // NOTE: no provider adapter is registered here on purpose. 避峰岗 routes by
  // selecting a model before step preparation; it must not appear in the provider
  // registry (that would pollute the session picker and self-loop).

  // ---------- runtime bookkeeping (ephemeral; durable bits live in stateStore) ----------
  //
  // `runtime` keeps only per-session routing metadata that must NOT be persisted:
  // the last decision per turn, the classifier hysteresis verdict and a turn
  // counter for hosts without `turnBoundaryOf`. `restore`/`applied`/
  // `restorePending` moved to lib/state.js (state.json v2).
  const runtime = new Map()
  const MAX_RUNTIME_SESSIONS = 500
  function runtimeFor(sessionId) {
    if (!sessionId) return null
    let entry = runtime.get(sessionId)
    if (!entry) {
      entry = { currentTurn: 0, status: null, decisions: new Map(), lastVerdict: null }
      runtime.set(sessionId, entry)
      while (runtime.size > MAX_RUNTIME_SESSIONS) {
        const oldest = runtime.keys().next()
        if (oldest.done) break
        runtime.delete(oldest.value)
      }
    }
    return entry
  }

  const liveAgents = new Map()
  const hostSeams = { modelSelect: null, defaultSeam: false, defaultSeamMissingLogged: false }
  const defaultSeamLabel = () => (hostSeams.defaultSeam ? 'present' : (hostSeams.defaultSeamMissingLogged ? 'missing' : 'pending'))

  // The default-model layer is only a PREVIEW (§1.8). If the core never resolves
  // `agentDefaultModel` through `internal/get` (measured: 0.2.2-rc.1 reads the
  // service directly), the wrapper is simply never installed in the resolution
  // path — that must be reported, not faked. Routing authority is select().
  function settleDefaultSeam() {
    if (hostSeams.defaultSeam || hostSeams.defaultSeamMissingLogged) return
    hostSeams.defaultSeamMissingLogged = true
    debugLog('host: default-seam missing (agentDefaultModel was not resolved through internal/get before the first user message; routing authority is agent.model.select)')
  }

  // ---------- visible warnings + bounded recent history (t8) ----------
  //
  // Warnings are the user-visible explanation for "why did my model not change?".
  // Two severities, mapped 1:1 to the settings banner:
  //   error (红): the target is KNOWN unavailable (provider/model/effort gone,
  //              select failed). The user must fix the policy.
  //   info  (黄): we could not TELL yet (catalog/effort cache cold, llm missing)
  //              or a compatibility note (legacy v1 strategies). Nothing to fix
  //              immediately; routing stays fail-open (never select, never block).
  //
  // `warnings` holds the ACTIVE set (bounded, deduped per session+kind+target).
  // `warningHistory` is the bounded "recent fallbacks" log (raise + clear events)
  // exposed as get.recentWarnings, so the GUI can show what happened even after
  // an entry auto-cleared.
  const warnings = []
  const warningHistory = []
  const MAX_WARNING_HISTORY = 50
  const ERROR_KINDS = new Set(['provider', 'model', 'effort', 'missing', 'select-failed', 'no-current', 'host-unsupported', 'request-failed'])
  // Kinds that a reachable target cannot "resolve": they are transient/host-level
  // or a compatibility note, so auto-clear must leave them alone.
  const NON_CLEARABLE_KINDS = new Set(['no-current', 'select-failed', 'host-unsupported', 'request-failed', 'legacy-extra-strategies'])
  function pushWarningHistory(warning, event) {
    const entry = {
      at: new Date().toISOString(),
      event,
      sessionId: warning.sessionId,
      turn: warning.turn,
      kind: warning.kind,
      severity: warning.severity,
      reason: warning.reason,
      target: warning.target ? cloneSelection(warning.target) : null,
      kept: warning.kept ? cloneSelection(warning.kept) : null,
      count: warning.count,
    }
    if (Number.isInteger(warning.extraCount)) entry.extraCount = warning.extraCount
    warningHistory.push(entry)
    while (warningHistory.length > MAX_WARNING_HISTORY) warningHistory.shift()
  }
  function recordWarning(kind, {
    sessionId = '',
    turn = 0,
    target = null,
    kept = null,
    detail = '',
    reason = kind,
    extraCount = undefined,
  } = {}) {
    const targetKey = fmtSelection(target)
    const key = `${sessionId}|${kind}|${targetKey}`
    const existing = warnings.find((warning) => warning.key === key)
    if (existing) {
      // Throttle by construction: the same reason for the same session/target
      // increments one counter and does NOT log again (no per-request spam).
      existing.count += 1
      existing.at = new Date().toISOString()
      if (detail) existing.detail = detail
      existing.reason = reason
      if (Number.isInteger(extraCount)) existing.extraCount = extraCount
      return existing
    }
    const warning = {
      key,
      at: new Date().toISOString(),
      sessionId,
      turn,
      kind,
      severity: ERROR_KINDS.has(kind) ? 'error' : 'info',
      reason,
      target: cloneSelection(target),
      kept: cloneSelection(kept),
      detail,
      count: 1,
    }
    if (Number.isInteger(extraCount)) warning.extraCount = extraCount
    warnings.push(warning)
    while (warnings.length > MAX_WARNINGS) warnings.shift()
    pushWarningHistory(warning, 'raised')
    debugLog(`warning: ${kind} reason=${reason} target=${targetKey} kept=${fmtSelection(kept)} (session ${sessionId || '(none)'})`)
    return warning
  }
  function clearWarning(warning, why) {
    const index = warnings.indexOf(warning)
    if (index < 0) return false
    warnings.splice(index, 1)
    pushWarningHistory(warning, 'cleared')
    debugLog(`warning: cleared ${warning.kind} ${fmtSelection(warning.target)} (session ${warning.sessionId || '(none)'}${why ? `; ${why}` : ''})`)
    return true
  }
  function clearResolvedWarnings() {
    for (let i = warnings.length - 1; i >= 0; i -= 1) {
      const warning = warnings[i]
      if (NON_CLEARABLE_KINDS.has(warning.kind)) continue
      if (!warning.target) continue
      const validation = validateTargetSync(warning.target)
      if (validation.ok === true) clearWarning(warning, 'target reachable again')
    }
  }
  const severityRank = (severity) => (severity === 'error' ? 0 : 1)
  // Errors first, then newest first: the settings banner shows entries[0] as its
  // headline and colours the box by the worst severity, so the headline and the
  // colour must agree.
  const sortWarnings = (list) => list.slice().sort((a, b) => (
    (severityRank(a.severity) - severityRank(b.severity))
    || (a.at === b.at ? 0 : (a.at < b.at ? 1 : -1))
  ))
  const publicWarnings = () => sortWarnings(warnings).map(({ key, ...rest }) => rest)
  const publicWarningHistory = () => warningHistory.slice().reverse()

  // v1 compatibility warning (t8 requirement): migrating a policy with more than
  // one strategy makes strategies[1..] inert — they survive only as the read-only
  // legacy snapshot. A log line is not enough: the user must SEE that their old
  // plans stopped routing. Yellow (info), because nothing is broken; it clears on
  // the first successful save (the user acknowledged the new shape).
  const legacyStrategyCount = Array.isArray(cfg?.legacy?.strategies) ? cfg.legacy.strategies.length : 0
  if (migratedFromV1 && legacyStrategyCount > 1) {
    const extraCount = legacyStrategyCount - 1
    recordWarning('legacy-extra-strategies', {
      reason: 'legacy-v1-migration',
      detail: `legacy policy: strategies 2..${legacyStrategyCount} no longer route (kept in the read-only legacy snapshot); migrate them to the three tiers`,
      extraCount,
    })
  }

  // t18: invalid holiday dates are dropped during normalization (a typo must not
  // reset the whole policy), but the drop is visible: one throttled info warning
  // carrying the count. It clears as soon as the loaded/saved config has no
  // invalid date (the GUI decides how to present it).
  function syncInvalidHolidaysWarning(dropped) {
    const count = Number.isInteger(dropped) && dropped > 0 ? dropped : 0
    if (count > 0) {
      recordWarning('invalid-holidays', {
        reason: 'invalid-holidays',
        detail: `${count} holiday date(s) were ignored (not a real calendar day between 1970 and 2100)`,
        extraCount: count,
      })
      return
    }
    const existing = warnings.find((warning) => warning.kind === 'invalid-holidays')
    if (existing) clearWarning(existing, 'all holiday dates are valid')
  }
  syncInvalidHolidaysWarning(droppedHolidaysAtLoad)

  const lastLog = new Map()
  function logThrottled(key, message) {
    const line = typeof message === 'string' ? message : (message instanceof Error ? message.message : String(message))
    if (lastLog.get(key) === line) return
    lastLog.set(key, line)
    debugLog(`${key}: ${line}`)
  }

  let lastDecision = null
  const decisions = []
  function rememberDecision(decision) {
    decisions.push(decision)
    while (decisions.length > MAX_DECISIONS) decisions.shift()
    lastDecision = decision
  }
  function decisionFor(sessionId, turn) {
    if (!sessionId) return null
    const entry = runtime.get(sessionId)
    return entry?.decisions?.get(turn) ?? null
  }
  function rememberTurnDecision(sessionId, turn, decision) {
    const entry = runtimeFor(sessionId)
    if (!entry) return
    entry.decisions.delete(turn)
    entry.decisions.set(turn, decision)
    while (entry.decisions.size > 20) {
      const oldest = entry.decisions.keys().next()
      if (oldest.done) break
      entry.decisions.delete(oldest.value)
    }
  }

  // ---------- model catalog + synchronous target validation (§1.3) ----------
  //
  // The catalog is only ever refreshed in the BACKGROUND; the selection path
  // never awaits listModels(). Unknown/not-warmed data means "do not select"
  // (fail-safe) — never block a turn on missing information.
  const modelCatalog = new Map() // providerId -> { ids: Set<modelId>, at: number }
  const effortCache = new Map() // "provider/model" -> { ok, efforts: Set<string>|null, at }
  let modelCatalogRefreshing = false
  let lastCatalogRefreshAt = 0
  let staleRefreshScheduled = false
  const effortRefreshing = new Set()

  let lastCatalogError = ''
  const catalogProviderIds = () => {
    if (!llm || typeof llm.listProviders !== 'function') return null
    try {
      const listed = llm.listProviders()
      if (!Array.isArray(listed)) return null
      return new Set(listed.map((p) => (typeof p === 'string' ? p : p?.id)).filter((id) => typeof id === 'string' && id))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastCatalogError) {
        lastCatalogError = message
        debugLog(`catalog: listProviders failed: ${message}`)
      }
      return null
    }
  }

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
          modelCatalog.delete(provider.id) // unknown again -> routing is allowed to be tried
          failedCount += 1
        }
      }))
      for (const key of [...modelCatalog.keys()]) if (!seen.has(key)) modelCatalog.delete(key)
      const summary = [...modelCatalog.entries()]
        .map(([provider, entry]) => `${provider}=[${[...entry.ids].join(',')}]`)
        .join(' ')
      debugLog(`model catalog refreshed (${reason}): ${okCount} ok, ${failedCount} failed, ${modelCatalog.size} cached${summary ? `; ${summary}` : ''}`)
      clearResolvedWarnings()
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

  // Reasoning-effort capability, one entry per configured (provider, model).
  // Only configured targets are probed: probing the whole catalog would issue a
  // resolveModel call per model on every refresh.
  const configuredTargets = () => {
    const tiers = resolveTargets(cfg)
    const out = []
    for (const tier of TIERS) {
      out.push(tiers[tier].valley)
      if (tiers[tier].peak?.enabled) out.push(tiers[tier].peak)
    }
    if (cfg.advancedSupport?.provider && cfg.advancedSupport?.model) out.push(cfg.advancedSupport)
    // 0.17: role rule targets are routed too — they must be part of the effort
    // warm-up or a cold effort cache makes the role's first message keep the old
    // model ("effort-cold"), which reads like the role rule did nothing.
    for (const rule of Array.isArray(cfg.roleRules) ? cfg.roleRules : []) {
      if (rule.target) out.push(rule.target)
      if (rule.tiers) for (const tier of TIERS) if (rule.tiers[tier]) out.push(rule.tiers[tier])
    }
    const seen = new Set()
    return out.filter((target) => {
      const key = `${target.provider}/${target.model}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const refreshEffortInfo = async (target, reason) => {
    const key = `${target.provider}/${target.model}`
    if (effortRefreshing.has(key)) return
    if (!llm || typeof llm.resolveModelInfo !== 'function') return
    effortRefreshing.add(key)
    try {
      const info = await withTimeout(Promise.resolve(llm.resolveModelInfo(target.provider, target.model)), MODELS_TIMEOUT_MS)
      const efforts = Array.isArray(info?.reasoning?.efforts)
        ? new Set(info.reasoning.efforts.map((effort) => (typeof effort === 'string' ? effort : effort?.id)).filter((id) => typeof id === 'string' && id))
        : null
      effortCache.set(key, { ok: true, efforts, at: Date.now() })
    } catch (error) {
      effortCache.set(key, { ok: false, efforts: null, at: Date.now() })
      logThrottled(`effort-info:${key}`, `resolveModelInfo(${key}) failed (${reason}): ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      effortRefreshing.delete(key)
    }
  }
  const requestEffortRefresh = (reason) => {
    if (!llm || typeof llm.resolveModelInfo !== 'function') return
    for (const target of configuredTargets()) {
      const cached = effortCache.get(`${target.provider}/${target.model}`)
      // A FAILED probe must be retried (the adapter may simply not have been
      // registered yet when `apply` ran); only fresh successes are skipped.
      if (cached && cached.ok && Date.now() - cached.at < EFFORT_TTL_MS) continue
      refreshEffortInfo(target, reason).catch(() => {})
    }
  }

  // Returns { ok: true } | { ok: false, kind } | { ok: 'unknown', kind }.
  // "unknown" means "we cannot tell yet" and must never select; "ok:false" means
  // "known unavailable" and is shown in red (and may fall back to low.valley).
  function validateTargetSync(target) {
    if (!target?.provider || !target?.model) return { ok: false, kind: 'missing' }
    const providers = catalogProviderIds()
    if (providers === null) return { ok: 'unknown', kind: 'llm-unavailable' }
    if (!providers.has(target.provider)) return { ok: false, kind: 'provider' }
    const entry = modelCatalog.get(target.provider)
    if (!entry || Date.now() - entry.at > MODEL_CATALOG_TTL_MS) {
      // Stale data never blocks; the refresh it triggers is DEFERRED out of this
      // synchronous path (starting listModels here would issue I/O per event).
      if (!staleRefreshScheduled && Date.now() - lastCatalogRefreshAt > MODEL_CATALOG_TTL_MS) {
        staleRefreshScheduled = true
        setTimeout(() => {
          staleRefreshScheduled = false
          requestModelCatalogRefresh('stale')
        }, 0)
      }
      return { ok: 'unknown', kind: 'catalog-cold' }
    }
    if (!entry.ids.has(target.model)) return { ok: false, kind: 'model' }
    if (target.reasoningEffort) {
      const effort = effortCache.get(`${target.provider}/${target.model}`)
      if (!effort || !effort.ok || Date.now() - effort.at > EFFORT_TTL_MS) {
        // Warm it in the background; until then this target is unverified and we
        // do not select it. A target with no explicit effort never hits this.
        refreshEffortInfo(target, 'cold').catch(() => {})
        return { ok: 'unknown', kind: 'effort-cold' }
      }
      if (effort.efforts && !effort.efforts.has(target.reasoningEffort)) return { ok: false, kind: 'effort' }
    }
    return { ok: true }
  }

  // Refresh triggers: startup prewarm, adapter changes, and switching on.
  requestModelCatalogRefresh('apply')
  requestEffortRefresh('apply')
  ctx.on('llm/adapters-updated', () => {
    modelCatalog.clear() // an adapter change invalidates every cached model list
    effortCache.clear()
    requestModelCatalogRefresh('adapters-updated')
    requestEffortRefresh('adapters-updated')
  }, { global: true })

  // ---------- session identity / switch ----------

  function sessionIdOf(agent) {
    return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? null
  }
  const enabledFor = (sessionId) => (sessionId ? sessionEnabled(sessionId) : enabled)

  // Probe the per-agent capability (never trust a process-wide flag: a host can
  // mix agents). Logged once per change so the GUI badge is accurate before the
  // first user message (any live agent is enough to know the core supports it).
  function observeModelSelect(agent) {
    const canSelect = typeof agent?.model?.select === 'function'
    if (hostSeams.modelSelect === canSelect) return canSelect
    hostSeams.modelSelect = canSelect
    debugLog(`host: model-select ${canSelect ? 'present' : 'missing'}; default-seam ${defaultSeamLabel()}; llm ${llm ? 'present' : 'missing'}`)
    return canSelect
  }

  // Lazy: `agents` is optional (0.2.0/0.2.1 have no turnBoundaryOf). A missing
  // service only costs turn numbers, never routing.
  let agentsService
  function getAgentsService() {
    if (agentsService !== undefined) return agentsService
    try { agentsService = ctx.get?.('agents') ?? null } catch { agentsService = null }
    return agentsService
  }

  function safeCurrent(agent) {
    try {
      const current = typeof agent?.model?.current === 'function' ? agent.model.current() : undefined
      return cloneSelection(current)
    } catch (error) {
      logThrottled('current-failed', error)
      return null
    }
  }

  function turnInfo(agent, sessionId) {
    const service = getAgentsService()
    if (service && typeof service.turnBoundaryOf === 'function') {
      try {
        const boundary = service.turnBoundaryOf(agent.session)
        if (boundary && Number.isInteger(boundary.lastTurn)) {
          return { turn: boundary.lastTurn, running: boundary.openTurnStartSeq !== null }
        }
      } catch (error) {
        logThrottled('turn-boundary-failed', error)
      }
    }
    const entry = runtimeFor(sessionId)
    const running = entry?.status !== null && entry?.status !== undefined
      ? entry.status === 'running'
      : agent?.status === 'running'
    return { turn: entry?.currentTurn ?? 0, running }
  }

  // ---------- role binding (0.17) ----------
  //
  // The AgentTeams patch reserves the child session id and emits
  // `agent-teams/member-started { teamId, sessionId, name, role }` BEFORE the
  // member's first prompt is queued, so the role is already in state when the
  // first message — which may BE the task body — reaches `agent/inbox/inserted`.
  // Nothing here guesses from message order or from a prompt/title: a member is
  // routed by its bound role, every other session keeps the normal policy.

  function bindRole(payload, result) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    const role = typeof payload?.role === 'string' ? payload.role.trim() : ''
    const name = typeof payload?.name === 'string' ? payload.name : ''
    const teamId = typeof payload?.teamId === 'string' ? payload.teamId : ''
    if (!sessionId) {
      if (result) { result.ok = false; result.reason = 'missing-session-id' }
      return { ok: false, reason: 'missing-session-id' }
    }
    // The member-started event precedes the spawn, so nothing about this session
    // is pending; a rebound session (cold resume) keeps its role (idempotent).
    if (!role) {
      debugLog(`role: member ${name || sessionId} (team ${teamId || '-'}) has no role -> normal routing`)
      if (result) { result.ok = true; result.reason = 'no-role' }
      return { ok: true, reason: 'no-role' }
    }
    const rule = findRoleRule(cfg, role)
    // A rebound session (cold resume) keeps its role; re-writing it is idempotent.
    if (stateStore.getRole(sessionId) !== role) stateStore.setRole(sessionId, role)
    if (rule?.decouple) restoreSession(sessionId, 'role-bound-decoupled')
    debugLog(`role: bound session=${sessionId} name=${name || '-'} team=${teamId || '-'} role=${role}`
      + ` rule=${rule ? rule.name : '(no matching rule)'}${rule?.decouple ? ' decouple=true' : ''}`)
    if (result) {
      result.ok = true
      result.reason = rule ? 'bound' : 'no-matching-rule'
    }
    return { ok: true, reason: rule ? 'bound' : 'no-matching-rule' }
  }


  // ---------- restore (§1.6) ----------

  function restoreSession(sessionId, reason, { force = false } = {}) {
    const session = sessionId ? stateStore.getSession(sessionId) : null
    if (!session?.restore) return false
    const agent = liveAgents.get(sessionId)
    if (!agent || typeof agent.model?.select !== 'function') {
      if (session.applied) stateStore.setRestorePending(sessionId, true)
      return false
    }
    const current = safeCurrent(agent)
    if (!force) {
      const sameAsApplied = session.applied ? sameSelection(current, session.applied) : false
      const sameAsRestore = sameSelection(current, session.restore)
      // If the user picked something else in the meantime, do not fight them.
      if (!sameAsApplied && !sameAsRestore) {
        debugLog(`restore: skipped (session ${sessionId}; current ${fmtSelection(current)} changed by user)`)
        return false
      }
    }
    try {
      agent.model.select({ ...session.restore })
      stateStore.setApplied(sessionId, null)
      stateStore.setRestorePending(sessionId, false)
      debugLog(`restore: session=${sessionId} -> ${fmtSelection(session.restore)} (reason=${reason})`)
      return true
    } catch (error) {
      logThrottled(`restore-failed:${sessionId}`, `restore failed (session ${sessionId}): ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function restoreAllLive(reason) {
    for (const [sessionId, applied] of stateStore.state.applied) {
      if (!applied) continue
      restoreSession(sessionId, reason)
    }
  }

  function maybeRestorePending(agent) {
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    const session = stateStore.getSession(sessionId)
    if (!session.restorePending) return
    if (enabledFor(sessionId)) {
      stateStore.setRestorePending(sessionId, false)
      return
    }
    if (restoreSession(sessionId, 'pending')) debugLog(`restore: pending cleared (session ${sessionId})`)
  }

  // ---------- the routing write path (§1.4) ----------

  function baselineFor(agent, sessionId) {
    const current = safeCurrent(agent)
    if (!current) return null
    // The sentinel key (host had no readable session id) has no durable record.
    if (!sessionId || sessionId === '(no-session)') return current
    const session = stateStore.getSession(sessionId)
    if (!session.restore) {
      stateStore.setRestore(sessionId, current)
      debugLog(`baseline: session=${sessionId} -> ${fmtSelection(current)}`)
      return current
    }
    const sameAsApplied = session.applied ? sameSelection(current, session.applied) : false
    const sameAsRestore = sameSelection(current, session.restore)
    // Attribution gap: model/selection events carry no author. If current is
    // neither what we last selected nor the recorded baseline, a human (or
    // another plugin) chose it — adopt it and never fight the user.
    if (!sameAsApplied && !sameAsRestore) {
      stateStore.setRestore(sessionId, current)
      stateStore.setApplied(sessionId, null)
      debugLog(`external-selection: session=${sessionId} -> ${fmtSelection(current)}`)
    }
    return { ...session.restore }
  }

  function selectTarget(agent, decision, target, { fallback = null } = {}) {
    const sessionId = decision.sessionId ?? ''
    const current = safeCurrent(agent)
    const changed = !sameSelection(current, target)
    try {
      agent.model.select({
        provider: target.provider,
        model: target.model,
        ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
      })
    } catch (error) {
      decision.applied = false
      decision.outcome = 'select-failed'
      decision.warningKind = 'select-failed'
      recordWarning('select-failed', { sessionId, turn: decision.turn, target, kept: current, reason: 'select-error', detail: error instanceof Error ? error.message : String(error) })
      logThrottled(`select-failed:${sessionId}`, `inbox: select failed: ${error instanceof Error ? error.message : String(error)} (session ${sessionId} target ${fmtSelection(target)})`)
      // t6 contract: a failed select falls back to low; the max axis never does
      // (silently degrading a max request would trade correctness for cost).
      if (decision.axis === 'tier' && decision.tier !== 'low') {
        const lowValley = fallbackSelection(cfg, decision)
        const lowValidation = lowValley ? validateTargetSync(lowValley) : { ok: false, kind: 'missing' }
        if (lowValidation.ok === true && !sameSelection(lowValley, target)) {
          try {
            agent.model.select({
              provider: lowValley.provider,
              model: lowValley.model,
              ...(lowValley.reasoningEffort === undefined ? {} : { reasoningEffort: lowValley.reasoningEffort }),
            })
            decision.applied = true
            decision.appliedTarget = { ...lowValley }
            decision.changed = !sameSelection(current, lowValley)
            decision.outcome = decision.changed ? 'selected' : 'noop-same'
            decision.fallback = 'low'
            if (sessionId) {
              const session = stateStore.getSession(sessionId)
              if (!session.restore && current) stateStore.setRestore(sessionId, current)
              stateStore.setApplied(sessionId, lowValley)
            }
            logThrottled(`select-fallback:${sessionId}`, `inbox: select failed -> falling back to low.valley ${fmtSelection(lowValley)} (session ${sessionId} turn ${decision.turn})`)
            clearResolvedWarnings()
          } catch (fallbackError) {
            logThrottled(`select-fallback-failed:${sessionId}`, `inbox: low fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)} (session ${sessionId})`)
          }
        }
      }
      return
    }
    decision.applied = true
    decision.appliedTarget = { ...target }
    decision.changed = changed
    decision.outcome = changed ? 'selected' : 'noop-same'
    if (fallback) decision.fallback = fallback
    if (sessionId) {
      const session = stateStore.getSession(sessionId)
      if (!session.restore && current) stateStore.setRestore(sessionId, current)
      stateStore.setApplied(sessionId, target)
    }
    debugLog(changed
      ? `inbox: select -> ${fmtSelection(target)} (session ${sessionId} turn ${decision.turn}; was ${fmtSelection(current)}${fallback ? `; fallback=${fallback}` : ''})`
      : `inbox: no-op-same -> ${fmtSelection(target)} (session ${sessionId} turn ${decision.turn})`)
    clearResolvedWarnings()
  }

  function applyDecision(agent, decision) {
    const sessionId = decision.sessionId ?? ''
    const current = safeCurrent(agent)
    if (!current) {
      decision.outcome = 'unroutable'
      decision.warningKind = 'no-current'
      recordWarning('no-current', { sessionId, turn: decision.turn, target: decision.target, reason: 'no-model-selection' })
      debugLog(`inbox: no-current -> keeping session model (session ${sessionId})`)
      return
    }
    const target = decision.target
    if (!target?.provider || !target?.model) {
      decision.outcome = 'unroutable'
      decision.warningKind = 'missing'
      recordWarning('missing', { sessionId, turn: decision.turn, target, kept: current, reason: 'missing-target', detail: 'the routed target has no provider/model' })
      debugLog(`inbox: unroutable kind=missing target=- -> keeping ${fmtSelection(current)} (session ${sessionId})`)
      return
    }
    const validation = validateTargetSync(target)
    if (validation.ok === true) {
      selectTarget(agent, decision, target)
      return
    }
    if (validation.ok === 'unknown') {
      const kind = validation.kind
      decision.outcome = 'unroutable'
      decision.warningKind = kind === 'llm-unavailable' ? 'llm-unavailable' : 'unverified'
      recordWarning(decision.warningKind, { sessionId, turn: decision.turn, target, kept: current, reason: kind, detail: `catalog/capability not ready (${kind}); target not selected` })
      debugLog(`inbox: unverified kind=${kind} target=${fmtSelection(target)} -> keeping ${fmtSelection(current)} (session ${sessionId})`)
      return
    }
    // Known-unavailable. The ONLY allowed diversion: a high/mid target that is
    // truly gone falls back to low.valley (still cheap and runnable), with the
    // red warning preserved. low itself and the max axis keep current — silently
    // degrading a max request to low would trade correctness for cost.
    if (decision.axis === 'tier' && decision.tier !== 'low') {
      const lowValley = fallbackSelection(cfg, decision)
      const lowValidation = lowValley ? validateTargetSync(lowValley) : { ok: false, kind: 'missing' }
      if (lowValidation.ok === true) {
        recordWarning(validation.kind, {
          sessionId,
          turn: decision.turn,
          target,
          kept: lowValley,
          reason: validation.kind,
          detail: `target unavailable (${validation.kind}); fell back to low.valley`,
        })
        debugLog(`inbox: unroutable kind=${validation.kind} target=${fmtSelection(target)} -> falling back to low.valley ${fmtSelection(lowValley)} (session ${sessionId})`)
        selectTarget(agent, decision, lowValley, { fallback: 'low' })
        return
      }
    }
    decision.outcome = 'unroutable'
    decision.warningKind = validation.kind
    recordWarning(validation.kind, {
      sessionId,
      turn: decision.turn,
      target,
      kept: current,
      reason: validation.kind,
      detail: `target unavailable (${validation.kind}); current model kept`,
    })
    debugLog(`inbox: unroutable kind=${validation.kind} target=${fmtSelection(target)} -> keeping ${fmtSelection(current)} (session ${sessionId})`)
  }

  // ---------- tier classification (§4) ----------

  // A classifier verdict for one turn. `tierRouting.enabled=false` never computes
  // (always low, §4.7). Verdicts are remembered per session so the NEXT turn can
  // apply adjacency hysteresis; a same-turn re-decision (pre-turn batch merge)
  // deliberately ignores it.
  function classifyFor(key, messages, { via, turn }) {
    if (!cfg.tierRouting.enabled) {
      return { tier: 'low', tierReason: 'tier-disabled', score: null, reasons: [], features: [], hysteresis: false }
    }
    const entry = runtimeFor(key)
    const previous = entry?.lastVerdict && entry.lastVerdict.turn < turn ? entry.lastVerdict : null
    let verdict
    try {
      verdict = classify(collectFromMessages(messages), {
        concreteThreshold: cfg.tierRouting.concreteThreshold,
        mediumThreshold: cfg.tierRouting.mediumThreshold,
        midTurn: via === 'steer-adopt',
        previous,
        now: Date.now(),
      })
    } catch (error) {
      // A classifier bug must never break a turn: fall back to low (§4.3).
      logThrottled('classify-failed', `classify failed (session ${key}): ${error instanceof Error ? error.message : String(error)}`)
      verdict = { tier: 'low', tierReason: 'tier-fallback-low', score: null, reasons: [], features: [], hysteresis: false }
    }
    if (entry) entry.lastVerdict = { tier: verdict.tier, score: verdict.score, at: Date.now(), turn }
    if (verdict.hysteresis) {
      debugLog(`tier-hysteresis: session=${key} keep tier=${verdict.tier} (score=${verdict.score}, thresholds ${cfg.tierRouting.mediumThreshold}/${cfg.tierRouting.concreteThreshold})`)
    }
    return verdict
  }

  function decideAndSelect(agent, { turn, via, messages = [] }) {
    const sessionId = sessionIdOf(agent)
    // No readable id: keep routing on the GLOBAL default instead of silently
    // doing nothing (0.14 behavior). Bookkeeping then uses a sentinel key so the
    // per-turn freeze still works within this process.
    const key = sessionId || '(no-session)'
    // 0.17 role rules: a session explicitly assigned a role leaves the tier/peak
    // table. `decouple` means the router must not touch this session at all — that
    // is the AgentTeams member contract (the team owns the member's model route),
    // so we return BEFORE classifying and before any select().
    const role = sessionId ? stateStore.getRole(sessionId) : null
    const rule = role ? findRoleRule(cfg, role) : null
    if (rule?.decouple) {
      debugLog(`inbox: role=${rule.name} session=${sessionId} -> decoupled (routing skipped, via=${via})`)
      return
    }
    const verdict = classifyFor(key, messages, { via, turn })
    let decision
    // 0.17 role targeting, in precedence order:
    //   tiers[tier] → this role's model for the classified tier (unlisted tiers
    //                 keep the shipped tier/peak table, e.g. verifier-low stays on
    //                 the peak-valley policy);
    //   target      → one fixed model for every tier (the implementer).
    let roleReason = null
    try {
      if (rule?.tiers?.[verdict.tier]) {
        roleReason = `role-tier:${rule.name}:${verdict.tier}`
        decision = { axis: 'role', tier: verdict.tier, target: { ...rule.tiers[verdict.tier] }, tierReason: roleReason, costReason: null }
      } else if (rule?.target) {
        roleReason = `role-fixed:${rule.name}`
        decision = { axis: 'role', tier: verdict.tier, target: { ...rule.target }, tierReason: roleReason, costReason: null }
      } else {
        decision = decide(new Date(), cfg, { tier: verdict.tier, tierReason: verdict.tierReason, baseline: baselineFor(agent, key) })
      }
    } catch (error) {
      // A classifier/config failure must never break a turn: fall back to low.
      logThrottled('decide-failed', `decide failed (session ${sessionId ?? '(none)'}): ${error instanceof Error ? error.message : String(error)}`)
      try {
        decision = decide(new Date(), cfg, { tier: 'low', tierReason: 'tier-fallback-low', baseline: null })
      } catch {
        return
      }
    }
    const full = {
      at: new Date().toISOString(),
      sessionId: sessionId ?? null,
      turn,
      axis: decision.axis,
      tier: decision.tier,
      score: verdict.score,
      reasons: verdict.reasons,
      features: verdict.features,
      hysteresis: verdict.hysteresis === true,
      tierReason: decision.tierReason,
      costReason: decision.costReason,
      target: decision.target,
      appliedTarget: null,
      applied: false,
      changed: false,
      outcome: 'disabled',
      fallback: null,
      warningKind: null,
      via,
    }
    rememberTurnDecision(key, turn, full)
    rememberDecision(full)
    debugLog(`inbox: decision session=${sessionId ?? '(none)'} turn=${turn} tier=${full.tier} score=${full.score ?? '-'} target=${fmtSelection(full.target)} axis=${full.axis} tierReason=${full.tierReason} costReason=${full.costReason ?? '-'} fallback=- via=${via}`)
    applyDecision(agent, full)
    // The decision object recorded before the select is the same reference the
    // log/GUI read, so `outcome`/`applied` stay consistent after the write.
  }

  // ---------- inbox seam (§1.2) ----------

  // A message is routable only when its source kind expresses intent. Unknown
  // kinds are skipped exactly like context (never routed) but logged once per
  // kind so a future delivery path is discoverable instead of silently ignored.
  function isIntentMessage(message) {
    const kind = message?.source?.kind
    if (typeof kind !== 'string' || kind === '') return false
    if (INTENT_SOURCE_KINDS.has(kind)) return true
    if (!NON_INTENT_SOURCE_KINDS.has(kind)) {
      logThrottled(`source-kind:${kind}`, `inbox: skipped message with unknown source.kind "${kind}" (if it carries user intent, add it to INTENT_SOURCE_KINDS)`)
    }
    return false
  }

  function intentMessages(list) {
    if (!Array.isArray(list)) return []
    return list.filter((message) => isIntentMessage(message))
  }

  function locatePending(agent, messageId) {
    const inbox = agent?.inbox
    if (!inbox || messageId === undefined) return null
    if (Array.isArray(inbox.nextStep) && inbox.nextStep.some((message) => message?.id === messageId)) return 'next-step'
    if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.some((message) => message?.id === messageId)) return 'next-turn'
    return null
  }

  function onInboxInserted(agent, message) {
    const sessionId = sessionIdOf(agent)
    if (sessionId) liveAgents.set(sessionId, agent)
    maybeRestorePending(agent)
    if (!enabledFor(sessionId)) return
    if (message?.source?.kind === undefined) return
    if (!isIntentMessage(message)) return
    settleDefaultSeam()
    const key = sessionId || '(no-session)'
    const location = locatePending(agent, message.id) ?? 'next-turn'
    const info = turnInfo(agent, key)
    const canSelect = observeModelSelect(agent)
    if (!canSelect) {
      recordWarning('host-unsupported', { sessionId: sessionId ?? '', target: null, kept: safeCurrent(agent), reason: 'core-without-agent-model-select' })
      return
    }
    if (location === 'next-step') {
      const turn = Math.max(1, info.turn)
      // Mid-turn steer: the turn already has a decision -> freeze (never re-tier
      // mid-turn). No decision (plugin loaded late / missed the start) -> adopt.
      if (decisionFor(key, turn)) return
      decideAndSelect(agent, { turn, via: 'steer-adopt', messages: intentMessages(agent.inbox?.nextStep) })
      return
    }
    // A queued next-turn message while a turn is running must NOT select now: the
    // current turn's remaining steps would inherit the next turn's target. The
    // turn-stopping seam handles it (§1.2).
    if (info.running) return
    decideAndSelect(agent, { turn: info.turn + 1, via: 'inbox', messages: intentMessages(agent.inbox?.nextTurn) })
  }

  ctx.on('agent/inbox/inserted', (payload) => {
    const agent = payload?.agent
    const message = payload?.message
    if (!agent || !message) return    // MUST stay synchronous: the harness emits this from inbox.splice BEFORE
    // wakeDriver(), and preStep() reads model.current() synchronously. Any
    // promise/timer deferral here makes the first message of every turn miss.
    try {
      onInboxInserted(agent, message)
    } catch (error) {
      logThrottled('inbox-failed', error)
    }
  }, { global: true })

  ctx.on('agent/turn-stopping', async (payload) => {
    const agent = payload?.agent
    if (!agent) return
    try {
      const sessionId = sessionIdOf(agent)
      if (sessionId) liveAgents.set(sessionId, agent)
      maybeRestorePending(agent)
      if (!enabledFor(sessionId) || typeof agent.model?.select !== 'function') return
      // Another listener may keep this turn open by steering; never spend the
      // decision on the current turn in that case.
      if (Array.isArray(agent.inbox?.nextStep) && agent.inbox.nextStep.length > 0) return
      const pending = intentMessages(agent.inbox?.nextTurn)
      if (pending.length === 0) return
      const info = turnInfo(agent, sessionId || '(no-session)')
      const turn = (Number.isInteger(payload?.turn) ? payload.turn : info.turn) + 1
      decideAndSelect(agent, { turn, via: 'turn-stopping', messages: pending })
    } catch (error) {
      logThrottled('turn-stopping-failed', error)
    }
  }, { global: true })

  // A child session appeared (sync). Diagnostics only: the role is bound by
  // `agent-teams/member-started`, which precedes the spawn, so no routing
  // decision depends on this event.
  ctx.on('subagent/start', (payload) => {
    try {
      const childId = payload?.id
      const parentId = payload?.parentSessionId
      if (typeof childId === 'string' && childId && typeof parentId === 'string' && parentId) {
        debugLog(`role: child session=${childId} spawned by ${parentId}`)
      }
    } catch (error) {
      logThrottled('subagent-start-failed', error)
    }
  }, { global: true })

  // The AgentTeams patch emits this right after it learns the childId. `result` is
  // the emitter's mutable ack: filling it is how binding failure stays visible to
  // the captain instead of failing silently. Listeners run synchronously, so the
  // ack is complete by the time the emit returns.
  ctx.on('agent-teams/member-started', (payload, result) => {
    try {
      bindRole(payload, result)
    } catch (error) {
      if (result) { result.ok = false; result.reason = `router-error: ${error instanceof Error ? error.message : String(error)}` }
      logThrottled('role-bind-failed', error)
    }
  }, { global: true })

  // ---------- read-only observation (§1.7) ----------

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      const expected = sessionId && Number.isInteger(payload?.turn) ? decisionFor(sessionId, payload.turn) : null
      const actual = cloneSelection(payload?.modelSelection)
      // `expected` is what we ACTUALLY applied; a decision that was not selected
      // (unroutable/select-failed) must not report a mismatch as if select ran.
      const appliedTarget = expected && expected.applied ? (expected.appliedTarget ?? expected.target) : null
      debugLog(`pre-step: session=${sessionId ?? '(none)'} turn=${payload?.turn ?? '-'} step=${payload?.step ?? '-'} modelSelection=${fmtSelection(actual)} expected=${appliedTarget ? fmtSelection(appliedTarget) : '-'} match=${appliedTarget ? String(sameSelection(actual, appliedTarget)) : '-'}`)
    } catch {}
    return decision
  }, { global: true })

  // `agent/request` is OBSERVATION ONLY. Any rewrite here is rejected by core
  // 0.2.2-rc.1 after step preparation (see the header), so the returned config is
  // passed through untouched. This also records the model that actually became
  // effective, which is the only proof that the select seam worked.
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      const sessionId = sessionIdOf(payload?.agent)
      if (config && typeof config === 'object') {
        logThrottled(`request:${sessionId}`, `request: observed session=${sessionId ?? '(none)'} config=${fmtSelection(config)}`)
      }
    } catch {}
    return config
  }, { global: true })

  ctx.on('agent/status', (payload) => {
    const agent = payload?.agent
    const status = payload?.status
    if (!agent) return
    observeModelSelect(agent)
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    const entry = runtimeFor(sessionId)
    if (!entry) return
    liveAgents.set(sessionId, agent)
    if (status === 'running' && entry.status !== 'running') entry.currentTurn += 1
    entry.status = typeof status === 'string' ? status : null
  }, { global: true })

  ctx.on('agent/disposed', (payload) => {
    const sessionId = sessionIdOf(payload?.agent)
    if (sessionId) liveAgents.delete(sessionId)
  }, { global: true })

  // ---------- internal/get default-model layer (§1.8, kept but not authoritative) ----------

  ctx.on('internal/get', (child, name, error, next) => {
    if (name !== 'agentDefaultModel') return next()
    const base = next()
    if (!hostSeams.defaultSeam) {
      hostSeams.defaultSeam = true
      debugLog(`host: model-select ${hostSeams.modelSelect === null ? 'unknown' : (hostSeams.modelSelect ? 'present' : 'missing')}; default-seam present; llm ${llm ? 'present' : 'missing'}`)
    }
    // Gate 1: switch off (or no base service) -> untouched pass-through, exactly
    // as if this plugin were not installed.
    if (!enabled || !base || typeof base !== 'object') return base
    const baseSelection = () => (typeof base.currentSelection === 'function' ? base.currentSelection() : null)
    const wrapper = Object.create(base)
    wrapper.currentSelection = () => {
      // Gate 2: re-checked per call, so turning the switch off takes effect
      // immediately and a long-lived fiber stops being routed.
      if (!enabled) return baseSelection()
      const previous = baseSelection()
      // An explicit max default is the user's max axis: never flatten it to the
      // time plan, or max would never reach the first message as the baseline.
      if (previous && previous.reasoningEffort === 'max') return previous
      let decision
      try {
        decision = decide(new Date(), cfg, { tier: 'low' })
      } catch {
        return previous
      }
      const target = cloneSelection(decision.target)
      if (!target) return previous
      const validation = validateTargetSync(target)
      if (validation.ok !== true) {
        // Fail-open: the default layer is only a preview; the authoritative path
        // is select() on the first user message.
        recordWarning(validation.ok === 'unknown' ? 'unverified' : validation.kind, {
          target,
          kept: cloneSelection(previous),
          reason: validation.kind,
          detail: `default-seam:${validation.kind}`,
        })
        return previous
      }
      return target
    }
    return wrapper
  }, { global: true })

  // ---------- GUI: the decision in force right now ----------

  const activeDecision = () => {
    let decision
    try {
      // No text: when tier routing is on this resolves to the documented
      // "no text -> low" fallback (tier-fallback-low), never a guessed tier.
      decision = decide(new Date(), cfg)
    } catch (error) {
      debugLog(`active decision failed: ${error instanceof Error ? error.message : String(error)}`)
      return { provider: '', model: '', reasoningEffort: '', reason: 'none', weekday: null, holiday: false, strategyIndex: null, advancedForMax: '', axis: 'tier', tier: 'low', tierReason: 'tier-fallback-low', costReason: null, target: null, fallback: null }
    }
    const target = decision.target ?? {}
    return {
      // 0.15-compatible flat fields (older client / older settings line)
      provider: target.provider ?? '',
      model: target.model ?? '',
      reasoningEffort: target.reasoningEffort ?? '',
      reason: decision.reason,
      weekday: decision.weekday,
      holiday: decision.holiday,
      strategyIndex: null,
      advancedForMax: fmtSelection(decision.advancedForMax) === '-' ? '' : fmtSelection(decision.advancedForMax),
      // v2 fields
      axis: decision.axis,
      tier: decision.tier,
      tierReason: decision.tierReason,
      costReason: decision.costReason,
      target: target.provider ? target : null,
      fallback: null,
    }
  }

  // ---------- cross-window / multi-process sync (§6.3) ----------

  // Reload policy.json after an external write. A malformed file keeps the
  // current cfg (it must never reset a running policy to DEFAULTS) and logs.
  async function reloadPolicyFromDisk(reason) {
    const path = policyFilePath()
    if (!path) return false
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return false
    }
    if (lastPolicyHash && contentHash(raw) === lastPolicyHash) return false // our own write
    try {
      const detailed = normalizeConfigDetailed(JSON.parse(raw))
      cfg = detailed.config
      lastPolicyHash = contentHash(raw)
      syncInvalidHolidaysWarning(detailed.droppedHolidays)
      debugLog(`policy: reloaded from disk (${reason}), revision ${cfg.revision}`)
      requestModelCatalogRefresh('policy-reload')
      requestEffortRefresh('policy-reload')
      return true
    } catch (error) {
      debugLog(`policy: reload failed (${reason}), keeping current cfg: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  const stopWatching = watchStateFiles(pluginDir(), ['state.json', 'policy.json'], (files) => {
    try {
      if (files.includes('state.json')) {
        stateStore.reloadFromDisk('watch')
          .then(() => { enabled = stateStore.state.enabled === true })
          .catch((error) => debugLog(`state: watch reload failed: ${error instanceof Error ? error.message : String(error)}`))
      }
      if (files.includes('policy.json')) {
        reloadPolicyFromDisk('watch').catch((error) => debugLog(`policy: watch reload failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    } catch (error) {
      debugLog(`watch: handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { debounceMs: 250, log: debugLog })
  ctx.effect(() => () => {
    try { stopWatching() } catch {}
  }, 'dsh-peak-valley-router: stop file watch')

  // ---------- RPC ----------

  ctx.inject(['connection'], (connCtx) => {
    const connection = connCtx.get('connection')
    if (!connection || typeof connection.fetch?.register !== 'function') return
    const register = connection.fetch.register

    const sessionDetails = () => {
      const out = {}
      for (const id of stateStore.sessionIds()) {
        const session = stateStore.getSession(id)
        if (!session.restore && !session.applied && !session.restorePending) continue
        out[id] = {
          enabled: sessionEnabled(id),
          restore: session.restore ? cloneSelection(session.restore) : null,
          applied: session.applied ? cloneSelection(session.applied) : null,
          restorePending: session.restorePending === true,
        }
      }
      return out
    }

    const handlers = {
      // { config, effective, enabled, sessions, sessionDetails, version, host, ... }
      get: async () => ({
        ok: true,
        value: {
          config: cfg,
          effective: resolveTargets(cfg),
          configRevision: cfg.revision ?? 1,
          stateRevision: stateStore.state.revision,
          firstRun,
          enabled,
          sessions: stateStore.sessionsJson(),
          // 0.17: session -> role name. The role's effect comes from
          // config.roleRules (already inside `config`).
          roles: stateStore.rolesJson(),
          sessionDetails: sessionDetails(),
          version: VERSION,
          host: {
            modelSelect: hostSeams.modelSelect === true,
            defaultSeam: hostSeams.defaultSeam,
            llm: Boolean(llm),
          },
          active: activeDecision(),
          lastDecision,
          warnings: publicWarnings(),
          // Bounded history (raise/clear) so the GUI can explain what happened
          // after an auto-cleared entry: session/target/kind/reason/at.
          recentWarnings: publicWarningHistory(),
          recentDecisions: decisions.slice(-20),
        },
      }),

      // Validate + persist the policy, then echo the normalized config. The
      // server owns `revision` (monotonic); `expectedRevision` is accepted but
      // conflict rejection is t9's contract, so an old client keeps working.
      set: async (payload) => {
        if (!payload || typeof payload.config !== 'object' || payload.config === null) {
          return { ok: false, error: { code: 'bad-request', message: 'set: a config object is required', details: { issues: [] } } }
        }
        let next
        let droppedHolidays = 0
        try {
          const detailed = normalizeConfigDetailed(payload.config)
          next = detailed.config
          droppedHolidays = detailed.droppedHolidays
        } catch (error) {
          // Log the rejection too: without it a GUI save failure is invisible in
          // debug.log.
          debugLog(`set rejected: ${error instanceof Error ? error.message : String(error)}`)
          return {
            ok: false,
            error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error), details: { issues: [] } },
          }
        }
        // Optimistic concurrency: the GUI sends the revision it rendered. A
        // mismatch means another window/process saved first — return
        // `stale-revision` with the fresh config so the client can offer
        // "reload / overwrite" instead of silently losing a draft (t7 UI).
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== null && payload.expectedRevision !== cfg.revision) {
          debugLog(`set: stale revision (client ${String(payload.expectedRevision)} != current ${String(cfg.revision)})`)
          return {
            ok: false,
            error: {
              code: 'stale-revision',
              message: `configuration changed in another window (revision ${String(cfg.revision)})`,
              details: { revision: cfg.revision, config: cfg },
            },
          }
        }
        const revision = (Number.isInteger(cfg.revision) ? cfg.revision : 1) + 1
        next = { ...next, revision }
        lastPolicyHash = await savePolicyFile(next)
        // The file now exists on disk: the onboarding note must disappear on the
        // next poll. Only a successful write reaches this line.
        firstRun = false
        cfg = next
        // Saving in the v2 shape acknowledges the migration: the compatibility
        // warning about inert legacy strategies is dismissed here (the legacy
        // snapshot itself is kept read-only for the user's records).
        const legacyWarning = warnings.find((warning) => warning.kind === 'legacy-extra-strategies')
        if (legacyWarning) clearWarning(legacyWarning, 'acknowledged by save')
        debugLog(`set: revision ${cfg.revision}, tierRouting=${cfg.tierRouting.enabled ? 'on' : 'off'}, low.valley -> ${fmtSelection(resolveTargets(cfg).low.valley)}`)
        requestModelCatalogRefresh('set')
        requestEffortRefresh('set')
        clearResolvedWarnings()
        syncInvalidHolidaysWarning(droppedHolidays)
        return { ok: true, value: { config: cfg, effective: resolveTargets(cfg), configRevision: cfg.revision, stateRevision: stateStore.state.revision } }
      },

      // Every registered provider (API keys and subscriptions alike), minus
      // this plugin itself. Unavailable/failed -> empty list, never an error.
      providers: async (payload) => {
        if (!llm || typeof llm.listProviders !== 'function') {
          debugLog('providers: llm unavailable -> []')
          return { ok: true, value: { providers: [] } }
        }
        let listed
        try {
          listed = llm.listProviders()
        } catch (error) {
          debugLog(`providers: listProviders error -> []: ${error instanceof Error ? error.message : String(error)}`)
          if (payload?.strict) return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
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
          if (payload?.strict) return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
          return { ok: true, value: [] }
        }
      },

      // Persist the switch. Without `sessionId` this is the session DEFAULT;
      // with it, the call sets that one session's override, and `inherit: true`
      // clears the override so the session follows the default again. Turning a
      // scope OFF restores the pre-plugin model for the live agents it routed.
      toggle: async (payload) => {
        const rawSessionId = payload?.sessionId
        if (rawSessionId !== undefined && rawSessionId !== null && !(typeof rawSessionId === 'string' && rawSessionId)) {
          debugLog(`toggle rejected: sessionId must be a non-empty string when present (got ${typeof rawSessionId})`)
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'toggle: sessionId must be a non-empty string when present',
              details: { issues: [] },
            },
          }
        }
        const sessionId = typeof rawSessionId === 'string' && rawSessionId ? rawSessionId : null
        if (sessionId) {
          if (payload?.inherit === true) {
            await setSessionOverride(sessionId, null)
            debugLog(`toggle: session ${sessionId} -> follow default (${enabled})`)
          } else {
            const next = payload?.enabled === undefined ? !sessionEnabled(sessionId) : Boolean(payload.enabled)
            await setSessionOverride(sessionId, next)
            debugLog(`toggle: session ${sessionId} -> ${next}`)
          }
          const effective = sessionEnabled(sessionId)
          if (effective) {
            requestModelCatalogRefresh('toggle')
            requestEffortRefresh('toggle')
          } else {
            restoreSession(sessionId, payload?.inherit === true ? 'inherit' : 'toggle-off')
            await stateStore.flushNow()
          }
          return {
            ok: true,
            value: { enabled, sessions: stateStore.sessionsJson(), sessionId, sessionEnabled: effective, stateRevision: stateStore.state.revision },
          }
        }
        const next = payload?.enabled === undefined ? !enabled : Boolean(payload.enabled)
        enabled = next
        await stateStore.setEnabled(next)
        enabled = stateStore.state.enabled === true
        if (enabled) {
          requestModelCatalogRefresh('toggle')
          requestEffortRefresh('toggle')
        } else {
          restoreAllLive('toggle-off')
          // Sessions without a live agent get restored the next time they appear.
          for (const [id, applied] of stateStore.state.applied) if (applied) stateStore.setRestorePending(id, true)
          await stateStore.flushNow()
        }
        debugLog(`toggle: enabled -> ${enabled}`)
        return { ok: true, value: { enabled, sessions: stateStore.sessionsJson(), stateRevision: stateStore.state.revision } }
      },

      // 0.17: assign (or clear) the role of a session. `role: null` clears it.
      // The role itself only names a policy `roleRules` entry; assigning a role
      // that no rule matches is accepted (the session then stays on normal
      // routing) so a role can be recorded before its rule exists.
      setRole: async (payload) => {
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
        if (!sessionId) {
          return { ok: false, error: { code: 'bad-request', message: 'setRole: sessionId must be a non-empty string', details: { issues: [] } } }
        }
        const rawRole = payload?.role
        const role = typeof rawRole === 'string' && rawRole.trim() ? rawRole.trim() : null
        await stateStore.setRole(sessionId, role)
        debugLog(`role: session ${sessionId} -> ${role ?? '(cleared)'}`)
        const rule = role ? findRoleRule(cfg, role) : null
        // Decoupling after the router already selected for this session must give
        // the model back, not leave the session on a routed target.
        if (rule?.decouple) {
          restoreSession(sessionId, 'role-decoupled')
          await stateStore.flushNow()
        }
        return {
          ok: true,
          value: {
            sessionId,
            role,
            roles: stateStore.rolesJson(),
            matched: rule ? { name: rule.name, decouple: rule.decouple === true, target: rule.target ?? null } : null,
            stateRevision: stateStore.state.revision,
          },
        }
      },

      // Put one session back on the model it had before the plugin stepped in.
      // A user-requested restore is explicit, so it wins even if the current
      // selection was changed by hand.
      restore: async (payload) => {
        const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : ''
        if (!sessionId) {
          return { ok: false, error: { code: 'bad-request', message: 'restore: sessionId must be a non-empty string', details: { issues: [] } } }
        }
        const session = stateStore.getSession(sessionId)
        const target = session.restore ? cloneSelection(session.restore) : null
        const restored = restoreSession(sessionId, 'manual', { force: true })
        await stateStore.flushNow()
        const agent = liveAgents.get(sessionId)
        return {
          ok: true,
          value: { restored, current: agent ? safeCurrent(agent) : null, target, stateRevision: stateStore.state.revision },
        }
      },

      // Pure trial run for the settings page ("样例试算"): classify a pasted
      // prompt and show the target it WOULD get. It never selects, never writes,
      // never records a decision/warning — the GUI polls `get` for state, so a
      // probe that mutated anything would make the page flicker.
      probe: async (payload) => {
        if (payload !== undefined && payload !== null && typeof payload !== 'object') {
          return { ok: false, error: { code: 'bad-request', message: 'probe: payload must be an object', details: { issues: [] } } }
        }
        const rawText = payload?.text
        if (rawText !== undefined && typeof rawText !== 'string') {
          return { ok: false, error: { code: 'bad-request', message: 'probe: text must be a string when present', details: { issues: [] } } }
        }
        const text = typeof rawText === 'string' ? rawText : ''
        const rawTier = payload?.tier
        if (rawTier !== undefined && rawTier !== null && !TIERS.includes(rawTier)) {
          return { ok: false, error: { code: 'bad-request', message: 'probe: tier must be one of low|mid|high', details: { issues: [] } } }
        }
        let probeCfg = cfg
        if (payload?.config !== undefined && payload.config !== null) {
          try {
            probeCfg = normalizeConfig(payload.config)
          } catch (error) {
            return { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error), details: { issues: [] } } }
          }
        }
        let at = new Date()
        if (payload?.at !== undefined && payload.at !== null) {
          const parsed = new Date(payload.at)
          if (Number.isNaN(parsed.getTime())) {
            return { ok: false, error: { code: 'bad-request', message: 'probe: at must be an ISO timestamp', details: { issues: [] } } }
          }
          at = parsed
        }
        let verdict
        try {
          verdict = classify(text, {
            concreteThreshold: probeCfg.tierRouting.concreteThreshold,
            mediumThreshold: probeCfg.tierRouting.mediumThreshold,
            hasImage: payload?.hasImage === true,
          })
        } catch (error) {
          // Never fake a tier: report the failure so the GUI can say "试算失败".
          return { ok: false, error: { code: 'classify-failed', message: error instanceof Error ? error.message : String(error), details: { issues: [] } } }
        }
        const tier = TIERS.includes(rawTier) ? rawTier : verdict.tier
        const tierReason = TIERS.includes(rawTier) ? `tier-${rawTier}` : verdict.tierReason
        let decision
        try {
          decision = decide(at, probeCfg, { tier, tierReason, forceTier: true })
        } catch (error) {
          return { ok: false, error: { code: 'decide-failed', message: error instanceof Error ? error.message : String(error), details: { issues: [] } } }
        }
        const target = decision.target ? cloneSelection(decision.target) : null
        return {
          ok: true,
          value: {
            tier: decision.tier,
            score: verdict.score,
            reasons: verdict.reasons,
            features: verdict.features,
            thresholds: {
              concrete: probeCfg.tierRouting.concreteThreshold,
              medium: probeCfg.tierRouting.mediumThreshold,
            },
            target,
            axis: decision.axis,
            tierReason: decision.tierReason,
            costReason: decision.costReason,
            reason: decision.reason,
            weekday: decision.weekday,
            holiday: decision.holiday,
            at: at.toISOString(),
          },
        }
      },
    }

    for (const [endpoint, handler] of Object.entries(handlers)) {
      connCtx.effect(() => register(fetchRouteFor(endpoint, handler)), `dsh-peak-valley-router: /api/${RPC_PREFIX}${endpoint}`)
    }
  })

  // Best-effort restore on unload: leave no session stranded on a routed model,
  // and flush the queued applied/restore metadata to disk.
  ctx.effect(() => () => {
    try { restoreAllLive('dispose') } catch {}
    try {
      const flushing = stateStore.flushNow()
      if (flushing && typeof flushing.catch === 'function') flushing.catch((error) => debugLog(`state: dispose flush failed: ${error instanceof Error ? error.message : String(error)}`))
    } catch {}
  }, 'dsh-peak-valley-router: restore on dispose')
}
