// Guards the single-source UI copy file (lib/text.js) and the localization of
// server-side validation errors.
//
// 1. Every t('key') referenced by src/client/** must exist in BOTH zh and en —
//    lib/text.js is the one place UI text may live (see the build script, which
//    injects those dictionaries into lib/client.js).
// 2. The English technical message the server raises for a droppable strategy
//    must be rewritten into the active language while KEEPING the strategy index
//    and never inventing text for an unrecognized message.
// Run: node scripts/copy.test.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { zh, en } = await import(new URL('../lib/text.js', import.meta.url))

let failures = 0
const checks = []
const check = (name, fn) => checks.push([name, fn])
const eq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}\n       expected: ${expected}\n       actual:   ${actual}`)
}

// --- 1. key coverage ---------------------------------------------------------
const clientDir = join(root, 'src', 'client')
const usedKeys = new Set()
for (const file of readdirSync(clientDir)) {
  const src = readFileSync(join(clientDir, file), 'utf8')
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) usedKeys.add(m[1])
}
check(`client t() keys are all defined in zh and en (${usedKeys.size} keys)`, () => {
  const missingZh = [...usedKeys].filter((k) => !(k in zh)).sort()
  const missingEn = [...usedKeys].filter((k) => !(k in en)).sort()
  if (missingZh.length) throw new Error(`missing in zh: ${missingZh.join(', ')}`)
  if (missingEn.length) throw new Error(`missing in en: ${missingEn.join(', ')}`)
})
check('zh and en declare exactly the same keys', () => {
  const a = Object.keys(zh).sort()
  const b = Object.keys(en).sort()
  const onlyZh = a.filter((k) => !b.includes(k))
  const onlyEn = b.filter((k) => !a.includes(k))
  if (onlyZh.length || onlyEn.length) throw new Error(`zh-only: [${onlyZh}], en-only: [${onlyEn}]`)
})
check('weekdayShort is a 7-item comma-separated list in both languages', () => {
  for (const [lang, dict] of [['zh', zh], ['en', en]]) {
    const parts = String(dict.weekdayShort ?? '').split(',')
    if (parts.length !== 7) throw new Error(`${lang}: expected 7 entries, got ${parts.length} (${JSON.stringify(dict.weekdayShort)})`)
    if (parts.some((p) => !p.trim())) throw new Error(`${lang}: empty weekday entry in ${JSON.stringify(dict.weekdayShort)}`)
  }
  if (zh.weekdayShort === en.weekdayShort) throw new Error('weekdayShort must differ between languages')
})

check('client sources are stored as valid UTF-8', () => {
  // Without this, a file written in a local code page (e.g. PowerShell's
  // Add-Content default on a zh-CN host) decodes to U+FFFD and would silently
  // slip past the CJK scan below.
  for (const file of readdirSync(clientDir)) {
    const src = readFileSync(join(clientDir, file), 'utf8')
    if (src.includes('\uFFFD')) throw new Error(`${file} is not valid UTF-8 (contains U+FFFD)`)
  }
})

check('weekdayLabels returns 7 localized labels and degrades to [] when the key is missing', () => {
  // Same lift-and-evaluate approach as the error mappers: the real client helper
  // is exercised, not a re-implementation.
  const sharedSrc = readFileSync(join(clientDir, '00-shared.js'), 'utf8')
  const weekdayLabels = new Function(`${liftFunction(sharedSrc, 'weekdayLabels')}\nreturn weekdayLabels`)()
  const zhLabels = weekdayLabels(makeT(zh))
  const enLabels = weekdayLabels(makeT(en))
  eq(zhLabels.length, 7, 'zh length')
  eq(zhLabels[0], '一', 'zh first')
  eq(enLabels.length, 7, 'en length')
  eq(enLabels[0], 'Mon', 'en first')
  eq(enLabels[6], 'Sun', 'en last')
  // DSH returns the key itself for an unknown key; the helper must not render it.
  eq(weekdayLabels((k) => k).length, 0, 'unknown key degrades to []')
  eq(weekdayLabels(() => undefined).length, 0, 'missing value degrades to []')
})

// Only the LABELS of the reasoning-effort options are localized. If a value were
// localized too, the saved config would carry a value DSH's own enum does not
// know, and routing would silently fall back. Guard the enum itself.
check('reasoning-effort option values are still the DSH enum', () => {
  const src = readFileSync(join(clientDir, '20-modelpicker.js'), 'utf8')
  const start = src.indexOf('const effortChoices')
  if (start < 0) throw new Error('effortChoices not found in 20-modelpicker.js')
  const end = src.indexOf('\n  ]', src.indexOf('effortMax'))
  if (end < 0) throw new Error('cannot locate the end of effortChoices')
  const block = src.slice(start, end + 4)
  const values = [...block.matchAll(/\['([a-z]*)',\s*t\(/g)].map((m) => m[1])
  eq(JSON.stringify(values), JSON.stringify(['', 'low', 'medium', 'high', 'xhigh', 'max']), 'effort values')
})

// Per-session state resolution is the whole point of the session switch, and it
// lives entirely in this pure helper — a regression here would show up as "the
// light is wrong" rather than as an error, so it gets a direct guard.
check('peakSessionEffective resolves overrides, defaults and missing ids', () => {
  const sharedSrc = readFileSync(join(clientDir, '00-shared.js'), 'utf8')
  const peakSessionEffective = new Function(`${liftFunction(sharedSrc, 'peakSessionEffective')}\nreturn peakSessionEffective`)()
  const sessions = { a: true, b: false }
  eq(peakSessionEffective(false, sessions, 'a'), true, 'override ON beats default OFF')
  eq(peakSessionEffective(true, sessions, 'b'), false, 'override OFF beats default ON')
  eq(peakSessionEffective(true, sessions, 'c'), true, 'no entry follows default ON')
  eq(peakSessionEffective(false, sessions, 'c'), false, 'no entry follows default OFF')
  eq(peakSessionEffective(true, sessions, ''), true, 'empty id -> default')
  eq(peakSessionEffective(true, undefined, 'a'), true, 'missing map -> default')
  eq(peakSessionEffective(false, {}, undefined), false, 'missing id -> default')
})

check('peakRoutingSessions keeps only boolean values from the wire', () => {
  const sharedSrc = readFileSync(join(clientDir, '00-shared.js'), 'utf8')
  const peakRoutingSessions = new Function(`${liftFunction(sharedSrc, 'peakRoutingSessions')}\nreturn peakRoutingSessions`)()
  // eq() is a strict comparison for scalars; objects need structural equality.
  const eqj = (actual, expected, label) => eq(JSON.stringify(actual), JSON.stringify(expected), label)
  eqj(peakRoutingSessions({ sessions: { a: true, b: false } }), { a: true, b: false }, 'clean map')
  eqj(peakRoutingSessions({ sessions: { a: 'yes', b: 1, '': true } }), {}, 'drops non-booleans and empty ids')
  eqj(peakRoutingSessions({ sessions: ['a'] }), {}, 'drops arrays')
  eqj(peakRoutingSessions({ sessions: null }), {}, 'tolerates null')
  eqj(peakRoutingSessions(undefined), {}, 'tolerates undefined')
})

// The user requirement is that ALL interface text is maintained in one file. This
// catches the failure mode the reviewer found (a Chinese weekday array hardcoded
// in the client): once block comments are removed and each line is cut at its
// first `//`, no CJK literal may remain in the client sources. CJK outside
// text.js is, in practice, always UI copy — code comments are exempt by
// construction. Full-width punctuation is included: it is just as untranslatable
// as an ideograph. (Known false negatives, accepted and reported: a `//` inside a
// string literal truncates that line, and non-UTF-8 bytes are caught by the
// separate UTF-8 check above rather than here.)
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
check('no hardcoded CJK copy is left in the client sources', () => {
  const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  const codePart = (line) => {
    const i = line.indexOf('//')
    return i >= 0 ? line.slice(0, i) : line
  }
  const offenders = []
  for (const file of readdirSync(clientDir)) {
    const stripped = stripBlockComments(readFileSync(join(clientDir, file), 'utf8'))
    stripped.split('\n').forEach((line, i) => {
      if (CJK.test(codePart(line))) offenders.push(`${file}:${i + 1} ${line.trim()}`)
    })
  }
  if (offenders.length) throw new Error(`hardcoded CJK copy:\n       ${offenders.join('\n       ')}`)
})

