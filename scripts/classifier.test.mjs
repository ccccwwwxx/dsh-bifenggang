// Pure unit tests for lib/classifier.js (tier routing concreteness).
//
// Rules/weights: docs/ROUTING_V2_DESIGN.md §4.3; overrides: §4.4; hysteresis: §4.2;
// counterexamples: §4.6. The classifier is pure, so every assertion here is a
// table look-up — no host, no fs, no timers.
// Run: node scripts/classifier.test.mjs
import {
  classify,
  collectFromMessages,
  findOverride,
  WEIGHTS,
  HYSTERESIS_WINDOW_MS,
} from '../lib/classifier.js'

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
}
const has = (list, id, label) => {
  if (!Array.isArray(list) || !list.includes(id)) throw new Error(`${label}: expected ${id} in ${JSON.stringify(list)}`)
}
const notHas = (list, id, label) => {
  if (Array.isArray(list) && list.includes(id)) throw new Error(`${label}: did not expect ${id} in ${JSON.stringify(list)}`)
}

// ---------- three tiers (positive/negative) ----------

check('abstract questions go high', () => {
  for (const text of ['为什么这样设计', 'explain the design', '评估一下整体架构']) {
    const verdict = classify(text)
    if (verdict.tier !== 'high') throw new Error(`${JSON.stringify(text)}: expected high, got ${verdict.tier} (score ${verdict.score})`)
    if (verdict.score !== null && verdict.score > 0.28) throw new Error(`${JSON.stringify(text)}: score must stay below the medium threshold, got ${verdict.score}`)
  }
})

check('concrete execution commands go low', () => {
  for (const text of ['跑一下测试', 'npm test', 'git status', '$ git status', 'pnpm vitest run']) {
    const verdict = classify(text)
    if (verdict.tier !== 'low') throw new Error(`${JSON.stringify(text)}: expected low, got ${verdict.tier} (score ${verdict.score})`)
    if (!(verdict.score >= 0.55)) throw new Error(`${JSON.stringify(text)}: expected score >= 0.55, got ${verdict.score}`)
  }
})

check('a concrete file edit lands in the middle tier', () => {
  // Design §10.4 D4: "帮我改 lib/index.js 第 120 行" must log tier=mid.
  // t13: path 0.18 + execution verb 0.30 (target noun is not double-counted).
  const verdict = classify('帮我改 lib/index.js 第 120 行')
  eq(verdict.tier, 'mid', 'tier')
  eq(verdict.score, 0.48, 'score (path 0.18 + verb 0.30)')
  has(verdict.reasons, 'path', 'reasons')
  has(verdict.reasons, 'verb', 'reasons')
  notHas(verdict.reasons, 'short-command', 'a file-scoped edit is not a bare command')
})

// ---------- individual features / weights ----------

check('code fences and indented code lines raise concreteness', () => {
  const fenced = classify('look:\n```\nconst a = 1\n```\n')
  has(fenced.reasons, 'code', 'fenced code')
  const indented = classify('look:\n    const a = 1\n    const b = 2\n    const c = 3\n')
  has(indented.reasons, 'code', 'indented code')
})

check('paths / commands / symbols / files each contribute their weight', () => {
  has(classify('please check lib/index.js').reasons, 'path', 'path')
  has(classify('npm run build').reasons, 'command', 'command')
  has(classify('TypeError: ENOENT at Module._compile /x.js:12:3').reasons, 'symbol', 'symbol')
  has(classify({ text: 'attached', hasFile: true }).reasons, 'file', 'file')
  const image = classify({ text: '看一下这个截图', hasImage: true })
  has(image.reasons, 'image', 'image')
})

