// t10: cross-process/multi-window state convergence.
//  A) two independent stores on one state.json, concurrent writes: no key loss.
//  B) the 1s poller (watchStateFiles) makes the second store see the first's write
//     within ~1.5s.
// Run: node scripts/t10-cross-window.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const stateMod = await import(pathToFileURL(join(here, '..', 'lib', 'state.js')).href)
const { createStateStore, watchStateFiles, normalizeState } = stateMod

const home = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-t10-cross-${process.pid}`)
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const filePath = join(home, 'state.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const read = () => JSON.parse(readFileSync(filePath, 'utf8'))

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

// A. concurrent writers, repeated: each store must merge per key, not last-writer-wins.
const A = createStateStore({ filePath, debounceMs: 0 })
const B = createStateStore({ filePath, debounceMs: 0 })
for (let round = 0; round < 20; round += 1) {
  await Promise.all([
    A.setEnabled(true),
    B.setSessionEnabled('session-x', true),
    A.setSessionEnabled('session-y', round % 2 === 0),
  ])
}
const merged = normalizeState(read())
check('concurrent enabled + session-x + session-y all survive 20 racing rounds', () => {
  if (merged.enabled !== true) throw new Error(`enabled=${merged.enabled}`)
  if (merged.sessions.get('session-x') !== true) throw new Error('session-x lost')
  if (merged.sessions.get('session-y') !== false) throw new Error(`session-y=${merged.sessions.get('session-y')}`)
})
check('revision is monotonic and the file is valid JSON v2', () => {
  const disk = read()
  if (disk.schemaVersion !== 2) throw new Error(`schemaVersion=${disk.schemaVersion}`)
  if (!(disk.revision >= 60)) throw new Error(`revision=${disk.revision} (expected >= 60 after 60 writes)`)
})

// The original lost-write bug: A flips the global switch while B edits a session.
await Promise.all([
  A.setEnabled(false),
  B.setSessionEnabled('session-z', true),
])
const pair = normalizeState(read())
check('A flips the switch while B edits session-z: both survive', () => {
  if (pair.enabled !== false) throw new Error(`enabled=${pair.enabled} (B's write resurrected the old value)`)
  if (pair.sessions.get('session-z') !== true) throw new Error('session-z lost (A\'s write overwrote B)')
})

// B. poller: B2 is created BEFORE A writes; watchStateFiles should deliver it.
const C = createStateStore({ filePath, debounceMs: 0 })
const stop = watchStateFiles(home, ['state.json'], () => { C.reloadFromDisk().catch(() => {}) }, { pollMs: 250, debounceMs: 50 })
const before = C.getSession('late-key').enabled
await A.setSessionEnabled('late-key', true)
const t0 = Date.now()
let seen = false
while (Date.now() - t0 < 1500) {
  await sleep(50)
  if (C.getSession('late-key').enabled === true) { seen = true; break }
}
check(`the poller delivers a foreign write within 1.5s (was ${JSON.stringify(before)}, now ${JSON.stringify(C.getSession('late-key').enabled)}, ${Date.now() - t0}ms)`, () => {
  if (!seen) throw new Error('poller did not deliver the write within 1500ms')
})
stop()
rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
