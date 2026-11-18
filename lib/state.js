// dsh-peak-valley-router — durable, multi-process-safe state (state.json v2).
//
// 设计契约：docs/ROUTING_V2_DESIGN.md §6.1 与 t9 任务契约。核心问题：两个 DSH
// 进程（或两个窗口背后的不同进程）共用同一个 DSH_HOME 时，后写的一方会把整张
// sessions 表覆盖掉。这里的做法：
//   - 每个键带自己的更新时间（*UpdatedAt 映射）；合并时逐键取较新者；
//   - 写入是「锁 → 重读磁盘 → 合并 → 只应用本次变更 → 原子写」；
//   - 读不到/解析失败时**绝不**把状态当成空表写回（否则一次瞬时读失败就会清空
//     用户的开关）；只有 ENOENT 才视为空表；
//   - 清除会话覆盖用 tombstone（值 null + 更新的时间），而不是删键，避免另一
//     进程的旧快照在合并时把它复活。
//
// 文件形状（v2；v1 的 {enabled, sessions:{id:bool}} 可直接读）：
// {
//   schemaVersion: 2, revision, updatedAt,
//   enabled, enabledUpdatedAt,
//   sessions: { id: bool },                // 兼容 v1 与 client 契约
//   sessionsUpdatedAt: { id: ts },
//   tombstones: { id: ts },                // 被清除的覆盖（防止旧快照复活）
//   applied:  { id: {provider,model,reasoningEffort?,at}|null },
//   appliedUpdatedAt: { id: ts },
//   restore:  { id: {provider,model,reasoningEffort?}|null },
//   restoreUpdatedAt: { id: ts },
//   restorePending: { id: true }           // 只在需要「下次见面再还原」时出现
// }

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

export const STATE_SCHEMA_VERSION = 2
export const DEFAULT_MAX_SESSIONS = 500
const LOCK_RETRY_MS = 20
const LOCK_MAX_ATTEMPTS = 25
const LOCK_STALE_MS = 5_000

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function normalizeSelection(value) {
  if (!isPlainObject(value)) return null
  const provider = typeof value.provider === 'string' && value.provider ? value.provider : ''
  const model = typeof value.model === 'string' && value.model ? value.model : ''
  if (!provider || !model) return null
  const out = { provider, model }
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null && value.reasoningEffort !== '') {
    out.reasoningEffort = String(value.reasoningEffort)
  }
  return out
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

export function emptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: 0,
    enabled: false,
    enabledUpdatedAt: 0,
    sessions: new Map(), // id -> bool
    sessionsUpdatedAt: new Map(), // id -> ts
    tombstones: new Map(), // id -> ts (override cleared; suppresses stale peers)
    applied: new Map(), // id -> selection | null
    appliedUpdatedAt: new Map(), // id -> ts
    restore: new Map(), // id -> selection | null
    restoreUpdatedAt: new Map(), // id -> ts
    restorePending: new Map(), // id -> true
    restorePendingUpdatedAt: new Map(), // id -> ts (clears are versioned too)
  }
}

export function cloneState(state) {
  const next = emptyState()
  next.schemaVersion = state.schemaVersion
  next.revision = state.revision
  next.updatedAt = state.updatedAt
  next.enabled = state.enabled
  next.enabledUpdatedAt = state.enabledUpdatedAt
  for (const key of ['sessions', 'sessionsUpdatedAt', 'tombstones', 'applied', 'appliedUpdatedAt', 'restore', 'restoreUpdatedAt', 'restorePending', 'restorePendingUpdatedAt']) {
    next[key] = new Map(state[key])
  }
  return next
}

