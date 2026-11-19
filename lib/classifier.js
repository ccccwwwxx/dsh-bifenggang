// dsh-peak-valley-router — message concreteness classifier (tier routing).
//
// 纯函数、零依赖、无状态：不读文件、不碰 host、不发请求，可单测/可试算。
// 输出：
//   { tier: 'low'|'mid'|'high', score: number|null, tierReason, reasons: id[],
//     features: id[](别名), thresholds, hysteresis }
//
// 档位：concreteness 越高越「具象执行」→ 低档；越低越「抽象」→ 高档。
//   score >= concreteThreshold → low
//   score >= mediumThreshold   → mid
//   否则                       → high
//
// 权重来源 docs/ROUTING_V2_DESIGN.md §4.3；本文件在 t13 重新校准了「执行 vs 抽象」
// 的合成方式与 command 的上下文判定（见 WEIGHTS 注释与 t13 报告）：
//   - 执行动词是显式锚点：带对象/祈使时权重远大于「无对象的动词」；
//   - command 只在命令行上下文（提示符行 / 代码块内整行 / 裸命令）触发，文件名与
//     标识符由 path/file/symbol 负责，不再误触发；
//   - 抽象词与执行动词同现时，抽象惩罚降到 −0.08（执行锚点占优），只有在
//     「明显在问原理」时才保持 −0.20；
//   - short-command 只用于「短、直接执行、没有具体文件/代码锚点」的请求，权重下调。
//
// 本模块不做「一次 turn 只判一次」的状态机（那是 lib/index.js 的接缝职责），也不读
// 配置总开关（tierRouting.enabled=false 时调用方不调用本模块，行为恒 low）。

export const DEFAULT_CONCRETE_THRESHOLD = 0.55
export const DEFAULT_MEDIUM_THRESHOLD = 0.28

// 特征权重（t13 校准后）。动态权重（verb/command/abstract）在 classify 内计算。
export const WEIGHTS = Object.freeze({
  code: 0.22,
  path: 0.18,
  command: 0.20, // +0.20 extra when the WHOLE message is a bare command（见 classify）
  symbol: 0.12,
  file: 0.06,
  // Execution verb. 0.30 when it has a concrete object (path/file/code/symbol/
  // command/target noun) or is imperative; 0.10 when it appears without one
  // ("帮我改一下" is a request, but not a concrete enough one).
  verb: 0.30,
  // Concrete object noun for an execution verb (eslint, 测试, 配置, README …).
  // Only counted when an execution verb is present, so an abstract question that
  // merely mentions "design"/"code" is not pushed down.
  target: 0.15,
  // Multi-step execution ("…并…", "…然后…", "and then"): a sequence of actions is
  // concrete work, not a design discussion.
  sequence: 0.08,
  'multi-question': -0.12,
  abstract: -0.20, // −0.08 when an execution anchor is present (see classify)
  long: -0.08,
  short: -0.05,
  image: 0.08,
  'mid-turn': 0.25,
  // Short, direct execution with no file/code anchor ("跑一下测试", "git status").
  // D4: 0.37 amplified command false positives; with command now context-gated the
  // bridge is much narrower, so it is lowered to 0.15.
  'short-command': 0.15,
})

// 特征检测只看前 12000 字符；override 只看前 4000 字符。
export const FEATURE_TEXT_LIMIT = 12_000
export const OVERRIDE_TEXT_LIMIT = 4_000
export const HYSTERESIS_WINDOW_MS = 10 * 60_000

// §4.4：在打分之前判定，优先级 safety > low-explicit > high-explicit。
// What judgement a dispatched task asks the member to deliver. The captain
// declares it in the task record; it replaces text scoring for that task:
//   execute    → follow the steps and record results (a failing command does not
//                escalate on its own) → low tier,
//   coverage   → judge coverage / find gaps against stated criteria → mid tier,
//   adjudicate → decide between conflicting evidence, decide acceptance, or design
//                a discriminating re-check → high tier.
export const JUDGEMENTS = ['execute', 'coverage', 'adjudicate']
export const TIER_FOR_JUDGEMENT = { execute: 'low', coverage: 'mid', adjudicate: 'high' }

