// Offline tier replay: score real task samples with the shipped classifier and
// show which tier each threshold pair would produce. Used to decide whether a
// threshold change is justified before touching a live policy.
//
// Run: node scripts/tier-replay.mjs
//
// Notes:
// - The AgentTeams dispatch prefix ("AgentTeams message from …: ") is stripped by
//   the classifier before scoring, so a generic dispatch template does NOT change
//   the score (verified: prefixed and bare samples score identically).
// - Scores for these samples compress into 0.00–0.75; thresholds must sit inside
//   that band to make all three tiers reachable.
import { classify } from '../lib/classifier.js'

const SAMPLES = [
  ['low', '执行 npm test 并把输出贴出来'],
  ['low', '跑一下回归测试，把结果贴出来'],
  ['low', '把 README 里的端口从 8080 改成 9090'],
  ['mid', '在 /mnt/vdb/dsh-workspace 创建 PV-LOW.md，写一行内容'],
  ['mid', '说明这次改动覆盖了哪些边界，并解释测试覆盖'],
  ['high', '对照契约说明这次交付覆盖了哪些边界'],
  ['high', '裁决两份互相矛盾的证据，说明哪一份可信'],
  ['high', '设计一个可扩展的多阶段架构'],
]

const DISPATCH_PREFIX = 'AgentTeams message from 主控: '

function tierOf(score, concrete, medium) {
  if (score === null) return 'high'
  if (score >= concrete) return 'low'
  if (score >= medium) return 'mid'
  return 'high'
}

const PAIRS = [
  ['live', { concrete: 0.62, medium: 0.4 }],
  ['previous', { concrete: 0.85, medium: 0.55 }],
]

let mismatches = 0
console.log('expected | score | prefixed | ' + PAIRS.map(([name]) => name).join(' | '))
for (const [want, text] of SAMPLES) {
  const bare = classify(text, false)
  const prefixed = classify(DISPATCH_PREFIX + text, false)
  const cells = PAIRS.map(([, pair]) => tierOf(bare.score, pair.concrete, pair.medium))
  if (cells[0] !== want) mismatches += 1
  console.log(
    `${want} | ${String(bare.score).padEnd(5)} | ${String(prefixed.score).padEnd(5)} | ${cells.join(' | ')}`,
  )
}
console.log(`\nprefix changes the score: ${SAMPLES.some(([, text]) => classify(text, false).score !== classify(DISPATCH_PREFIX + text, false).score)}`)
console.log(`mismatches under the live pair: ${mismatches}/${SAMPLES.length}`)