// v1 (`{enabled, sessions:{id:bool}}`) and v2 both normalize into the in-memory
// shape. Unknown/missing fields fall back to defaults; a v1 file simply has no
// applied/restore data, which is exactly what an upgrade should see.
export function normalizeState(raw) {
  const state = emptyState()
  if (!isPlainObject(raw)) return state
  state.revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
  state.updatedAt = finite(raw.updatedAt)
  state.enabled = raw.enabled === true
  state.enabledUpdatedAt = finite(raw.enabledUpdatedAt)

  // Accept both the v2 flat layout and the earlier per-session-object layout
  // (§6.1) so a file written by an intermediate build still loads.
  const sessionsTs = isPlainObject(raw.sessionsUpdatedAt) ? raw.sessionsUpdatedAt : {}
  const tombstones = isPlainObject(raw.tombstones) ? raw.tombstones : {}
  const appliedTs = isPlainObject(raw.appliedUpdatedAt) ? raw.appliedUpdatedAt : {}
  const restoreTs = isPlainObject(raw.restoreUpdatedAt) ? raw.restoreUpdatedAt : {}
  const applied = isPlainObject(raw.applied) ? raw.applied : {}
  const restore = isPlainObject(raw.restore) ? raw.restore : {}

  if (isPlainObject(raw.sessions)) {
    for (const [id, value] of Object.entries(raw.sessions)) {
      if (!id) continue
      if (typeof value === 'boolean') {
        state.sessions.set(id, value)
        state.sessionsUpdatedAt.set(id, finite(sessionsTs[id], 0))
      } else if (value === null) {
        // Tolerate the interim `null`-as-tombstone encoding: treat it as a
        // tombstone at its recorded time (or 0 when unknown).
        state.tombstones.set(id, finite(sessionsTs[id], 0))
      } else if (isPlainObject(value)) {
        // legacy per-session object: {enabled, updatedAt, restore, applied, restorePending}
        const ts = finite(value.updatedAt, finite(sessionsTs[id], 0))
        if (value.enabled === true || value.enabled === false) {
          state.sessions.set(id, value.enabled === true)
          state.sessionsUpdatedAt.set(id, ts)
        } else {
          state.tombstones.set(id, ts)
        }
        if (value.applied !== undefined && !applied[id]) {
          state.applied.set(id, normalizeSelection(value.applied))
          state.appliedUpdatedAt.set(id, ts)
        }
        if (value.restore !== undefined && !restore[id]) {
          state.restore.set(id, normalizeSelection(value.restore))
          state.restoreUpdatedAt.set(id, ts)
        }
        if (value.restorePending === true) state.restorePending.set(id, true)
      }
    }
  }
  for (const [id, ts] of Object.entries(tombstones)) {
    if (id && Number.isFinite(ts)) state.tombstones.set(id, ts)
  }
  for (const [id, value] of Object.entries(applied)) {
    if (!id) continue
    state.applied.set(id, value === null ? null : normalizeSelection(value))
    state.appliedUpdatedAt.set(id, finite(value?.at, finite(appliedTs[id], 0)))
  }
  for (const [id, value] of Object.entries(restore)) {
    if (!id) continue
    state.restore.set(id, value === null ? null : normalizeSelection(value))
    state.restoreUpdatedAt.set(id, finite(restoreTs[id], 0))
  }
  const pendingTs = isPlainObject(raw.restorePendingUpdatedAt) ? raw.restorePendingUpdatedAt : {}
  if (isPlainObject(raw.restorePending)) {
    for (const [id, value] of Object.entries(raw.restorePending)) {
      if (!id) continue
      const ts = finite(pendingTs[id], 0)
      if (ts > 0) state.restorePendingUpdatedAt.set(id, ts)
      if (value === true) state.restorePending.set(id, true)
    }
  }
  for (const [id, ts] of Object.entries(pendingTs)) {
    if (id && Number.isFinite(ts)) state.restorePendingUpdatedAt.set(id, ts)
  }
  return state
}

