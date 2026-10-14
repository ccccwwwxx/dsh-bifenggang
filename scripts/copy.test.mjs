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
check('every placeholder used by the client exists in both languages', () => {
  // Placeholders the client actually passes; a typo would silently render "{time}".
  const expected = { saved: ['time'], saveFailed: ['detail'], errStrategy: ['index', 'issue'], errMore: ['count'] }
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
