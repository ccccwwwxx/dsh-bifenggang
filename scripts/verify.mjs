// 仓库自检：文案 key 完整性、RPC 契约一致性、生成物新鲜度。
// 用法：node scripts/verify.mjs   （在 dsh-bifenggang 目录下运行；退出码非 0 表示失败）
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientDir = join(root, 'src', 'client')

const failures = []
const notes = []
const ok = (msg) => notes.push(`  ok   ${msg}`)
const bad = (msg) => failures.push(`  FAIL ${msg}`)

// ---------- 1. 文案 key ----------
const { zh, en, DEFAULTS } = await import(new URL('../lib/text.js', import.meta.url))

const parts = readdirSync(clientDir).filter((f) => f.endsWith('.js')).sort()
const used = new Set()
for (const part of parts) {
  const code = readFileSync(join(clientDir, part), 'utf8')
  // 同时覆盖 t('key') 与带参数的 t('key', { … }) —— 后者曾被漏掉。
  for (const m of code.matchAll(/(?<![A-Za-z0-9_$])t\(\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) used.add(m[1])
}
const missing = [...used].filter((k) => !(k in zh) || !(k in en)).sort()
if (missing.length) bad(`client 使用了未定义文案 key: ${missing.join(', ')}`)
else ok(`全部 ${used.size} 个 client 文案 key 在 zh/en 均有定义`)

const zhOnly = Object.keys(zh).filter((k) => !(k in en))
const enOnly = Object.keys(en).filter((k) => !(k in zh))
if (zhOnly.length || enOnly.length) bad(`zh/en 双语不对称: zh-only=[${zhOnly}] en-only=[${enOnly}]`)
else ok(`zh/en 双语对称（各 ${Object.keys(zh).length} 个 key）`)

// ---------- 2. RPC 契约一致性 ----------
const nodeSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const clientSrc = parts.map((f) => readFileSync(join(clientDir, f), 'utf8')).join('\n')

const clientRpcs = new Set()
for (const m of clientSrc.matchAll(/dsh-peak-valley-router\.([A-Za-z][A-Za-z0-9_]*)/g)) clientRpcs.add(m[1])
const nodeRpcs = new Set()
// handlers 对象里的顶层方法：形如 `  get: async (payload) => {`
for (const m of nodeSrc.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9_]*):\s*async\s*\(/gm)) nodeRpcs.add(m[1])

const missingOnHost = [...clientRpcs].filter((m) => !nodeRpcs.has(m)).sort()
const missingOnClient = [...nodeRpcs].filter((m) => !clientRpcs.has(m)).sort()
if (missingOnHost.length) bad(`client 调用了 node 未实现的方法: ${missingOnHost.join(', ')}`)
else ok(`client 调用的 ${clientRpcs.size} 个 RPC 在 node 端均有 handler`)
if (missingOnClient.length) ok(`node 端额外方法（client 未用）: ${missingOnClient.join(', ')}`)