export function serializeState(state) {
  const applied = {}
  for (const [id, selection] of state.applied) {
    applied[id] = selection === null ? null : { ...selection, at: finite(state.appliedUpdatedAt.get(id), 0) }
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: state.revision,
    updatedAt: state.updatedAt,
    enabled: state.enabled === true,
    enabledUpdatedAt: state.enabledUpdatedAt,
    sessions: Object.fromEntries(state.sessions),
    sessionsUpdatedAt: Object.fromEntries(state.sessionsUpdatedAt),
    tombstones: Object.fromEntries(state.tombstones),
    applied,
    appliedUpdatedAt: Object.fromEntries(state.appliedUpdatedAt),
    restore: Object.fromEntries(state.restore),
    restoreUpdatedAt: Object.fromEntries(state.restoreUpdatedAt),
    restorePending: Object.fromEntries([...state.restorePending].filter(([, value]) => value === true)),
    restorePendingUpdatedAt: Object.fromEntries(state.restorePendingUpdatedAt),
  }
}

// Per-key newer-wins merge (equal timestamps prefer the on-disk value: another
// process already committed it, so it is the shared truth).
function pickNewer(picked, diskMap, diskTs, memoryMap, memoryTs) {
  const ids = new Set([...diskMap.keys(), ...memoryMap.keys()])
  for (const id of ids) {
    const dt = finite(diskTs.get(id), 0)
    const mt = finite(memoryTs.get(id), 0)
    const useDisk = dt >= mt
    const map = useDisk ? diskMap : memoryMap
    if (map.has(id)) picked.set(id, { value: map.get(id), at: Math.max(dt, mt) })
  }
}

export function mergeState(disk, memory) {
  const merged = emptyState()
  const useMemoryEnabled = finite(memory.enabledUpdatedAt) > finite(disk.enabledUpdatedAt)
  merged.enabled = useMemoryEnabled ? memory.enabled === true : disk.enabled === true
  merged.enabledUpdatedAt = Math.max(finite(disk.enabledUpdatedAt), finite(memory.enabledUpdatedAt))
  merged.revision = Math.max(finite(disk.revision), finite(memory.revision)) + 1
  merged.updatedAt = Math.max(finite(disk.updatedAt), finite(memory.updatedAt))

  const pick = (key, tsKey) => {
    const picked = new Map()
    pickNewer(picked, disk[key], disk[tsKey], memory[key], memory[tsKey])
    return picked
  }
  const sessions = pick('sessions', 'sessionsUpdatedAt')
  for (const [id, entry] of sessions) {
    // A tombstone with a newer timestamp suppresses the override completely.
    const tombstoneAt = Math.max(finite(disk.tombstones.get(id), 0), finite(memory.tombstones.get(id), 0))
    if (tombstoneAt > entry.at) {
      merged.tombstones.set(id, tombstoneAt)
      continue
    }
    merged.sessions.set(id, entry.value)
    merged.sessionsUpdatedAt.set(id, entry.at)
  }
  for (const [id, at] of [...disk.tombstones, ...memory.tombstones]) {
    if (merged.sessions.has(id)) continue
    merged.tombstones.set(id, Math.max(finite(merged.tombstones.get(id), 0), finite(at, 0)))
  }
  const applied = pick('applied', 'appliedUpdatedAt')
  for (const [id, entry] of applied) {
    merged.applied.set(id, entry.value)
    merged.appliedUpdatedAt.set(id, entry.at)
  }
  const restore = pick('restore', 'restoreUpdatedAt')
  for (const [id, entry] of restore) {
    merged.restore.set(id, entry.value)
    merged.restoreUpdatedAt.set(id, entry.at)
  }
  // restorePending is versioned too: a CLEAR must beat a peer's stale `true`.
  const pendingIds = new Set([
    ...disk.restorePending.keys(),
    ...disk.restorePendingUpdatedAt.keys(),
    ...memory.restorePending.keys(),
    ...memory.restorePendingUpdatedAt.keys(),
  ])
  for (const id of pendingIds) {
    const dt = finite(disk.restorePendingUpdatedAt.get(id), 0)
    const mt = finite(memory.restorePendingUpdatedAt.get(id), 0)
    const useDisk = dt >= mt
    const at = Math.max(dt, mt)
    if (at > 0) merged.restorePendingUpdatedAt.set(id, at)
    const pending = useDisk ? disk.restorePending.get(id) : memory.restorePending.get(id)
    if (pending === true) merged.restorePending.set(id, true)
  }
  return merged
}

