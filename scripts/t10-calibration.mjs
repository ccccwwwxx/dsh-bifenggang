// t10 independent verification: classifier calibration on a sample set written by
// the verifier (NOT copied from classifier.test.mjs or design §4.6).
//
// Labels are the verifier's judgement of what the routing SHOULD do:
//   high = abstract / principle / design / planning (no action requested)
//   mid  = a concrete anchor WITH analysis/review/scope, or a scoped edit on a named file
//   low  = concrete execution: run a command, install, or "just run/execute this"
//
// This file does not modify lib/ and is not wired into `npm test` on purpose: it is
// an acceptance probe, not an implementation test. Run:
//   node scripts/t10-calibration.mjs
import { classify } from '../lib/classifier.js'

const SAMPLES = [
  // ---------- high: abstract / principle / design / planning ----------
  ['为什么 DSH 在 0.2.2 里把 agent/request 标成弃用？', 'high', 'abstract-principle'],
  ['解释一下峰谷路由和成本路由到底解决的是不是同一个问题', 'high', 'abstract-explain'],
  ['如果要在路由里再加一个维度，你会怎么设计这个维度？', 'high', 'abstract-design'],
  ['评估一下把状态存到 sqlite 和继续用 json 的取舍', 'high', 'abstract-tradeoff'],
  ['这个插件现在的架构有什么风险，值不值得重构？', 'high', 'abstract-risk'],
  ['总结一下这两周从 0.15 到 0.16 我们都改了什么', 'high', 'abstract-summary'],
  ['为什么我的回复总是被截断？', 'high', 'short-abstract'],
  ['为什么不生效？', 'high', 'short-abstract-critical'],
  ['怎么判断一个请求应该走高档次还是低档次模型？', 'high', 'abstract-howto'],
  ['对比 RouteLLM 和 FrugalGPT 在成本控制上的思路差异', 'high', 'abstract-compare'],
  ['下一步应该先发布还是先做独立验收？', 'high', 'abstract-decision'],
  ['帮我想想怎么向完全不懂路由的用户解释这个功能', 'high', 'abstract-communication'],
  ['多子问题：这个阈值合理吗？偏低会怎样？偏高又会怎样？', 'high', 'multi-question'],
  ['Why does the router keep switching models mid-conversation?', 'high', 'english-abstract'],
  ['这几行配置我应该怎么填？\n```yaml\ntierRouting:\n  enabled: false\n```', 'high', 'code-block-but-asking-howto'],
  ['以下是完整的构建日志，里面有 3 个 warning，请逐条解释这些 warning 的含义以及是否影响发布：\n' + 'x'.repeat(1600), 'high', 'long-log-ask-explain'],
  ['这段代码为什么会在并发时出错？\n```js\nlet n = 0\nn += 1\n```', 'high', 'code-block-explain-why'],
  ['TypeError: Cannot read properties of undefined (reading id)\n    at run (lib/index.js:44:12)\n为什么会出现这个错误？', 'high', 'stack-ask-why'],
  ['Could you review the tradeoffs of the three-tier scheme and tell me whether the thresholds are sensible?', 'high', 'english-review'],
  ['帮我看一下这个截图里的设置对不对', 'high', 'image-audit', { hasImage: true }],

  // ---------- mid: scoped edit / mixed analysis + anchor ----------
  ['帮我改 lib/index.js 第 120 行', 'mid', 'scoped-edit-design-D4'],
  ['我想确认 scripts 里的测试在当前 Node 版本上都能过，请运行 pnpm test 并把每个 suite 的耗时列出来，失败的单独说明原因', 'mid', 'run-plus-report'],
  ['把 src/client/40-settings.js 里保存按钮的文案改短一点', 'mid', 'scoped-edit'],
  ['给 lib/routing.js 的 decide 增加一个参数，并补上对应测试', 'mid', 'scoped-feature'],
  ['这段报错是 TypeError: x is not a function，在 lib/a.js:33 触发，先定位再改', 'mid', 'error-plus-diagnose'],
  ['把 config-v2.test.mjs 里第三个用例改成同时覆盖 mid 档', 'mid', 'scoped-test-edit'],
  ['检查 lib/state.js 的锁逻辑，列出可能死锁的路径，先不要改代码', 'mid', 'review-with-scope'],
  ['把 README 里「三档」那一节补一段说明，解释 mid 和 high 默认共用 low 的原因', 'mid', 'doc-edit-with-reason'],
  ['把 lib/classifier.js 的 short-command 特征去掉，看看会挂哪些测试', 'mid', 'experiment-with-path'],
  ['重构 lib/state.js 的写入顺序，但行为必须和现在完全一致', 'mid', 'scoped-refactor'],
  ['把 lib/text.js 里的「额度」改成「余额」', 'mid', 'scoped-rename'],
  ['删掉 scripts/roundtrip.test.mjs', 'mid', 'delete-file'],
  ['给 lib/classifier.js 第 222 行加个注释说明 short-command 的来历', 'mid', 'line-edit'],
  ['把 policy.json.bak-v1 删掉，然后重新生成一份', 'mid', 'file-maintenance'],
  ['修复这个 ENOENT: no such file or directory, open lib/state.js 报错', 'mid', 'fix-specific-error'],
  ['这个函数签名不对，按下面这样改：\n```js\nselect(target)\n```', 'mid', 'code-edit-instruction'],
  ['把 state.json 里的 enabled 改成 false 再重启插件', 'mid', 'state-edit'],

  // ---------- low: concrete execution ----------
  ['npm run verify', 'low', 'command-only-english'],
  ['pnpm -C dsh-bifenggang test', 'low', 'command-with-path'],
  ['git status', 'low', 'command-only'],
  ['node src/build-client.mjs', 'low', 'build-command'],
  ['跑一遍全部测试然后把结果贴出来', 'low', 'chinese-run-tests'],
  ['安装 eslint 并生成默认配置', 'low', 'install-imperative'],
  ['运行 node --test scripts/tier-routing.test.mjs', 'low', 'explicit-test-run'],
  ['帮我跑一下 npm test 2>&1 并把 stderr 写到 tmp.log', 'low', 'run-with-redirect'],
  ['Run the full test suite and summarize which suites are red.', 'low', 'english-run-summarize'],
  ['帮我把 build 出来的 client 重新生成，命令是 node src/build-client.mjs', 'low', 'run-with-explicit-command'],
]