check('execution verbs are weak without an object, strong with an anchor (t13)', () => {
  // A polite request with no object stays abstract-ish (uncertain -> higher tier).
  const verdict = classify('帮我改一下')
  eq(verdict.score, 0.1, 'verb alone')
  eq(verdict.tier, 'high', 'verb alone is not concrete enough')
  // With a path the execution verb is full weight.
  const withPath = classify('改 lib/a.js')
  eq(withPath.score, 0.48, 'verb + path')
  // A concrete object noun (eslint/测试/配置…) is a full anchor for an operation.
  const withTarget = classify('安装 eslint 并生成默认配置')
  eq(withTarget.tier, 'low', 'install + target noun')
  has(withTarget.reasons, 'verb', 'verb')
  has(withTarget.reasons, 'target', 'target')
})

check('multi-question and long text pull the score down', () => {
  const questions = classify('为什么？怎么改？在哪里？')
  has(questions.reasons, 'multi-question', 'multi')
  const long = classify(`${'长'.repeat(1600)} 总结一下`)
  has(long.reasons, 'long', 'long')
  has(long.reasons, 'abstract', 'abstract')
  if (long.tier !== 'high') throw new Error(`long abstract text must stay high, got ${long.tier}`)
})

check('short and empty inputs are safe (never a crash, never a guessed high)', () => {
  const empty = classify('')
  eq([empty.tier, empty.score, empty.tierReason], ['low', null, 'tier-fallback-low'], 'empty text')
  const blank = classify('   \n\t ')
  eq([blank.tier, blank.score], ['low', null], 'blank text')
  const imageOnly = classify({ text: '', hasImage: true })
  eq([imageOnly.tier, imageOnly.score], ['low', null], 'image only')
  const shortConcept = classify('你好')
  eq(shortConcept.tier, 'high', 'a short conceptual greeting is not concrete')
  has(shortConcept.reasons, 'short', 'short feature')
})

check('mid-turn adoption adds the +0.25 position bonus', () => {
  const off = classify('fix lib/a.js')
  const on = classify('fix lib/a.js', { midTurn: true })
  const delta = on.score - off.score
  if (Math.abs(delta - WEIGHTS['mid-turn']) > 1e-9) throw new Error(`bonus delta: expected ${WEIGHTS['mid-turn']}, got ${delta}`)
  has(on.reasons, 'mid-turn', 'feature')
})

check('scores are clamped to [0,1] and stable across calls', () => {
  const noisy = classify('```\ncode\n```\nnpm test lib/a.js ENOENT:12 `x` 改 `y`')
  if (!(noisy.score >= 0 && noisy.score <= 1)) throw new Error(`score out of range: ${noisy.score}`)
  eq(classify('npm test'), classify('npm test'), 'determinism')
})

// ---------- §4.6 counterexamples ----------

check('#1 long text + "总结一下" must not fall to low', () => {
  const text = `${'背景资料。'.repeat(400)} 总结一下`
  const verdict = classify(text)
  if (verdict.tier === 'low') throw new Error(`long abstract text became low: ${JSON.stringify(verdict)}`)
  has(verdict.reasons, 'abstract', 'abstract feature')
  if (!(verdict.score < 0.55)) throw new Error(`score must stay below concrete threshold: ${verdict.score}`)
})

check('#2 error log + "为什么" mixes positive and abstract features without crashing', () => {
  const text = 'TypeError: ENOENT at read (/app/lib/a.js:12:3)\n    at Module._compile\n为什么读不到？'
  const verdict = classify(text)
  has(verdict.reasons, 'abstract', 'abstract')
  const positives = ['code', 'path', 'symbol'].filter((id) => verdict.reasons.includes(id))
  if (positives.length === 0) throw new Error(`expected a concrete feature in ${JSON.stringify(verdict.reasons)}`)
  if (!['low', 'mid', 'high'].includes(verdict.tier)) throw new Error(`bad tier ${verdict.tier}`)
})

check('#3 a very short command lands in low (not high/mid)', () => {
  const verdict = classify('跑一下测试')
  eq(verdict.tier, 'low', 'tier')
  // t13: a Chinese run request is an execution verb + target noun; it is NOT a
  // shell command (no prompt/fence/bare-command context).
  has(verdict.reasons, 'verb', 'verb')
  has(verdict.reasons, 'target', 'target')
  has(verdict.reasons, 'short-command', 'short-command bridge')
  notHas(verdict.reasons, 'short', 'the short penalty must not apply when positive features exist')
})