// ---------- pure mutation helpers (they own the timestamp bookkeeping) ----------

export function setEnabledState(state, value, now = Date.now()) {
  state.enabled = value === true
  state.enabledUpdatedAt = now
}

// `value === null` clears the override and follows the default. The id is moved
// to `tombstones` (with the write time) instead of only being deleted, so a peer
// holding an older snapshot cannot resurrect it during a merge.
export function setSessionEnabledState(state, id, value, now = Date.now()) {
  if (!id) return
  if (value === null || value === undefined) {
    state.sessions.delete(id)
    state.sessionsUpdatedAt.delete(id)
    state.tombstones.set(id, now)
    return
  }
  state.sessions.set(id, value === true)
  state.sessionsUpdatedAt.set(id, now)
  state.tombstones.delete(id)
}

export function setAppliedState(state, id, selection, now = Date.now()) {
  if (!id) return
  const normalized = selection === null ? null : normalizeSelection(selection)
  state.applied.set(id, normalized)
  state.appliedUpdatedAt.set(id, now)
}

export function setRestoreState(state, id, selection, now = Date.now()) {
  if (!id) return
  const normalized = selection === null ? null : normalizeSelection(selection)
  state.restore.set(id, normalized)
  state.restoreUpdatedAt.set(id, now)
}

export function setRestorePendingState(state, id, pending, now = Date.now()) {
  if (!id) return
  if (pending === true) state.restorePending.set(id, true)
  else state.restorePending.delete(id)
  state.restorePendingUpdatedAt.set(id, now)
}

// Bound every per-session map: evict the least recently updated ids (including
// tombstones), never by insertion order.
export function evictState(state, maxSessions = DEFAULT_MAX_SESSIONS) {
  const ids = new Set([
    ...state.sessions.keys(),
    ...state.tombstones.keys(),
    ...state.applied.keys(),
    ...state.restore.keys(),
    ...state.restorePending.keys(),
  ])
  if (ids.size <= maxSessions) return
  const latest = (id) => Math.max(
    finite(state.sessionsUpdatedAt.get(id), 0),
    finite(state.tombstones.get(id), 0),
    finite(state.appliedUpdatedAt.get(id), 0),
    finite(state.restoreUpdatedAt.get(id), 0),
  )
  const evicted = [...ids].sort((a, b) => latest(a) - latest(b)).slice(0, ids.size - maxSessions)
  for (const id of evicted) {
    state.sessions.delete(id)
    state.sessionsUpdatedAt.delete(id)
    state.tombstones.delete(id)
    state.applied.delete(id)
    state.appliedUpdatedAt.delete(id)
    state.restore.delete(id)
    state.restoreUpdatedAt.delete(id)
    state.restorePending.delete(id)
    state.restorePendingUpdatedAt.delete(id)
  }
}

// ---------- file I/O ----------

function readStateSync(path, log) {
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') log?.(`state: read failed, keeping defaults: ${error instanceof Error ? error.message : String(error)}`)
    return emptyState()
  }
}

function readStateForWrite(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    return { ok: true, state: normalizeState(JSON.parse(raw)), missing: false }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, state: emptyState(), missing: true }
    // A transient read failure must NEVER be treated as "empty": writing an empty
    // table would wipe the user's switch and every session override.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// All state I/O is SYNCHRONOUS under the hood. The public API is still async (so