// ---------- 3. 关键不变式 ----------
// 0.16.0 的接缝换成了 `agent.model.select()`：`agent/request` 只读（0.2.2-rc.1 会在
// 其后逐字段硬校验并 throw），因此旧的「agent/request prepend 改写」不变式被删除，
// 换成更强的替代：**源码级证明 agent/request 处理器没有任何字段改写**（只读观察这
// 条不变式不能降级成「没人检查」；行为侧由 request-passthrough.test.mjs 双证）。
const requestHandler = (() => {
  const start = nodeSrc.indexOf("ctx.on('agent/request'")
  if (start < 0) return null
  const end = nodeSrc.indexOf('}, { global: true })', start)
  return end < 0 ? null : nodeSrc.slice(start, end)
})()
const must = [
  [/export const inject = \['llm'\]/, 'export const inject = ["llm"] 存在（否则 ctx.llm 取不到）'],
  [/agent\/inbox\/inserted/, 'inbox 插入时计算并 select（agent/inbox/inserted）'],
  [/agent\/turn-stopping/, '排队的下一 turn 在 turn-stopping 决策'],
  [/agent\.model\.select\(/, '唯一写入口是 agent.model.select()'],
  [/agent\/request/, 'agent/request 只读观察仍注册'],
]
for (const [re, label] of must) {
  if (re.test(nodeSrc)) ok(label)
  else bad(`缺失不变式: ${label}`)
}
// agent/inbox/inserted 的注册必须带 { global: true }，否则收不到其它 scope 的事件。
{
  const start = nodeSrc.indexOf("ctx.on('agent/inbox/inserted'")
  const block = start < 0 ? '' : nodeSrc.slice(start, start + 900)
  if (/\{ global: true \}/.test(block)) ok('agent/inbox/inserted 监听带 { global: true }')
  else bad('缺失不变式: agent/inbox/inserted 监听带 { global: true }')
}
// 只读观察的源码级证明：不允许对返回的 config 赋 provider/model/reasoningEffort，
// 必须原样 `return config`。
if (!requestHandler) {
  bad('找不到 agent/request 处理器（无法证明只读观察）')
} else {
  const rewrites = [...requestHandler.matchAll(/\b(config|resolved|proposedConfig)\.(provider|model|reasoningEffort)\s*=/g)]
  if (rewrites.length > 0) bad(`agent/request 仍在改写: ${rewrites.map((m) => `${m[1]}.${m[2]}`).join(', ')}`)
  else ok('agent/request 处理器无 provider/model/reasoningEffort 赋值（只读观察）')
  if (/(provider|model|reasoningEffort)\s*:\s*selection\./.test(requestHandler)) bad('agent/request 仍注入 selection 字段')
  else ok('agent/request 不注入路由 selection')
  if (!/\breturn\s+config\b/.test(requestHandler)) bad('agent/request 没有原样 return config')
  else ok('agent/request 原样 return config')
}
for (const [re, label] of [
  [/agent\/request: overriding/, '旧日志 agent/request: overriding 残留'],
  [/agent\/request: routed/, '旧日志 agent/request: routed 残留'],
]) {
  if (re.test(nodeSrc)) bad(label)
  else ok(`无残留: ${label.replace(' 残留', '')}`)
}
const forbidden = [
  [/llm\/stream/, 'llm/stream 旧方案残留'],
  [/registerAdapter/, 'registerAdapter 残留（避峰岗不得注册为 provider）'],
  [/BifenggangAdapter/, 'BifenggangAdapter 残留'],
]
for (const [re, label] of forbidden) {
  if (re.test(nodeSrc)) bad(label)
  else ok(`无残留: ${label}`)
}
if (/conversation\.input\.model/.test(clientSrc)) bad('有代码注册进 conversation.input.model（不得改动会话模型选择器）')
else ok('未触碰 conversation.input.model 插槽')

// ---------- 4. 生成物新鲜度 ----------
// Build to a SCRATCH file and compare normalized text. Two reasons this is not
// just "rebuild in place and diff":
//   1. `npm run verify` must be read-only — it used to rewrite the shipped
//      lib/client.js as a side effect of checking it.
//   2. CRLF checkouts (core.autocrlf=true) otherwise report "stale" purely
//      because the checkout has CRLF and the build writes LF.
const normalize = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n')
const shippedClient = normalize(readFileSync(join(root, 'lib', 'client.js')))
const scratch = join(tmpdir(), `pv-client-check-${process.pid}.js`)
execFileSync(process.execPath, [join(root, 'src', 'build-client.mjs'), scratch], { cwd: root, stdio: 'pipe' })
const builtClient = normalize(readFileSync(scratch))
rmSync(scratch, { force: true })
if (shippedClient === builtClient) ok('lib/client.js 与 src/client 源一致（产物新鲜；比对不写盘）')
else bad('lib/client.js 与 src/client 源不一致：需要重新构建并提交')

// ---------- 5. 默认定义（schema v2）----------
// 0.16.0 的 DEFAULTS 是三档 + 每档峰谷表；tierRouting 必须默认关闭（恒低档），
// 否则升级会改变所有用户的行为。
const lowTable = DEFAULTS.targets?.low
if (!lowTable?.valley?.provider || !lowTable?.valley?.model) {
  bad('DEFAULTS.targets.low.valley 缺失（schema v2 默认值）')
} else if (!DEFAULTS.targets?.mid || !DEFAULTS.targets?.high) {
  bad('DEFAULTS.targets 缺 mid/high')
} else if (DEFAULTS.tierRouting?.enabled !== false) {
  bad('DEFAULTS.tierRouting.enabled 必须为 false（默认行为等价 0.15）')
} else if (lowTable.costRouting !== true) {
  bad('DEFAULTS.targets.low.costRouting 必须为 true（成本决策默认开启）')
} else if (!DEFAULTS.advancedSupport?.provider || !DEFAULTS.advancedSupport?.model) {
  bad('DEFAULTS 缺高级模型支援')
} else {
  ok(`DEFAULTS: 三档 v2, tierRouting=${DEFAULTS.tierRouting.enabled ? 'on' : 'off'}, low.valley=${lowTable.valley.provider}/${lowTable.valley.model}, advanced=${DEFAULTS.advancedSupport.provider}/${DEFAULTS.advancedSupport.model}`)
}
// 纯路由核心必须是独立模块且被 index 再导出（下游 t6/t10 直接 import 一处）。
if (!existsSync(join(root, 'lib', 'routing.js'))) bad('lib/routing.js 不存在（配置/成本决策纯函数）')
else {
  const routingSrc = readFileSync(join(root, 'lib', 'routing.js'), 'utf8')
  if (!/export function normalizeConfig/.test(routingSrc) || !/export function resolveTargets/.test(routingSrc) || !/export function decide/.test(routingSrc)) {
    bad('lib/routing.js 缺少 normalizeConfig / resolveTargets / decide 导出')
  } else ok('lib/routing.js 提供 normalizeConfig / resolveTargets / decide')
}

// ---------- 6. 版本一致性 ----------
// package.json 是版本的唯一来源；node 端在运行时读它（apply 日志 + get RPC）。
// CHANGELOG 的最新条目必须与之一致，否则「版本」就只是个装饰。
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const semver = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/
if (!semver.test(pkg.version)) {
  bad(`package.json 的 version 不是合法 semver: ${pkg.version}`)
} else {
  ok(`版本: v${pkg.version} (semver)`)
}
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const heading = changelog.match(/^##\s*\[?(\d+\.\d+\.\d+[^\]\s]*)\]?/m)
if (!heading) bad('CHANGELOG.md 找不到 `## [x.y.z]` 形式的版本标题')
else if (heading[1] !== pkg.version) bad(`CHANGELOG 最新版本 ${heading[1]} 与 package.json 的 ${pkg.version} 不一致`)
else ok(`CHANGELOG 最新条目与 package.json 一致 (${pkg.version})`)

// node 端必须真的把版本读出来（而不是硬编码一份会漂移的副本）
if (/function readVersion\(\)/.test(nodeSrc) && /version: VERSION/.test(nodeSrc)) {
  ok('版本在运行时被读取并随 get RPC 下发（非硬编码副本）')
} else {
  bad('node 端未从 package.json 读取版本 / 未随 get RPC 下发')
}

// ---------- 7. 仓库形状 ----------
// 顶层文件集合是固定的：一次被 shell 吃掉的命令在工作区生成了一个以 JS 片段
// 命名的空文件，并被 `git add -A` 一起提交了。多出来的顶层文件就是误提交。
const EXPECTED_ROOT = new Set(['.gitignore', 'CHANGELOG.md', 'README.md', 'SKILL.md', 'cordis.patch.yml', 'package.json'])
const stray = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((file) => !file.includes('/') && !EXPECTED_ROOT.has(file))
if (stray.length) bad(`仓库顶层出现非预期文件（疑似误提交）: ${stray.join(', ')}`)
else ok('仓库顶层文件符合预期')

// 文档里的「当前版本」必须与 package.json 一致。审计发现 README 曾停在 v0.9.0
// 而 package.json/CHANGELOG/tag 都已是 0.10.x —— 旧守卫只交叉核对 CHANGELOG，
// 所以它一直是绿的。这里只认「当前版本」那一行，避免把历史版本号当错误。
for (const file of ['README.md', 'SKILL.md']) {
  const line = readFileSync(join(root, file), 'utf8')
    .split('\n')
    .find((candidate) => candidate.includes('当前版本'))
  if (!line) {
    bad(`${file} 找不到「当前版本」标注`)
    continue
  }
  const m = line.match(/v(\d+\.\d+\.\d+)/)
  if (!m) bad(`${file} 的「当前版本」行里没有 vX.Y.Z`)
  else if (m[1] !== pkg.version) bad(`${file} 写着 v${m[1]}，package.json 是 ${pkg.version}`)
  else ok(`${file} 当前版本与 package.json 一致 (v${pkg.version})`)
}

// ---------- 结果 ----------
console.log(notes.join('\n'))
if (failures.length) {
  console.log(failures.join('\n'))
  console.log(`\nverify: ${failures.length} 项失败`)
  process.exit(1)
}
console.log('\nverify: 全部通过')
