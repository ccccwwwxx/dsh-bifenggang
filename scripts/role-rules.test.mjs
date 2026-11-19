// Role rules (0.17): a role can pin a fixed model, pin per-tier models (keeping
// the shipped peak-valley table for the tiers it does not name), or decouple the
// session entirely. Assignment is per session and survives serialize -> normalize.
// Run: node scripts/role-rules.test.mjs
import { normalizeConfig, normalizeRoleRules, findRoleRule } from '../lib/routing.js'
import { DEFAULTS } from '../lib/text.js'
import { emptyState, setRoleState, serializeState, normalizeState, mergeState } from '../lib/state.js'

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const throws = (fn, label) => {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`${label}: expected a ConfigError, got none`)
}

const VERIFIER = {
  name: '验证者',
  match: ['verifier', 'reviewer'],
  tiers: {
    mid: { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' },
    high: { provider: 'codex', model: 'gpt-6.2-astra', reasoningEffort: 'max' },
  },
}
const IMPLEMENTER = {
  name: '实现者',
  match: ['implementer'],
  target: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
}

check('a rule keeps target / tiers / decouple shape', () => {
  const rules = normalizeRoleRules([VERIFIER, IMPLEMENTER, { name: '审核', decouple: true }])
  eq(rules[0].tiers.mid, { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' }, 'mid tier')
  eq(rules[0].tiers.high, { provider: 'codex', model: 'gpt-6.2-astra', reasoningEffort: 'max' }, 'high tier')
  eq(rules[0].tiers.low, undefined, 'low tier stays absent (falls through to the policy)')
  eq(rules[1].target, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, 'fixed target')
  eq(rules[1].tiers, undefined, 'no tiers on a fixed rule')
  eq(rules[2].decouple, true, 'decouple')
})

check('defaults are empty and a missing list is not an error', () => {
  eq(normalizeRoleRules(undefined), [], 'undefined')
  eq(normalizeRoleRules(null), [], 'null')
  eq(normalizeConfig({ ...DEFAULTS }).roleRules, [], 'normalizeConfig default')
})

check('bad rules are rejected instead of silently routing wrong', () => {
  throws(() => normalizeRoleRules('nope'), 'non-array')
  throws(() => normalizeRoleRules([{}]), 'missing name')
  throws(() => normalizeRoleRules([{ name: 'a' }, { name: 'a' }]), 'duplicate name')
  throws(() => normalizeRoleRules([{ name: 'a', tiers: { mid: { provider: 'codex' } } }]), 'incomplete tier triple')
  throws(() => normalizeRoleRules([{ name: 'a', provider: 'codex' }]), 'incomplete fixed target')
})

check('lookup is exact first, then alias, case-insensitively', () => {
  const cfg = normalizeConfig({ ...DEFAULTS, roleRules: [VERIFIER, IMPLEMENTER] })
  eq(findRoleRule(cfg, '验证者').name, '验证者', 'exact')
  eq(findRoleRule(cfg, 'reviewer').name, '验证者', 'alias')
  eq(findRoleRule(cfg, 'Implementer').name, '实现者', 'alias + case')
  eq(findRoleRule(cfg, 'nobody'), null, 'unknown role')
  eq(findRoleRule(cfg, ''), null, 'blank role')
  eq(findRoleRule(normalizeConfig({ ...DEFAULTS }), '验证者'), null, 'no rules configured')
})

check('a role survives serialize -> normalize', () => {
  const state = emptyState()
  setRoleState(state, 'session-a', '验证者', 1000)
  const round = normalizeState(JSON.parse(JSON.stringify(serializeState(state))))
  eq(round.roles.get('session-a'), '验证者', 'role kept')
  eq(round.rolesUpdatedAt.get('session-a'), 1000, 'timestamp kept')
})

check('clearing a role writes a role tombstone that beats a stale peer', () => {
  const disk = emptyState()
  setRoleState(disk, 'session-a', '验证者', 1000)
  const memory = normalizeState(JSON.parse(JSON.stringify(serializeState(disk))))
  setRoleState(memory, 'session-a', null, 2000)
  const merged = mergeState(normalizeState(JSON.parse(JSON.stringify(serializeState(disk)))), memory)
  eq(merged.roles.has('session-a'), false, 'role cleared by the newer tombstone')
  eq(merged.roleTombstones.get('session-a'), 2000, 'tombstone recorded')
  eq(merged.sessions.has('session-a'), false, 'no switch override created')
})

check('an older role write does not overwrite a newer one', () => {
  const newer = emptyState()
  setRoleState(newer, 'session-a', '实现者', 2000)
  const older = emptyState()
  setRoleState(older, 'session-a', '验证者', 1000)
  const merged = mergeState(older, newer)
  eq(merged.roles.get('session-a'), '实现者', 'newer wins')
})

check('roles and the per-session switch coexist', () => {
  const state = emptyState()
  setRoleState(state, 'session-a', '验证者', 1000)
  state.sessions.set('session-a', false)
  state.sessionsUpdatedAt.set('session-a', 1000)
  const round = normalizeState(JSON.parse(JSON.stringify(serializeState(state))))
  eq([round.roles.get('session-a'), round.sessions.get('session-a')], ['验证者', false], 'both kept')
})

for (const [name, fn] of checks) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n       ${error.message}`)
  }
}
if (failures > 0) {
  console.error(`role-rules: ${failures} 项失败`)
  process.exit(1)
}
console.log('role-rules: 全部通过')