// callers can await durability), but no file handle is ever held across a tick:
// that keeps short-lived hosts and tests deterministic (a pending async write
// would otherwise race a later host recreating the same DSH_HOME).
function writeJsonAtomicSync(path, value, text = JSON.stringify(value, null, 2)) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch {}
    throw error
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function acquireLock(lockPath, log, { retryMs = LOCK_RETRY_MS, maxAttempts = LOCK_MAX_ATTEMPTS } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })) } catch {}
      closeSync(fd)
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        log?.(`state: lock error: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
      try {
        const raw = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (Number.isFinite(raw?.at) && Date.now() - raw.at > LOCK_STALE_MS) {
          try { unlinkSync(lockPath) } catch {}
          continue // retry immediately once the stale lock is gone
        }
      } catch {
        // Unreadable lock: only treat it as stale by its mtime.
        try {
          const info = statSync(lockPath)
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            try { unlinkSync(lockPath) } catch {}
            continue
          }
        } catch {}
      }
    }
    await delay(retryMs)
  }
  log?.('state: lock timeout (change kept in memory only)')
  return false
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath) } catch {}
}

/**
 * Locked read-modify-write. `applyChange(state, now)` must touch ONLY the keys
 * this operation owns (use the setXState helpers above).
 * Returns { ok, state, written, reason?, hash? }.
 */
export async function mutateStateFile({
  filePath,
  lockPath,
  memory,
  applyChange,
  now = Date.now(),
  log,
  maxSessions = DEFAULT_MAX_SESSIONS,
  lock = {},
  guard = null,
}) {
  if (!filePath) {
    const next = cloneState(memory)
    applyChange(next, now)
    evictState(next, maxSessions)
    next.revision = finite(memory.revision) + 1
    next.updatedAt = now
    return { ok: false, state: next, written: false, reason: 'no-path' }
  }
  const locked = await acquireLock(lockPath ?? `${filePath}.lock`, log, lock)
  try {
    if (!locked) {
      const next = cloneState(memory)
      applyChange(next, now)
      evictState(next, maxSessions)
      next.revision = finite(memory.revision) + 1
      next.updatedAt = now
      return { ok: false, state: next, written: false, reason: 'lock-timeout' }
    }
    const disk = readStateForWrite(filePath)
    if (!disk.ok) {
      log?.(`state: read failed, change kept in memory only: ${disk.error}`)
      const next = cloneState(memory)
      applyChange(next, now)
      evictState(next, maxSessions)
      next.revision = finite(memory.revision) + 1
      next.updatedAt = now
      return { ok: false, state: next, written: false, reason: 'read-failed' }
    }
    const merged = mergeState(disk.state, memory)
    // Re-check after the disk read (which can yield): a HOME that was removed and
    // recreated in the meantime must not receive this store's stale memory.
    if (typeof guard === 'function' && !guard()) {
      log?.('state: home changed during the write, change kept in memory only')
      const next = cloneState(memory)
      applyChange(next, now)
      evictState(next, maxSessions)
      next.revision = finite(memory.revision) + 1
      next.updatedAt = now
      return { ok: false, state: next, written: false, reason: 'stale-home' }
    }
    applyChange(merged, now)
    evictState(merged, maxSessions)
    merged.revision = Math.max(finite(disk.state.revision), finite(memory.revision)) + 1
    merged.updatedAt = now
    const payload = serializeState(merged)
    const text = JSON.stringify(payload, null, 2)
    writeJsonAtomicSync(filePath, payload, text)
    return { ok: true, state: merged, written: true, hash: contentHash(text) }
  } catch (error) {
    log?.(`state: write failed, change kept in memory only: ${error instanceof Error ? error.message : String(error)}`)
    const next = cloneState(memory)
    applyChange(next, now)
    evictState(next, maxSessions)
    next.revision = finite(memory.revision) + 1
    next.updatedAt = now
    return { ok: false, state: next, written: false, reason: 'write-failed' }
  } finally {
    if (locked) releaseLock(lockPath ?? `${filePath}.lock`)
  }
}

export function contentHash(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * Create the in-memory state store used by the plugin.
 * - startup read is sync (apply() is sync);
 * - user actions persist immediately (`flushNow` via the mutators);
 * - routing metadata (applied/restore) is debounced so a turn cannot issue one
 *   write per step;
 * - `reloadFromDisk()` adopts an external write (fs.watch), after flushing.
 */
export function createStateStore(options = {}) {
  const {
    filePath = null,
    lockPath = filePath ? `${filePath}.lock` : null,
    log = () => {},
    debounceMs = 1_000,
    now = () => Date.now(),
    maxSessions = DEFAULT_MAX_SESSIONS,
    lock = {},
    writeDelayMs = 0,
  } = options
  let state = filePath ? readStateSync(filePath, log) : emptyState()
  // Identity of the plugin directory at creation. When a HOME is removed and
  // recreated (tests do this between scenarios; a user can do it by deleting the
  // plugin dir), an abandoned store must NOT write its stale memory back into the
  // new directory. Directory birthtime+inode change on recreation on both POSIX
  // and Windows, so this is a cheap and reliable "same home?" check.
  const dirPath = filePath ? dirname(filePath) : null
  function dirSignature() {
    if (!dirPath) return null
    try {
      const info = statSync(dirPath)
      return `${info.birthtimeMs}:${String(info.ino)}`
    } catch {
      return null
    }
  }
  let homeIdentity = dirSignature()
  const homeUnchanged = () => {
    const current = dirSignature()
    // The directory is created lazily by the first write: while it does not exist
    // yet there is nothing that could have been recreated, so allow the write.
    if (current === null) return homeIdentity === null
    if (homeIdentity === null) { homeIdentity = current; return true }
    return current === homeIdentity
  }
  let lastWrittenHash = null
  let revisionOfLastWrite = 0
  const pending = []
  let timer = null
  let inFlight = null

  const touchQueue = () => {
    if (timer) return
    if (debounceMs <= 0) {
      // Immediate mode: flush on the next microtask. Applied/restore change at
      // most once per turn, so no batching is needed; determinism matters more
      // (tests, short-lived processes, dispose).
      queueMicrotask(() => {
        flushNow().catch((error) => log(`state: flush failed: ${error instanceof Error ? error.message : String(error)}`))
      })
      return
    }
    timer = setTimeout(() => {
      timer = null
      flushNow().catch((error) => log(`state: flush failed: ${error instanceof Error ? error.message : String(error)}`))
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function flushNow() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // Coalesce: if a flush is already running, wait for it and then flush whatever
    // arrived meanwhile. Without this an explicit await could return while the
    // scheduled microtask flush was still writing (and the caller would read a
    // half-settled revision).
    if (inFlight) {
      await inFlight.catch(() => {})
      if (pending.length === 0) return { ok: true, written: false }
    }
    const job = (async () => {
      if (pending.length === 0) return { ok: true, written: false }
      if (!homeUnchanged()) {
        // The home this store belongs to is gone (recreated/removed). Drop the
        // queued change instead of writing stale memory into the new directory.
        pending.splice(0)
        return { ok: false, written: false, reason: 'stale-home' }
      }
      const changes = pending.splice(0)
      if (changes.length === 0) return { ok: true, written: false }
      // The change was already applied to the in-memory state synchronously (see
      // enqueue), so persistence only has to merge that state with the disk.
      const applyChange = () => {}
      if (writeDelayMs > 0) await delay(writeDelayMs)
      const result = await mutateStateFile({
        filePath,
        lockPath,
        memory: state,
        applyChange,
        now: now(),
        log,
        maxSessions,
        lock,
        guard: homeUnchanged,
      })
      state = result.state
      if (result.written) {
        lastWrittenHash = result.hash
        revisionOfLastWrite = state.revision
        if (homeIdentity === null) homeIdentity = dirSignature()
      }
      return result
    })()
    inFlight = job
    try {
      return await job
    } finally {
      if (inFlight === job) inFlight = null
    }
  }

  // Apply a change to the in-memory state IMMEDIATELY (the routing gate, the
  // restore path and the RPC response all read memory synchronously), then queue
  // the durable write. If the flush fails/locks out, memory still reflects what
  // the user asked for and the file keeps the previous revision.
  function enqueue(change) {
    change(state, now())
    pending.push(true)
    touchQueue()
  }

  function isOwnWrite(text) {
    return lastWrittenHash !== null && contentHash(text) === lastWrittenHash
  }

  async function reloadFromDisk(reason = 'watch') {
    await flushNow()
    if (!filePath) return false
    if (!homeUnchanged()) return false
    try {
      const raw = await readFile(filePath, 'utf8')
      if (isOwnWrite(raw)) return false
      const disk = normalizeState(JSON.parse(raw))
      if (disk.revision < revisionOfLastWrite) {
        // A peer wrote an older revision (clock skew/delayed write): merge rather
        // than adopt, so a just-committed local change is not lost.
        state = mergeState(disk, state)
      } else {
        state = disk
      }
      log(`state: reloaded from disk (${reason}), revision ${state.revision}`)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      log(`state: reload failed (${reason}), keeping memory: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  return {
    get state() { return state },
    getSession(id) {
      if (!id) return { enabled: null, applied: null, restore: null, restorePending: false }
      const enabled = state.tombstones.has(id) ? null : (state.sessions.has(id) ? state.sessions.get(id) : null)
      return {
        enabled,
        applied: state.applied.get(id) ?? null,
        restore: state.restore.get(id) ?? null,
        restorePending: state.restorePending.get(id) === true,
      }
    },
    sessionIds() {
      return new Set([...state.sessions.keys(), ...state.applied.keys(), ...state.restore.keys(), ...state.restorePending.keys()])
    },
    sessionsJson() {
      const out = {}
      for (const [id, value] of state.sessions) if (typeof value === 'boolean') out[id] = value
      return out
    },
    setEnabled(value, { immediate = true } = {}) {
      enqueue((target, at) => setEnabledState(target, value, at))
      return immediate ? flushNow() : undefined
    },
    setSessionEnabled(id, value, { immediate = true } = {}) {
      enqueue((target, at) => setSessionEnabledState(target, id, value, at))
      return immediate ? flushNow() : undefined
    },
    setApplied(id, selection, { immediate = false } = {}) {
      enqueue((target, at) => setAppliedState(target, id, selection, at))
      return immediate ? flushNow() : undefined
    },
    setRestore(id, selection, { immediate = false } = {}) {
      enqueue((target, at) => setRestoreState(target, id, selection, at))
      return immediate ? flushNow() : undefined
    },
    setRestorePending(id, pendingValue, { immediate = false } = {}) {
      enqueue((target, at) => setRestorePendingState(target, id, pendingValue, at))
      return immediate ? flushNow() : undefined
    },
    enqueue,
    flushNow,
    reloadFromDisk,
    isOwnWrite,
    lastWrittenHash: () => lastWrittenHash,
  }
}