const OVERRIDES = [  {
    id: 'override-safety',
    tier: 'high',
    reason: 'override-high-safety',
    pattern: /全项目|整个项目|所有文件|全部文件|批量|发布|上线|回滚|删库|迁移整个|重构整个|生产环境|所有测试|全量/i,
  },
  {
    id: 'override-low',
    tier: 'low',
    reason: 'override-low-explicit',
    pattern: /直接改|直接执行|快点|简单回答|别想太多|最短路径|just do it|quickly/i,
  },
  {
    id: 'override-high',
    tier: 'high',
    reason: 'override-high-explicit',
    pattern: /认真想|仔细想|深入思考|深入分析|想清楚|先规划|先给方案|给方案|评估一下|不要动手|先别改|设计一[下个]|think hard|plan first|认真评估/i,
  },
]

// 「在问原理」的标记：只有这类问题才让抽象词保持完整惩罚。
const PRINCIPLE_PATTERN = /为什么|为何|原理|该不该|优缺点|取舍|tradeoff|架构|设计思路|是否值得|值不值得|\bwhy\b/i
const POLITE_REQUEST = /帮我|帮忙|麻烦|请|please|pls/i
const ABSTRACT_PATTERN = /为什么|原理|设计|方案|评估|取舍|tradeoff|架构|对比|该不该|解释|总结|梳理|优缺点|\bwhy\b|\bdesign\b|\barchitecture\b|\bevaluate\b|\bcompare\b|\bexplain\b|\bsummarize\b|\breview the (design|approach)\b/i

const PATH_PATTERN = /[\w./\\-]+\.(?:ts|tsx|js|mjs|cjs|py|json|md|ya?ml|toml|ps1|sh|go|rs|java|c|h|css|html|sql)\b/gi

