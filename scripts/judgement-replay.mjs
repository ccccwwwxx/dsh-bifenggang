// Paired replay: the SAME log evidence, two tasks that must route differently.
//
//   A: "record the exit code"                  → judgement=execute   → low tier
//   B: "decide whether this justifies accepting" → judgement=adjudicate → high tier
//
// It prints what text scoring alone would have chosen next to the declared tier,
// so a mis-declared dispatch (declaration says execute, text obviously asks for a
// verdict) is visible instead of silently trusted.
//
// Run: node scripts/judgement-replay.mjs
import { classify, TIER_FOR_JUDGEMENT } from '../lib/classifier.js'

const CONCRETE = 0.62
const MEDIUM = 0.4

const LOG_EVIDENCE = 't1 执行 npm test 输出：exit code 254, ENOENT: no such file or directory, open package.json；工作区没有 package.json，未运行任何测试。'

const PAIR = [
  {
    taskId: 't-exec',
    judgement: 'execute',
    subject: '提取退出码',
    description: `${LOG_EVIDENCE}\n只做一件事：把退出码和对应的错误行原样记录下来，不要判断能否验收。`,
  },
  {
    taskId: 't-adj',
    judgement: 'adjudicate',
    subject: '判断可验收性',
    description: `${LOG_EVIDENCE}\n请裁决：这份证据是否足以证明交付可验收？若不足，请给出能区分"实现有问题"与"环境缺失"的复验方案。`,
  },
]

const tierOf = (score) => (score === null ? 'high' : score >= CONCRETE ? 'low' : score >= MEDIUM ? 'mid' : 'high')
const MODEL = {
  low: '峰谷策略（当前峰外 → deepseek-official/deepseek-flash@low）',
  mid: 'codex/gpt-6.2-sol@high',
  high: 'codex/gpt-6.2-astra@max',
}

let sameTextTier = true
let routedApart = true
const rows = PAIR.map((task) => {
  const score = classify(`${task.subject}\n${task.description}`, false).score
  const textTier = tierOf(score)
  const declaredTier = TIER_FOR_JUDGEMENT[task.judgement]
  return { ...task, score, textTier, declaredTier }
})
if (rows[0].textTier !== rows[1].textTier) sameTextTier = false
if (rows[0].declaredTier === rows[1].declaredTier) routedApart = false

console.log('task | judgement | text score | text tier | declared tier | routed model')
for (const row of rows) {
  console.log(`${row.taskId} | ${row.judgement} | ${row.score} | ${row.textTier} | ${row.declaredTier} | ${MODEL[row.declaredTier]}`)
}
console.log(`\ntext scoring alone would separate them: ${!sameTextTier}`)
console.log(`declarations route them apart: ${routedApart}`)
if (sameTextTier !== true) {
  console.log('note: the two log-evidence tasks score the same by text, which is exactly why the declaration exists')
}