/**
 * Change detection for the plugin directory.
 *
 * Implemented with mtime polling rather than fs.watch on purpose: on Windows an
 * open directory watcher keeps a handle that makes recursive temp-dir cleanup
 * fail (every test that boots the plugin would need to dispose it perfectly), and
 * fs.watch has known duplicate/rename quirks. Polling is the documented fallback
 * in §6.4 and the client polls `get` every 3 s anyway, so a ≤1 s server-side
 * detection is plenty. Self-triggered writes are suppressed by the callers via
 * content hashes.
 *
 * Returns a disposer. `debounceMs` is accepted for API compatibility; the
 * effective poll interval is `pollMs` (default 1000).
 */
export function watchStateFiles(dir, names, onChange, { debounceMs = 250, pollMs = 1_000, log = () => {} } = {}) {
  if (!dir) return () => {}
  const wanted = [...new Set(names)]
  const signature = (name) => {
    try {
      const info = statSync(join(dir, name))
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return ''
    }
  }
  const last = new Map(wanted.map((name) => [name, signature(name)]))
  let timer = null
  const tick = () => {
    const changed = []
    for (const name of wanted) {
      const current = signature(name)
      if (current === last.get(name)) continue
      last.set(name, current)
      if (current) changed.push(name) // ignore deletions: the file will be re-created on save
    }
    if (changed.length === 0) return
    try { onChange(changed) } catch (error) { log(`watch: handler failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  timer = setInterval(tick, Math.max(100, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : debounceMs * 4))
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}