// Execution verbs. Split into "operations" (run/build/install/deploy …) and
// "edits" (modify/refactor/patch/review …) because only a short operation is
// unambiguous "just do it" work; a short edit still needs an anchor to be mid.
const OP_VERB_CN = /跑一遍|跑一下|跑下|跑个|跑|执行一下|执行|运行一下|运行|安装|卸载|装好|装|构建|编译|打包|部署|提交|推送|删除|删掉|删|移除|迁移|回滚|重启|启动|停止|拉取|下载|上传|生成|创建|新建|建立|测试/
const EDIT_VERB_CN = /修改|改|修复|修好|修|重构|重写|改写|补上|补充|补|替换|更新|升级|格式化|重命名|配置|设置|评审|检查|验证|排查|定位|查找|搜索|查|加上|加|新增|合并|整理/
const OP_VERB_EN = /\b(?:run|install|uninstall|build|setup|set up|execute|deploy|commit|push|delete|remove|migrate|rollback|restart|start|stop|pull|download|upload|generate|create|test)\b(?!\s*[(\u4e00-\u9fff])/i
const EDIT_VERB_EN = /\b(?:fix|refactor|rewrite|modify|add|rename|replace|update|upgrade|write|implement|configure|review|patch|adjust|format|merge)\b(?!\s*[(\u4e00-\u9fff])/i

// Compound nouns that contain a verb character but are not instructions.
const COMPOUND_NOUN_PATTERN = /运行日志|运行记录|运行时间|运行状态|执行结果|执行时间|执行过程|测试报告|测试结果|启动日志|构建产物|改动|变更|配置项|默认配置|配置文件|环境配置|配置管理/g

// Files without an extension still anchor an edit like a path (README/CHANGELOG).
const BARE_FILE_PATTERN = /\b(?:README|CHANGELOG|LICENSE|Dockerfile|Makefile|package-lock)\b/i

// A verb that leads the message ("跑一下测试", "Run the tests") is imperative; a
// polite prefix ("帮我改一下") still needs an object to count as concrete.
const IMPERATIVE_CN = /^(?:跑|执行|运行|安装|卸载|装好|装|构建|编译|打包|部署|提交|推送|删除|删掉|删|移除|迁移|回滚|重启|启动|停止|拉取|下载|上传|生成|创建|新建|建立|测试|修改|改|修复|修好|修|重构|重写|改写|补上|补充|补|替换|更新|升级|格式化|重命名|配置|设置|评审|检查|验证|排查|定位|查找|搜索|查|加上|加|新增|合并|整理)/

// Concrete object nouns that make an execution verb actionable.
const TARGET_CN = /测试|用例|配置|文件|目录|代码|脚本|命令|依赖|包|项目|仓库|分支|提交|构建|部署|日志|接口|数据库|函数|模块|组件|页面|样式|环境|版本|端口|服务|文档|报告|注释|类型|路由|插件|模型|报错|错误|异常|堆栈|输入|输出|参数|变量|字段|表|行|文件头|依赖项|告警|状态|缓存|开关|界面|前端|后端|存储|格式|策略|规则|层级|页面/
const TARGET_EN = /\b(?:tests?|suites?|configs?|configuration|files?|director(?:y|ies)|folders?|code|scripts?|commands?|dependenc(?:y|ies)|packages?|projects?|repos?(?:itory)?|branch(?:es)?|commits?|builds?|deploys?|logs?|apis?|database|db|functions?|modules?|components?|pages?|styles?|environments?|versions?|ports?|services?|docs?|documentation|reports?|comments?|types?|routes?|plugins?|models?|errors?|stacktrace|bug|readme|changelog|eslint|typescript|webpack|vite|jest|vitest|pytest|node_modules|cache|layers?|retry|queue|backend|frontend|ui|state|format|params?|parameters?|fields?|polic(?:y|ies)|rules?)\b/i

// Shell executables: a command only counts in a command context (prompt line,
// fenced code line, or a whole message that is just a command).
const EXECUTABLES = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'node', 'bun', 'deno', 'git', 'gh', 'dsh',
  'pytest', 'vitest', 'jest', 'cargo', 'go', 'python', 'python3', 'pip', 'pip3',
  'poetry', 'uv', 'tsc', 'docker', 'kubectl', 'make', 'gradle', 'mvn', 'dotnet',
  'bash', 'sh', 'pwsh', 'powershell', 'cd', 'ls', 'dir', 'cat', 'rm', 'del',
  'cp', 'copy', 'mv', 'mkdir', 'curl',
])

const SYMBOL_PATTERN = /`[A-Za-z_$][\w$.]*`|\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(|:\d{1,6}\b|\b(?:E[A-Z]{2,}|TS\d{4}|ENOENT|EADDRINUSE)\b|(^|\n)\s+at\s+\S+/
const MULTI_PATTERN = /(^|\n)\s*\d+[).、]\s|\-\s\[ \]|第一[，,、]|第二[，,、]|首先[\s\S]{0,40}其次/
const SEQUENCE_PATTERN = /然后|接着|并且|并(?!发)|同时|再(?!次)|and then|\bthen\b|,?\s+and\s+(?=[a-z])/i