check('#4 "帮我重构整个项目" is a safety override -> high', () => {
  const verdict = classify('帮我重构整个项目')
  eq([verdict.tier, verdict.tierReason], ['high', 'override-high-safety'], 'safety override')
  eq(verdict.reasons, ['override-safety'], 'reasons')
})

check('#6 mixed Chinese/English and pure English both hit keywords', () => {
  const mixed = classify('fix this bug，为什么失败？')
  has(mixed.reasons, 'abstract', 'mixed abstract')
  has(mixed.reasons, 'verb', 'mixed verb')
  eq(classify('explain the design').tier, 'high', 'pure English abstract')
  eq(classify('run the tests').tier, 'low', 'pure English command')
})

check('#7 "引用这段代码，解释一下" is not concrete', () => {
  const verdict = classify('引用这段代码，解释一下')
  if (verdict.tier === 'low') throw new Error(`expected mid/high, got low (${verdict.score})`)
  has(verdict.reasons, 'abstract', 'abstract')
})

check('#8 pure image / empty text falls back to low', () => {
  for (const input of [{ text: '', hasImage: true }, '', { text: '  ' }]) {
    const verdict = classify(input)
    eq([verdict.tier, verdict.tierReason, verdict.score], ['low', 'tier-fallback-low', null], JSON.stringify(input))
  }
})