check('every placeholder used by the client exists in both languages', () => {
  // Placeholders the client actually passes; a typo would silently render "{time}".
  const expected = { saved: ['time'], saveFailed: ['detail'], errStrategy: ['index', 'issue'], errMore: ['count'], strategyLabel: ['index'], decoupledCount: ['count'] }
  for (const [key, names] of Object.entries(expected)) {
    for (const lang of [zh, en]) {
      for (const name of names) {
        if (!lang[key].includes(`{${name}}`)) throw new Error(`${key} is missing {${name}} in one language: ${JSON.stringify(lang[key])}`)
      }
    }
  }
})

// --- 2. server error localization -------------------------------------------
// The two mapping functions live inside the client factory, so they are lifted
// out of the source by brace matching instead of being duplicated here.
function liftFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`cannot find function ${name} in the client source`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) { i++; break }
    }
  }
  return src.slice(start, i)
}
const settingsSrc = readFileSync(join(clientDir, '40-settings.js'), 'utf8')
const lift = (name) => liftFunction(settingsSrc, name)
const build = new Function(
  'pvErrorText',
  `${lift('pvStrategyIssueText')}\n${lift('pvSaveErrorText')}\nreturn { pvStrategyIssueText, pvSaveErrorText }`,
)
// Mirrors the DSH locale service: t(key, params) substitutes {name}.
const makeT = (dict) => {
  const t = (key, params) => {
    const template = dict[key]
    if (template === undefined) throw new Error(`unknown key ${key}`)
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  return t
}
const tZh = makeT(zh)
const tEn = makeT(en)
const pvErrorText = (e) => (e instanceof Error ? e.message : e == null ? '' : String(e))
const { pvSaveErrorText } = build(pvErrorText)
const PREFIX = 'dsh-peak-valley-router: '
const SUFFIX = ' — every strategy needs primary.provider and primary.model'

check('single droppable strategy (missing model) is localized with its index', () => {
  const raw = `${PREFIX}strategy #1 needs a primary model${SUFFIX}`
  eq(pvSaveErrorText(raw, tZh), '第 1 条策略：缺少主模型', 'zh')
  eq(pvSaveErrorText(raw, tEn), 'Strategy #1 needs a primary model', 'en')
})
check('missing provider + model is localized', () => {
  const raw = `${PREFIX}strategy #2 needs a primary provider and a primary model${SUFFIX}`
  eq(pvSaveErrorText(raw, tZh), '第 2 条策略：缺少主模型的 Provider 和模型', 'zh')
  eq(pvSaveErrorText(raw, tEn), 'Strategy #2 needs a primary provider and model', 'en')
})
check('multiple offenders keep every index and the "+N more" tail', () => {
  const raw = `${PREFIX}strategy #1 needs a primary model; strategy #2 needs a primary provider (+1 more)${SUFFIX}`
  eq(pvSaveErrorText(raw, tZh), '第 1 条策略：缺少主模型；第 2 条策略：缺少主模型的 Provider（另有 1 条同类问题）', 'zh')
  eq(pvSaveErrorText(raw, tEn), 'Strategy #1 needs a primary model; Strategy #2 needs a primary provider (+1 more)', 'en')
})
check('the advanced-support requirement is localized', () => {
  const raw = 'dsh-peak-valley-router: advanced model support (高级模型支援) is required when strategies are configured'
  eq(pvSaveErrorText(raw, tZh), '设置了策略后必须填写「高级模型支援」', 'zh')
  eq(pvSaveErrorText(raw, tEn), 'advanced model support is required once strategies are set', 'en')
})
check('an unrecognized message is shown verbatim, never swallowed', () => {
  const raw = 'dsh-peak-valley-router: something entirely new happened'
  eq(pvSaveErrorText(raw, tZh), raw, 'zh')
  eq(pvSaveErrorText(raw, tEn), raw, 'en')
  eq(pvSaveErrorText('', tZh), '', 'empty')
})
check('an unrecognized ISSUE keeps the server wording inside the localized frame', () => {
  const raw = `${PREFIX}strategy #3 has an unexpected problem${SUFFIX}`
  eq(pvSaveErrorText(raw, tZh), '第 3 条策略：has an unexpected problem', 'zh')
})
check('an unrecognized issue does not duplicate the "+N more" counter', () => {
  const raw = `${PREFIX}strategy #1 mysterious failure (+2 more)${SUFFIX}`
  eq(pvSaveErrorText(raw, tZh), '第 1 条策略：mysterious failure（另有 2 条同类问题）', 'zh')
  eq(pvSaveErrorText(raw, tEn), 'Strategy #1 mysterious failure (+2 more)', 'en')
})

for (const [name, fn] of checks) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}
console.log(failures === 0 ? 'copy: 全部通过' : `copy: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