function clamp01(value) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function thresholdOf(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// Strip fenced code blocks (their content must not contribute instruction verbs,
// but shell lines inside them are handled separately by commandFeature).
function stripFences(text) {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
}

function maskInlineCode(text) {
  return text.replace(/`[^`\n]*`/g, ' ')
}

function maskPaths(text) {
  // Replace globally; the regex carries the `g` flag.
  return text.replace(PATH_PATTERN, ' ')
}

function proseOf(text) {
  return maskInlineCode(maskPaths(stripFences(text))).replace(COMPOUND_NOUN_PATTERN, ' ')
}

function isExecutable(token) {
  const normalized = String(token || '').toLowerCase().replace(/^\.\//, '').replace(/^["']|["']$/g, '')
  return EXECUTABLES.has(normalized)
}

// §D2: commands are recognised by POSITION, never by a word appearing anywhere.
function commandFeature(text) {
  if (/(^|\n)\s*(?:\$|>|PS>)\s+\S/.test(text)) return { present: true, bare: true }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 1) {
    const line = lines[0]
    // A bare command is the whole message: no CJK prose, no question mark, short.
    if (!/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(line) && line.length <= 80 && !/[?？!！。;；]/.test(line)) {
      const tokens = line.split(/\s+/)
      if (tokens.length <= 8 && (isExecutable(tokens[0]) || /^\.\/\S+/.test(tokens[0]))) {
        return { present: true, bare: true }
      }
    }
  }
  let inFence = false
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (!inFence) continue
    const line = raw.trim().replace(/^\$\s+/, '')
    if (!line) continue
    const first = line.split(/\s+/)[0]
    if (isExecutable(first) || /^\.\/\S+/.test(first)) return { present: true, bare: false }
  }
  // An executable plus an ASCII subcommand inside prose ("执行 pnpm verify",
  // "运行 npm run build") is still a command invocation. The subcommand must be
  // ASCII so "npm 的 check 脚本" stays prose (D2).
  if (/\b(?:npm|pnpm|yarn|npx|node|bun|git|gh|dsh|pytest|vitest|jest|cargo|go|python3?|pip3?|tsc|docker|kubectl|make|gradle|mvn|dotnet)\s+[A-Za-z0-9][A-Za-z0-9./_-]*/i.test(text)) {
    return { present: true, bare: false }
  }
  return { present: false, bare: false }
}

/**
 * Strip a delivery prefix injected by an orchestrator before classification.
 *
 * AgentTeams delivers member/captain messages with a human-facing first line:
 *   "AgentTeams message from member <id>:\n\n<actual instruction>"
 * (see @nanmicoder/dsh-agent-teams members.js#steerCaptainReport). Other host
 * wrappers use "Agent <id> sent a message:". The prefix is routing metadata, not
 * user intent, and it would otherwise look like an abstract sentence. This is a
 * generic first-line rule — NOT a phrase feature of the classifier.
 */
export function stripDeliveryPrefix(text) {
  if (typeof text !== 'string' || text === '') return text
  const match = /^(?:AgentTeams\s+message\s+from\b[^:\n]{0,200}:|Agent\s+\S+\s+sent\s+a\s+message\s*:)[ \t]*\r?\n*/i.exec(text)
  return match ? text.slice(match[0].length) : text
}

/**
 * Extract the classification input from inbox messages.
 * Only `text` blocks contribute text; `image` / `file` blocks are markers.
 * Delivery prefixes are stripped per block so a prefixed AgentTeams message
 * classifies exactly like its bare body.
 */
export function collectFromMessages(messages) {
  const textParts = []
  const taskIds = []
  const declarations = []
  let hasImage = false
  let hasFile = false
  for (const message of Array.isArray(messages) ? messages : []) {
    // A dispatched team task carries its own record (taskId / subject /
    // description) on the message source. That is the routing input: the envelope
    // (assignment prose, quality contract, acceptance lists) stays in the member's
    // prompt but must not dilute the tier score. The taskId is kept so the decision
    // log can be cross-checked against the team's task record.
    const task = message?.source?.agentTeamsTask
    if (task !== undefined && task !== null && typeof task === 'object') {
      const subject = typeof task.subject === 'string' ? task.subject : ''
      const description = typeof task.description === 'string' ? task.description : ''
      if (subject !== '' || description !== '') {
        if (typeof task.taskId === 'string' && task.taskId !== '') taskIds.push(task.taskId)
        if (JUDGEMENTS.includes(task.judgement)) declarations.push({ taskId: typeof task.taskId === 'string' ? task.taskId : '', judgement: task.judgement })
        textParts.push([subject, description].filter((part) => part !== '').join('\n'))
        continue
      }
    }
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') textParts.push(stripDeliveryPrefix(block.text))
      else if (block?.type === 'image') hasImage = true
      else if (block?.type === 'file') hasFile = true
    }
  }
  return { text: textParts.join('\n'), hasImage, hasFile, taskIds, declarations }
}

/** Detect the first matching explicit override (§4.4). Returns null when none. */
export function findOverride(text) {
  const scope = typeof text === 'string' ? text.slice(0, OVERRIDE_TEXT_LIMIT) : ''
  for (const override of OVERRIDES) {
    if (override.pattern.test(scope)) return { id: override.id, tier: override.tier, reason: override.reason }
  }
  return null
}

function tierForScore(score, concrete, medium) {
  if (score >= concrete) return 'low'
  if (score >= medium) return 'mid'
  return 'high'
}

// Adjacent-tier hysteresis (§4.2): keep the previous tier when the score sits
// within ±0.05 of the boundary between two adjacent tiers and the previous tier
// is one of them. Overrides are never dampened.
function applyHysteresis(tier, score, previous, thresholds, now) {
  if (!previous || typeof previous.tier !== 'string' || !Number.isFinite(score)) return { tier, hysteresis: false }
  if (previous.tier === tier) return { tier, hysteresis: false }
  if (!Number.isFinite(previous.at) || now - previous.at > HYSTERESIS_WINDOW_MS) return { tier, hysteresis: false }
  const order = { high: 0, mid: 1, low: 2 }
  if (Math.abs(order[previous.tier] - order[tier]) !== 1) return { tier, hysteresis: false }
  const pair = [previous.tier, tier].sort()
  const boundary = pair[0] === 'high' ? thresholds.medium : thresholds.concrete
  if (Math.abs(score - boundary) > 0.05) return { tier, hysteresis: false }
  return { tier: previous.tier, hysteresis: true }
}

/**
 * Classify one routing decision's input.
 *
 * @param input  { text, hasImage, hasFile } | string
 * @param options { concreteThreshold, mediumThreshold, midTurn, previous, now }
 */
export function classify(input, options = {}) {
  const signals = typeof input === 'string'
    ? { text: input }
    : (input && typeof input === 'object' ? input : {})
  const thresholds = {
    concrete: thresholdOf(options.concreteThreshold, DEFAULT_CONCRETE_THRESHOLD),
    medium: thresholdOf(options.mediumThreshold, DEFAULT_MEDIUM_THRESHOLD),
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const fullText = typeof signals.text === 'string' ? signals.text : ''

  if (fullText.trim() === '') {
    return {
      tier: 'low',
      score: null,
      tierReason: 'tier-fallback-low',
      reasons: [],
      features: [],
      thresholds,
      hysteresis: false,
    }
  }

  const override = findOverride(fullText)
  if (override) {
    return {
      tier: override.tier,
      score: null,
      tierReason: override.reason,
      reasons: [override.id],
      features: [override.id],
      thresholds,
      hysteresis: false,
    }
  }

  const text = fullText.slice(0, FEATURE_TEXT_LIMIT)
  const prose = proseOf(text)
  const details = []

  // --- concrete anchors -------------------------------------------------------
  const indentedLines = text.split('\n').filter((line) => /^(?: {4}|\t)\S/.test(line)).length
  const hasCode = text.includes('```') || indentedLines >= 3
  if (hasCode) details.push({ id: 'code', weight: WEIGHTS.code })
  const hasPath = PATH_PATTERN.test(text) || BARE_FILE_PATTERN.test(text)
  PATH_PATTERN.lastIndex = 0
  if (hasPath) details.push({ id: 'path', weight: WEIGHTS.path })
  const command = commandFeature(text)
  if (command.present) {
    details.push({ id: 'command', weight: command.bare ? WEIGHTS.command + 0.20 : WEIGHTS.command })
  }
  const hasSymbol = SYMBOL_PATTERN.test(text)
  if (hasSymbol) details.push({ id: 'symbol', weight: WEIGHTS.symbol })
  if (signals.hasFile === true) details.push({ id: 'file', weight: WEIGHTS.file })

  // --- execution intent -------------------------------------------------------
  const opVerb = OP_VERB_CN.test(prose) || OP_VERB_EN.test(prose)
  const editVerb = EDIT_VERB_CN.test(prose) || EDIT_VERB_EN.test(prose)
  const hasVerb = opVerb || editVerb
  const hasTarget = hasVerb && (TARGET_CN.test(prose) || TARGET_EN.test(prose))
  // A target noun is only an EXTRA anchor when the sentence has no stronger one;
  // "改 lib/index.js 第 120 行" must stay mid (path + verb), not double-count.
  if (hasTarget && !hasPath && !hasCode && !command.present) details.push({ id: 'target', weight: WEIGHTS.target })
  const hasAnchor = hasPath || hasCode || hasSymbol || command.present || hasTarget || signals.hasFile === true
  let imperative = false
  if (hasVerb) {
    const trimmed = prose.trim()
    // Imperative = the verb itself leads the request ("跑一下测试", "Run the
    // tests"). A polite prefix ("帮我改一下") still needs an object to be concrete.
    imperative = IMPERATIVE_CN.test(trimmed)
      || /^(?:please\s+)?(?:run|install|build|setup|set up|execute|deploy|commit|push|delete|remove|migrate|rollback|restart|start|stop|pull|download|upload|generate|create|test|fix|refactor|rewrite|modify|add|rename|replace|update|upgrade|write|implement|configure|review|verify|check|patch|adjust|format|merge)\b/i.test(trimmed)
    details.push({ id: 'verb', weight: hasAnchor || imperative ? WEIGHTS.verb : WEIGHTS.verb / 3 })
  }
  if (opVerb && !hasPath && !hasCode && SEQUENCE_PATTERN.test(prose)) details.push({ id: 'sequence', weight: WEIGHTS.sequence })

  // --- abstract / shape -------------------------------------------------------
  const principle = PRINCIPLE_PATTERN.test(text)
  if (ABSTRACT_PATTERN.test(text)) {
    // D1: an execution anchor dominates a secondary abstract word ("run the tests
    // and summarize"), except when the message clearly asks about a principle.
    const dominated = hasVerb && (!principle || POLITE_REQUEST.test(text))
    details.push({ id: 'abstract', weight: dominated ? -0.08 : WEIGHTS.abstract })
  }
  const questionCount = (text.match(/[?？]/g) ?? []).length
  if (questionCount >= 2 || MULTI_PATTERN.test(text)) details.push({ id: 'multi-question', weight: WEIGHTS['multi-question'] })
  if (text.length > 1500) details.push({ id: 'long', weight: WEIGHTS.long })
  const hasPositive = details.some((detail) => detail.weight > 0)
  if (text.trim().length < 80 && !hasPositive) details.push({ id: 'short', weight: WEIGHTS.short })
  if (signals.hasImage === true) details.push({ id: 'image', weight: WEIGHTS.image })
  if (options.midTurn === true) details.push({ id: 'mid-turn', weight: WEIGHTS['mid-turn'] })

  // Short direct EXECUTION (run/install/build/…) with no file/code anchor: the
  // cheap tier. A short scoped EDIT ("把 build 脚本补一下") stays mid, and a pure
  // principle question ("为什么这个测试跑不过") is never pushed down by it.
  const executionAnchor = opVerb || command.present
  const short = text.trim().length < 80
  if (short && executionAnchor && !editVerb && !hasPath && !hasCode && !hasSymbol && !signals.hasFile
    && (!principle || POLITE_REQUEST.test(text))) {
    details.push({ id: 'short-command', weight: WEIGHTS['short-command'] })
  }

  const raw = details.reduce((sum, detail) => sum + detail.weight, 0)
  const score = Math.round(clamp01(raw) * 10_000) / 10_000
  const rawTier = tierForScore(score, thresholds.concrete, thresholds.medium)
  const damped = applyHysteresis(rawTier, score, options.previous, thresholds, now)
  const tier = damped.tier
  return {
    tier,
    score,
    tierReason: `tier-${tier}`,
    reasons: details.map((detail) => detail.id),
    features: details.map((detail) => detail.id),
    thresholds,
    hysteresis: damped.hysteresis,
  }
}