check('#9 two messages in one batch produce ONE score/tier', () => {
  const signals = collectFromMessages([
    { source: { kind: 'user' }, content: [{ type: 'text', text: '解释一下这段代码' }] },
    { source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下测试' }] },
  ])
  const verdict = classify(signals)
  has(verdict.reasons, 'abstract', 'merged abstract')
  has(verdict.reasons, 'verb', 'merged execution verb')
  // One merged score: an abstract + an execution request in the same turn lands
  // mid (the scale is ordinal; §4.6 #9 only requires a single score/tier).
  eq(verdict.tier, 'mid', 'merged tier')
  eq(typeof verdict.score, 'number', 'single score')
})

check('#10 a throwing input is reported, never silently classified', () => {
  const bomb = {
    get text() { throw new Error('boom') },
  }
  let threw = false
  try {
    classify(bomb)
  } catch (error) {
    threw = true
    if (!String(error.message).includes('boom')) throw new Error(`unexpected error: ${error.message}`)
  }
  if (!threw) throw new Error('classify swallowed a broken input instead of throwing')
})

// ---------- overrides (§4.4) ----------

check('override priority: safety > low-explicit > high-explicit', () => {
  const all = classify('认真想，直接改，然后发布整个项目')
  eq([all.tier, all.tierReason], ['high', 'override-high-safety'], 'safety wins')
  const lowVsHigh = classify('别想太多，认真想一下')
  eq([lowVsHigh.tier, lowVsHigh.tierReason], ['low', 'override-low-explicit'], 'low-explicit beats high-explicit')
  const highOnly = classify('认真想，给出方案')
  eq([highOnly.tier, highOnly.tierReason], ['high', 'override-high-explicit'], 'high-explicit')
  eq(findOverride('普通的一句话'), null, 'no override')
  eq(findOverride(''), null, 'empty')
})

check('a low-explicit override wins even over concrete evidence', () => {
  const verdict = classify('别想太多，直接改 lib/index.js 第 120 行并 npm test')
  eq([verdict.tier, verdict.tierReason], ['low', 'override-low-explicit'], 'explicit low')
})

// ---------- hysteresis (§4.2) ----------

check('adjacent tiers within ±0.05 of the boundary keep the previous tier', () => {
  const now = 1_800_000_000_000
  const previous = { tier: 'mid', score: 0.33, at: now - 60_000 }
  // "npm test" scores 1.0 (low) — too far from the 0.55 boundary to damp.
  const far = classify('npm test', { previous, now })
  eq([far.tier, far.hysteresis], ['low', false], 'far from boundary does not damp')
  // "git status" scores exactly 0.55 -> within ±0.05 of the concrete boundary.
  const near = classify('git status', { previous, now })
  eq([near.tier, near.hysteresis], ['mid', true], 'boundary damping')
})

check('hysteresis only applies to adjacent tiers inside the 10 minute window', () => {
  const now = 1_800_000_000_000
  const nearBoundary = classify('git status', { now })
  eq(nearBoundary.score, 0.55, 'boundary score')
  const stale = classify('git status', { previous: { tier: 'mid', score: 0.33, at: now - HYSTERESIS_WINDOW_MS - 1 }, now })
  eq([stale.tier, stale.hysteresis], ['low', false], 'stale verdict does not damp')
  const nonAdjacent = classify('git status', { previous: { tier: 'high', score: 0.1, at: now - 1000 }, now })
  eq([nonAdjacent.tier, nonAdjacent.hysteresis], ['low', false], 'non-adjacent tiers do not damp')
  const same = classify('git status', { previous: { tier: 'low', score: 0.7, at: now - 1000 }, now })
  eq([same.tier, same.hysteresis], ['low', false], 'same tier is not hysteresis')
})

check('overrides are never dampened by hysteresis', () => {
  const verdict = classify('直接改', { previous: { tier: 'high', score: 0.1, at: Date.now() - 1000 }, now: Date.now() })
  eq([verdict.tier, verdict.tierReason, verdict.hysteresis], ['low', 'override-low-explicit', false], 'override bypasses damping')
})

// ---------- thresholds ----------

check('thresholds are configurable and the verdict follows them', () => {
  const strict = classify('跑一下测试', { concreteThreshold: 0.9, mediumThreshold: 0.4 })
  eq(strict.tier, 'mid', '0.60 is mid under a 0.9 concrete threshold')
  const loose = classify('帮我改 lib/index.js 第 120 行', { concreteThreshold: 0.3, mediumThreshold: 0.1 })
  eq(loose.tier, 'low', '0.48 is low under a 0.3 threshold')
  const echoed = classify('x').thresholds
  eq(echoed, { concrete: 0.55, medium: 0.28 }, 'defaults echoed')
})

// ---------- t13: execution requests must not be classified abstract ----------

check('D1: generic execution requests are not pushed to high (no phrase special-cases)', () => {
  // These are NOT taken from t10's set; they are generic instantiations of the
  // "operation + concrete object" shape.
  for (const text of [
    '跑一遍全部单元测试，然后把输出贴出来。',
    '安装 eslint 并生成默认配置。',
    'Run the full test suite and print the summary.',
    '执行 pnpm verify，失败就重试一次。',
    '把依赖装好，然后构建一次。',
    'Install the missing dependencies and rebuild the project.',
  ]) {
    const verdict = classify(text)
    if (verdict.tier === 'high') throw new Error(`${JSON.stringify(text)} was classified high (score ${verdict.score}, ${JSON.stringify(verdict.reasons)})`)
  }
})

check('D1: an execution anchor dominates a secondary abstract word', () => {
  const verdict = classify('跑一遍测试，然后用一句话总结结果。')
  eq(verdict.tier, 'low', 'execution dominates a summarize tail')
  has(verdict.reasons, 'verb', 'verb')
  // A genuine principle question keeps the full abstract penalty.
  eq(classify('为什么这个测试跑不过？').tier, 'high', 'why-question stays high')
})

check('D2: commands are recognised by position, never by a word inside a name', () => {
  const scoped = classify('把 config-v2.test.mjs 里第三个用例改成 false')
  notHas(scoped.reasons, 'command', 'file name must not trigger command')
  eq(scoped.tier, 'mid', 'scoped edit stays mid')
  const stack = classify('TypeError: ENOENT at run (lib/index.js:44:12) 为什么读不到文件？')
  notHas(stack.reasons, 'command', 'stack-frame identifier must not trigger command')
  eq(stack.tier, 'high', 'a why-question about a stack trace stays high')
  // Real command contexts still count.
  has(classify('npm test').reasons, 'command', 'bare command')
  has(classify('please run this:\n```\npnpm vitest run\n```').reasons, 'command', 'fenced command')
  has(classify('执行 pnpm verify').reasons, 'command', 'inline executable + subcommand')
})

check('D3: refactor/patch/migrate are execution verbs (rollback stays a safety override)', () => {
  for (const text of ['重构 lib/state.js 的写入顺序', '给 README 补一段说明', '把重试逻辑迁移到 lib/state.js']) {
    const verdict = classify(text)
    has(verdict.reasons, 'verb', `verb for ${JSON.stringify(text)}`)
    eq(verdict.tier, 'mid', `mid for ${JSON.stringify(text)}`)
  }
  // A migration operation without a file anchor is an execution request (not high).
  const migration = classify('把 Node 版本迁移到 20')
  has(migration.reasons, 'verb', 'migration verb')
  if (migration.tier === 'high') throw new Error('migration request must not be high')
  // By design §4.4 a rollback is a safety override (high), not an ordinary edit.
  eq(classify('把部署脚本回滚到上一个版本').tier, 'high', 'rollback is a safety override')
})

check('D4: short-command is bounded (no file/code anchor, not a principle question)', () => {
  if (WEIGHTS['short-command'] > 0.2) throw new Error(`short-command weight must stay small after D2, got ${WEIGHTS['short-command']}`)
  const scoped = classify('把 build 脚本里的版本检查补上 macOS 分支')
  notHas(scoped.reasons, 'short-command', 'a scoped edit is not a bare command')
  eq(scoped.tier, 'mid', 'scoped edit stays mid')
  notHas(classify('为什么这个测试跑不过？').reasons, 'short-command', 'a why-question never gets the bridge')
  has(classify('跑一下测试').reasons, 'short-command', 'a short run request gets the bridge')
})

// ---------- t13: own labeled set -> confusion matrix ----------

check('t13 labeled set: 0 cross-tier reversals, per-tier recall >= 0.7', () => {
  // Self-written, generalising sentences (NOT copied from t10's verification set).
  const labeled = {
    high: [
      '为什么这个方案在高峰期会变慢？',
      '系统整体架构应该如何取舍？',
      '对比一下两种缓存策略的优缺点。',
      '帮我总结这段运行日志说明了什么问题。',
      '这个错误背后的原理是什么？',
      '设计一个支持多租户的路由层，先讲思路。',
      '该不该把状态同步改成事件驱动？',
      'explain why the retry policy backs off exponentially.',
      'what are the tradeoffs between queueing and rate limiting?',
      'compare the two approaches for cache invalidation.',
      '我们是否值得为这个功能引入新的依赖？',
      '梳理一下当前的路由决策流程，指出潜在风险。',
      '多个子问题：为什么 A 慢？为什么 B 偶尔失败？两者有关联吗？',
      `${'这是很长的背景说明，用来模拟长文档。'.repeat(120)} 请提炼要点。`,
      '评估一下把告警从内存改成持久化的影响。',
    ],
    mid: [
      '把 lib/state.js 里 applied 的写入顺序改成先 merge 再写盘。',
      '删掉 scripts/roundtrip.test.mjs 里第 3 个断言。',
      '重构 lib/index.js 中告警去重的逻辑。',
      '给 README 补一段说明，解释 state.json v2 的字段。',
      '评审一下 lib/classifier.js 的特征权重是否合理。',
      '把 config-v2.test.mjs 里第二个用例改成校验阈值顺序。',
      '修改 lib/text.js 里 warningLegacyExtra 的英文文案。',
      '把 verify.mjs 的 RPC 检查改成允许 probe 缺失时告警。',
      '帮我在 lib/state.js 加一个导出：normalizeState。',
      '把 src/client/40-settings.js 的轮询间隔从 3 秒改成 5 秒。',
      '检查 scripts/copy.test.mjs 为什么在 CI 上偶尔失败。',
      'review the retry helper in lib/index.js for off-by-one errors.',
      'update the CHANGELOG entry for the state schema, one paragraph.',
      '把 build 脚本里的 Node 版本检查补上 macOS 分支。',
      'fix the typo in docs/VERIFICATION_routing_v2.md section F.',
    ],
    low: [
      '跑一下测试。',
      'npm test',
      '跑一遍全部单元测试，然后把输出贴出来。',
      '安装 eslint 并生成默认配置。',
      'Run the full test suite and print the summary.',
      '执行 pnpm verify，失败就重试一次。',
      '把依赖装好，然后构建一次。',
      '删除 node_modules 再重新安装。',
      'git status',
      '运行 npm run build 看看能不能通过。',
      '帮我部署到测试环境，然后重启服务。',
      '提交这次改动并推送分支。',
      '迁移数据库到最新版本。',
      '跑 npm 的 check 脚本，把报错贴出来。',
      'Install the missing dependencies and rebuild the project.',
      'run the tests',
    ],
  }
  const matrix = { high: { high: 0, mid: 0, low: 0 }, mid: { high: 0, mid: 0, low: 0 }, low: { high: 0, mid: 0, low: 0 } }
  const misses = []
  for (const label of ['high', 'mid', 'low']) {
    for (const text of labeled[label]) {
      const verdict = classify(text)
      matrix[label][verdict.tier] += 1
      if (verdict.tier !== label) misses.push(`${label}->${verdict.tier} ${verdict.score} ${JSON.stringify(verdict.reasons)} :: ${text.slice(0, 48)}`)
    }
  }
  const total = Object.values(matrix).reduce((sum, row) => sum + row.high + row.mid + row.low, 0)
  const reverses = matrix.low.high + matrix.high.low
  const recalls = {}
  for (const label of ['high', 'mid', 'low']) {
    const row = matrix[label]
    recalls[label] = row[label] / (row.high + row.mid + row.low)
    if (recalls[label] < 0.7) throw new Error(`${label} recall ${recalls[label].toFixed(3)} < 0.7\n${misses.join('\n')}`)
  }
  if (reverses !== 0) throw new Error(`${reverses} cross-tier reversal(s):\n${misses.join('\n')}`)
  const accuracy = (matrix.high.high + matrix.mid.mid + matrix.low.low) / total
  // Evidence for the t13 report / t14 re-check: matrix + per-tier recall.
  console.log(`      t13 matrix rows=expected [high mid low]: high=[${matrix.high.high} ${matrix.high.mid} ${matrix.high.low}] mid=[${matrix.mid.high} ${matrix.mid.mid} ${matrix.mid.low}] low=[${matrix.low.high} ${matrix.low.mid} ${matrix.low.low}] recall=${recalls.high.toFixed(3)}/${recalls.mid.toFixed(3)}/${recalls.low.toFixed(3)} accuracy=${accuracy.toFixed(3)}`)
  // The matrix is printed on failure too, with the individual misses.
  if (accuracy < 0.85) throw new Error(`accuracy ${accuracy.toFixed(3)} < 0.85\nmatrix=${JSON.stringify(matrix)}\n${misses.join('\n')}`)
})

// ---------- message extraction ----------

check('collectFromMessages merges text blocks and flags image/file attachments', () => {
  const signals = collectFromMessages([
    { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'image' }] },
    { content: [{ type: 'file', name: 'a.ts' }, { type: 'text', text: 'three' }] },
    { content: null },
    {},
  ])
  eq(signals.text, 'one\ntwo\nthree', 'merged text')
  eq([signals.hasImage, signals.hasFile], [true, true], 'attachment flags')
  eq(collectFromMessages(undefined), { text: '', hasImage: false, hasFile: false, taskIds: [] }, 'tolerates non-arrays')
})

for (const [name, fn] of checks) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
console.log(failures === 0 ? 'classifier: 全部通过' : `classifier: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
