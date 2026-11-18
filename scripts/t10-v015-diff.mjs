// t10: differential check — a v1 single-strategy policy must resolve to the same
// target under the new v2 engine as it did under the shipped v0.15.0 engine.
// Needs the v0.15.0 tree extracted at %TEMP%\pv-v015 (see VERIFICATION doc §B).
// Run: node scripts/t10-v015-diff.mjs
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const oldTree = join(process.env.TEMP ?? process.env.TMP ?? '.', 'pv-v015')
const oldIndex = await import(pathToFileURL(join(oldTree, 'lib', 'index.js')).href)
const newIndex = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)
const newRouting = await import(pathToFileURL(join(process.cwd(), 'lib', 'routing.js')).href)

const v1 = {
  utcOffsetMinutes: 480,
  holidays: [[2026, 10, 1]],
  strategies: [
    {
      name: 's',
      weekdays: [1, 2, 3, 4, 5],
      primary: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
      peak: { enabled: true, windows: [['09:00', '12:00']], provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' },
    },
  ],
  advancedSupport: { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' },
}

const at = [
  ['Wed 09:30 +08 (peak)', '2026-11-18T01:30:00Z'],
  ['Wed 11:59 +08 (peak edge)', '2026-11-18T03:59:00Z'],
  ['Wed 12:00 +08 (valley edge)', '2026-11-18T04:00:00Z'],
  ['Wed 13:30 +08 (valley)', '2026-11-18T05:30:00Z'],
  ['Sat 10:00 +08 (weekend)', '2026-11-21T02:00:00Z'],
  ['Thu 10:00 +08 (holiday)', '2026-10-01T02:00:00Z'],
]

const oldCfg = oldIndex.normalizeConfig(v1)
const newCfg = newRouting.normalizeConfig(v1)
let failures = 0
for (const [label, iso] of at) {
  const date = new Date(iso)
  const before = oldIndex.resolveSelection(date, oldCfg)
  const after = newRouting.decide(date, newCfg).target
  const norm = (s) => JSON.stringify({ provider: s?.provider, model: s?.model, effort: s?.reasoningEffort ?? null })
  const same = norm(before) === norm(after)
  if (!same) failures += 1
  console.log(`${same ? 'ok  ' : 'FAIL'} ${label}: v0.15=${norm(before)} v0.16=${norm(after)}`)
}
process.exit(failures === 0 ? 0 : 1)