const TIERS = ['high', 'mid', 'low']
const matrix = Object.fromEntries(TIERS.map((expected) => [expected, Object.fromEntries(TIERS.map((got) => [got, 0]))]))
const rows = []

for (const [text, expected, category, options] of SAMPLES) {
  const verdict = classify({ text, ...(options ?? {}) })
  matrix[expected][verdict.tier] += 1
  rows.push({ expected, actual: verdict.tier, score: verdict.score, reasons: verdict.reasons.join(','), category })
}

const pad = (s, n) => String(s).padEnd(n)
console.log('== per-sample ==')
for (const row of rows) {
  const flag = row.expected === row.actual ? ' ' : '!'
  console.log(`${flag} ${pad(row.expected, 4)} -> ${pad(row.actual, 4)} score=${pad(row.score ?? 'null', 6)} ${pad(row.category, 28)} ${row.reasons}`)
}

console.log('\n== confusion matrix (rows=expected, cols=actual) ==')
console.log('expected\\actual  high  mid  low')
for (const expected of TIERS) {
  console.log(`${pad(expected, 16)} ${pad(matrix[expected].high, 5)} ${pad(matrix[expected].mid, 4)} ${pad(matrix[expected].low, 4)}`)
}

console.log('\n== per-tier recall ==')
let failed = false
for (const tier of TIERS) {
  const total = TIERS.reduce((sum, got) => sum + matrix[tier][got], 0)
  const recall = total === 0 ? 0 : matrix[tier][tier] / total
  console.log(`${pad(tier, 5)} recall=${recall.toFixed(3)} (${matrix[tier][tier]}/${total})`)
  if (recall < 0.7) failed = true
}

console.log('\n== cross-tier violations (high->low / low->high) ==')
const violations = rows.filter((row) => (row.expected === 'high' && row.actual === 'low') || (row.expected === 'low' && row.actual === 'high'))
if (violations.length === 0) console.log('none')
for (const row of violations) console.log(`VIOLATION ${row.expected}->${row.actual} [${row.category}] ${row.reasons}`)
if (violations.length > 0) failed = true

console.log('\n== adjacent misses ==')
for (const row of rows) {
  if (row.expected !== row.actual && !violations.includes(row)) console.log(`miss ${row.expected}->${row.actual} [${row.category}] score=${row.score} ${row.reasons}`)
}

// The captain's specific worry: does short-command hurt a short-but-abstract question?
const shortAbstract = classify('为什么不生效？')
console.log(`\n== short-command probe ==\n'为什么不生效？' -> tier=${shortAbstract.tier} score=${shortAbstract.score} reasons=${shortAbstract.reasons}`)

const total = SAMPLES.length
const correct = rows.filter((row) => row.expected === row.actual).length
console.log(`\n== overall ==\naccuracy=${(correct / total).toFixed(3)} (${correct}/${total}); gate=${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
