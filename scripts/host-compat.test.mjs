// Host-compatibility guard for the DECLARED peer ranges.
//
// 避峰岗 does not depend on the host at runtime except through a handful of
// seams (agent/request, internal/get, llm.*, connection.fetch, three client
// slots). Those seams were re-checked against core 0.2.1-rc.2 (npm `next`) and
// found unchanged, so the plugin itself needed no code change — but the peer
// range DID need one: `^0.2.0-rc.2` does NOT accept `0.2.1-rc.2`, because a
// prerelease only satisfies a range that names the same [major, minor, patch]
// tuple with a prerelease. A plugin manager that enforces peers therefore
// rejects this plugin on the new core even though every seam still works.
//
// This test pins the declaration to the host lines we actually ran against, and
// it carries its own negative control so the checker cannot silently pass by
// accepting everything. Run: node scripts/host-compat.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Host lines this plugin has been verified against. Extend this list only after
// actually booting the plugin on that core (the CHANGELOG records how).
const VERIFIED_HOSTS = ['0.2.0-rc.2', '0.2.1-rc.2']

// Cores that must stay OUT of the declared range. `0.2.2-rc.1` is the sharp one:
// it is a later 0.2.x *prerelease*, and semver keeps prereleases out of a caret
// range unless that range names their exact triple — so a future rc line has to
// be added deliberately rather than being implied by `^0.2.x`.
const REJECTED_HOSTS = ['0.1.1-rc.2', '0.2.2-rc.1', '0.3.0-rc.1', '1.0.0']

const CORDIS_HOST = '4.0.5'

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ---------- a narrow, dependency-free semver matcher ----------
// Only what this repo's peer ranges use: `^x.y.z` / `^x.y.z-pre`, `||`-joined.
// Written as a checker rather than "is this string in a list" on purpose: the
// bug being guarded against lives exactly in the prerelease rule below.
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!m) throw new Error(`not a version: ${version}`)
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  }
}

function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  // A release outranks its own prereleases; otherwise numeric identifiers sort
  // before alphanumeric ones and are compared numerically.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = typeof left === 'number'
    const rightNumeric = typeof right === 'number'
    if (leftNumeric && rightNumeric) return left < right ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

function satisfiesCaret(version, range) {
  const candidate = parse(version)
  const base = parse(range.slice(1))
  // A prerelease candidate is admitted only by a range that names the same triple.
  if (candidate.prerelease.length > 0) {
    const sameTriple = candidate.major === base.major && candidate.minor === base.minor && candidate.patch === base.patch
    if (!sameTriple || base.prerelease.length === 0) return false
  }
  if (compare(candidate, base) < 0) return false
  // Caret on 0.x stops at the next minor; on 1.x it stops at the next major.
  const upper = base.major === 0
    ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
    : { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
  return compare(candidate, upper) < 0
}

function satisfies(version, ranges) {
  return ranges.split('||').some((range) => satisfiesCaret(version.trim(), range.trim()))
}

// ---------- the checker's own control ----------
// 1. The exact case that forced this version: a later rc line is NOT implied.
check('control: ^0.2.0-rc.2 does not accept 0.2.1-rc.2', () => {
  if (satisfies('0.2.1-rc.2', '^0.2.0-rc.2')) throw new Error('matcher is wrong: it accepted the wrong triple')
})
check('control: ^0.2.0-rc.2 accepts 0.2.0-rc.2 and 0.2.0', () => {
  if (!satisfies('0.2.0-rc.2', '^0.2.0-rc.2')) throw new Error('rejected a version in range')
  if (!satisfies('0.2.0', '^0.2.0-rc.2')) throw new Error('rejected the release above a prerelease floor')
})
check('control: ^0.2.1-rc.2 accepts 0.2.1-rc.2/0.2.1 and rejects 0.2.2-rc.1', () => {
  if (!satisfies('0.2.1-rc.2', '^0.2.1-rc.2')) throw new Error('rejected the version it names')
  if (!satisfies('0.2.1', '^0.2.1-rc.2')) throw new Error('rejected the matching release')
  if (satisfies('0.2.2-rc.1', '^0.2.1-rc.2')) throw new Error('admitted an unrelated prerelease triple')
})
check('control: caret on 0.x stops at the next minor, on 1.x at the next major', () => {
  if (satisfies('0.3.0', '^0.2.1-rc.2')) throw new Error('0.x caret crossed a minor boundary')
  if (!satisfies('1.9.0', '^1.2.3')) throw new Error('1.x caret was too narrow')
  if (satisfies('2.0.0', '^1.2.3')) throw new Error('1.x caret crossed a major boundary')
})

// ---------- the declaration itself ----------
const llmRange = pkg.peerDependencies?.['@deepseek-ai/dsh-llm']
check('peerDependencies 声明了 @deepseek-ai/dsh-llm', () => {
  if (typeof llmRange !== 'string' || llmRange === '') throw new Error('missing peer range')
})

for (const host of VERIFIED_HOSTS) {
  check(`dsh-llm 范围覆盖已实测宿主 ${host}`, () => {
    if (!satisfies(host, llmRange)) throw new Error(`${llmRange} 不接受 ${host}`)
  })
}
for (const host of REJECTED_HOSTS) {
  check(`dsh-llm 范围仍然排除 ${host}`, () => {
    if (satisfies(host, llmRange)) throw new Error(`${llmRange} 意外接受了 ${host}`)
  })
}

const cordisRange = pkg.peerDependencies?.['@deepseek-ai/cordis']
check(`cordis 范围覆盖新核心实际绑定的 ${CORDIS_HOST}`, () => {
  if (typeof cordisRange !== 'string') throw new Error('missing cordis peer range')
  if (!satisfies(CORDIS_HOST, cordisRange)) throw new Error(`${cordisRange} 不接受 ${CORDIS_HOST}`)
})

if (failures > 0) {
  console.log(`\nhost-compat: ${failures} 项失败`)
  process.exit(1)
}
console.log('\nhost-compat: 全部通过')
