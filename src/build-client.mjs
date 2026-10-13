// 构建脚本：把 src/client/*.js 拼接成 lib/client.js，并把 lib/text.js 里的
// zh/en 文案注入进去 —— lib/text.js 是文案与默认定义的唯一维护文件。
//
// 用法：node src/build-client.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { zh, en } = await import(new URL('../lib/text.js', import.meta.url))

const ORDER = [
  '00-shared.js',
  '10-toggle.js',
  '20-modelpicker.js',
  '30-strategy.js',
  '40-settings.js',
  '90-apply.js',
]

const parts = ORDER.map((name) => {
  const code = readFileSync(join(here, 'client', name), 'utf8')
  return `// ---- src/client/${name} ----\n${code.trim()}\n`
})

const head = `window.__ModuleLoader__.load({ id: "dsh-peak-valley-router", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require("react");
const { useState, useEffect, useCallback, useMemo, useRef } = require("react");
`

const locales = `// ---- locales: 由 lib/text.js 注入（单一维护文件，勿手工复制） ----
const zh = ${JSON.stringify(zh, null, 2)}
const en = ${JSON.stringify(en, null, 2)}
`

const tail = `\nreturn module.exports;\n} });\n`

const out = [
  head,
  locales,
  ...parts,
  tail,
].join('\n')

writeFileSync(join(root, 'lib', 'client.js'), out, 'utf8')
console.log(`built lib/client.js: ${out.length} bytes from ${ORDER.length} parts`)
