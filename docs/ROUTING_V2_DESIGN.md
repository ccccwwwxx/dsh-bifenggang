# 避峰岗 0.16.0 契约设计 v2：三档模型 + 每档峰谷表 + 成本决策 + 分级判定

> 状态：**施工契约（可直接照做）**。本文与 `docs/RESEARCH_ROUTING.md` 冲突时，**以本文为准**（调研文档的 §7.1 决策顺序是按 `agent/pre-step` 改模型写的，已被 0.2.2-rc.1 的硬校验判死）。
>
> 读者：t5（配置/成本）、t6（分级）、t7（GUI）、t8（告警）、t9（同步）、t10（独立验证）、t11（发布验收）。
>
> 硬前提：**本机桌面端 0.14.0，内置核心包 `@deepseek-ai/dsh-agent` / `dsh-agent-loop` / `dsh-llm` 均为 0.2.2-rc.1**。不是 README 里核过的 0.2.0-rc.2 / 0.2.1-rc.2。本文所有接缝结论都来自 0.2.2-rc.1 的真源码（提取方法见 §0.2），换核心版本必须重核 §1。
>
> 写域：本任务只写 `docs/`。本文中的 `lib/`、`src/` 改动是给下游任务的施工清单，不是本任务已改的文件。

---

## 0. 硬前提、证据与术语

### 0.0 十行摘要（施工者先读）

1. **唯一写入口**：`agent.model.select()`；调用点只有 `agent/inbox/inserted`（空闲首步/中途接管）与 `agent/turn-stopping`（排队的下一 turn）。`agent/request` 只读、原样返回。
2. **select 前同步校验**：provider 已注册 + 模型目录已热且包含 + 显式 effort 已热且支持；任一「不在/未知」都**不 select**（fail-safe），记可见告警。
3. **一次 turn 只判一次**：首步判定后冻结；steer 不重判；排队 next-turn 在 turn-stopping 判。
4. **优先级定死**：baseline@max → advanced；否则 `tierRouting.enabled ? 三档 : low`；再按该档 `costRouting` + 峰谷表选 peak/valley。
5. **配置 v2**：`targets.low/mid/high`（mid/high 默认 `share:'low'`）、每档 `valley/peak/costRouting`、`tierRouting.enabled=false`、根级 `holidays/utcOffsetMinutes`。
6. **迁移**：low←strategies[0]（含 peak）、high←advancedSupport、mid←share low、tierRouting 关；v1 文件只读不写，保存时才迁移并备份。
7. **现状等价**：默认 `peak.enabled=false` + `tierRouting=false` → 全周 low，与 0.15 行为一致。
8. **告警**：`get.warnings` 内下发（红/黄），配置修好或目录恢复后自动清除；不阻塞请求（不 select 而已）。
9. **同步**：state.json v2 per-key `updatedAt` + tombstone + 锁 + 读改写合并；policy.json revision + `expectedRevision`；Node `fs.watch` + 客户端 3 秒轮询。
10. **兼容**：peer 显式加 `^0.2.2-rc.1`（保留旧线）；桌面端 peer 是 advisory，真正的坑是「generation 切了但进程没重启」——验收必须冷启动，用 `apply: v0.16.0` + `get.version` + `host.modelSelect` 判定。

### 0.1 三条会炸的结论（先看这个）

1. **`agent/request` 不能再改写任何字段。** 0.2.2-rc.1 的 `prepareRequest()` 在 waterfall 返回后逐字段比较 `provider` / `model` / `reasoningEffort`，只要与步骤准备时固定的 `selection` 不同就 **throw**：
   `agent "…": agent/request proposed "x/y" after step preparation fixed "a/b"; use agent.model.select() before step preparation`
   证据：`dsh-agent-loop/lib/index.js:986-1016`（比较在 `:1000-1001`）。0.15.0 的 `agent/request` 改写（`lib/index.js:699-746`）只要目标 ≠ 会话模型就会撞上它。
2. **改模型只能走 `agent.model.select()`，且必须在步骤准备之前。** `select()` 的语义是「从下一个尚未开始准备的步骤生效」；`preStep()` 里 `const selection = this.model.current()` 在 dispatch `agent/pre-step` **之前**（`:666-713`，`current()` 在 `:671`），所以 pre-step 改不到本步。唯一稳定的公开挂点是 **`agent/inbox/inserted`**（用户消息进入 inbox 时，`ReactLoopInbox.mutate()` 同步 emit，`:200`，且在 `wakeDriver()` 之前，`:564-569`）。
3. **`select()` 是持久副作用，不是临时覆盖。** `AgentModel.select()` 往会话日志 append `model/selection`（`dsh-agent/lib/types/model-selection.js:88-92`），会话模型选择器会显示它、重开/重启后仍是它。插件必须记录「介入前的选择」并提供恢复路径（§1.6）。

### 0.2 证据怎么复现（给 t10/t11）

```powershell
# 1) 桌面端版本（0.14.0）
node asar-tool.mjs extract "C:/Users/29805/AppData/Local/Programs/DSH Desktop/resources/app.asar" package.json .recon014-asar-package.json

# 2) 核心包版本（0.2.2-rc.1）与源码
$out = Join-Path $env:TEMP 'dsh-core-022rc1'
foreach ($pkg in @('dsh-agent','dsh-agent-loop','dsh-llm','dsh-agent-default-model','dsh-session')) {
  node asar-tool.mjs extractDir "C:/Users/29805/AppData/Local/Programs/DSH Desktop/resources/app.asar" "node_modules/@deepseek-ai/$pkg/" "$out/$pkg"
}
Get-Content "$out/dsh-agent/package.json" | Select-String '"version"'   # 0.2.2-rc.1
```

下面所有 `文件:行` 都相对该 0.2.2-rc.1 提取目录。版本一变，行号会漂，**必须重新核对**（t10 第 4 条）。

### 0.3 术语

| 术语 | 含义 |
|---|---|
| 档位 / tier | `low`（具象执行）/ `mid`（中等）/ `high`（抽象） |
| 峰谷表 | 每档的 `valley`（谷时目标）与 `peak`（峰时目标）+ 峰时窗口/星期 |
| 成本决策路由 | 该档 `costRouting=true` 时，峰时窗内用 `peak`、否则用 `valley`；`false` 时恒用 `valley` |
| 分级路由 | 按用户消息的「具象度 concreteness」选档；总开关 `tierRouting.enabled`，默认 false |
| 生效目标 | 最终传给 `agent.model.select()` 的 `{provider, model, reasoningEffort?}` |
| 原模型 / baseline | 插件介入前用户的选择（`restore`），用于 max 判定与恢复 |
| 用户消息 | `message.source.kind === 'user'` 的 inbox 消息；注入上下文、notice 不算 |

---

## 1. (A) 路由生效接缝

### 1.1 结论：单一路由写入口

0.16.0 **只有一处**能改变模型：`agent.model.select()`，且只在下面三个时机调用：

| 时机 | 事件 | 为什么在这里 |
|---|---|---|
| 空闲 agent 收到用户消息（即将开新 turn） | `agent/inbox/inserted`（同步） | 监听器返回后 `wakeDriver()` 才跑 `preStep()`，`current()` 读到的就是我们的目标 |
| 运行中 agent 收到 steer（当前 turn 的下一步） | `agent/inbox/inserted`（同步） | 若本 turn 尚无判定则「中途接管」，否则冻结（§4.2） |
| turn 即将结束、且有排队的下一 turn 消息 | `agent/turn-stopping`（serial） | 此时到下一个 `turn()` 开始之间没有别的挂点；`select()` 能赶在下一 turn 的 `current()` 前生效 |

**不再有**任何在 `agent/request` 里改写 provider/model/effort 的代码；`agent/request` 监听器只做**只读观察**并原样返回（§1.7）。`internal/get` 对 `agentDefaultModel` 的拦截**保留**（新会话默认/选择器预览），但它不是权威路由，且失败必须 fail-open（§1.8）。

**作用对象**：所有带 `agent.model` 的活 agent（含 subagent），不区分主/子。公开 `Agent` 没有可靠的「主/子」字段，强行区分只能靠私有信息。subagent 的 task prompt 通常具象 → 落 low，符合直觉；如果用户要 subagent 完全不路由，后续再加 `scope` 配置（本期不做）。

### 1.2 时序（逐帧）

```
空闲 followup：
  handle.followup(msg)
    -> ReactLoopAgent.send(msg,'next-turn',true)
      -> inbox.splice(...)                      # session.append('agent/inbox/spliced')
        -> emit 'agent/inbox/inserted' {message}   # ★ 我们的 select() 在这里
      -> wakeDriver()
        -> kick() -> turn() -> preStep()
          -> claim inbox（含 msg）
          -> const selection = model.current()      # ★ 已经看到我们的选择
          -> tools.resolve / assemble / dispatch 'agent/pre-step'
          -> step() -> prepareRequest(selection)   # agent/request 只读；比较通过

运行中 steer：
  handle.steer(msg) -> send(msg,'next-step',true)
    -> splice -> emit inserted                 # 若本 turn 无判定：中途接管；否则冻结
    -> wakeDriver() 发现 phase.running -> 返回
    -> 当前 step 结束后的下一 step 的 preStep() 才 current()  # select 对「下一未准备步骤」生效

排队 followup（agent 在跑）：
  send(msg,'next-turn',true) -> inserted       # 不在此时 select（会污染当前 turn 的后续 step）
  ...当前 turn 收尾...
  turn(): turnEnds 且 nextStep 空 -> serial 'agent/turn-stopping'   # ★ 在这里为排队的 nextTurn 决策并 select
  -> 新 turn -> preStep() -> current() 已是新目标
```

> **inbox 监听器必须是同步的。** 不要写成 async、不要 `await`、不要 `setTimeout`/`queueMicrotask` 推迟 select。原因：`wakeDriver()` 里的 `kick() -> turn() -> preStep()` 同步执行到 `const selection = this.model.current()`（`dsh-agent-loop/lib/index.js:671`）才遇到第一个 await（`tools.resolve`），中间没有事件循环空隙；任何推迟都赶不上本 turn 的首步，表现为「第一条永远不生效」。`turn-stopping` 监听器可以是 async（`dispatch.serial` 会 await），但其中的 select 也必须在返回前完成。

### 1.3 `select()` 前必须做的可用性校验（同步）

`select()` 本身**不校验**能力（`dsh-agent/README.zh.md:50`：「调用方负责校验可用性与能力」）。0.2.2-rc.1 的 `llm.prepareCall()` 会在 step 内校验并可能抛 `NO_ADAPTER` / `UNSUPPORTED_REASONING_EFFORT`（`dsh-llm/lib/index.js:2181-2205, 2227-2245`），所以校验必须发生在 select 之前，否则就是把一个坏目标写进会话再让回合失败。

**同步校验器**（`lib/catalog.js`）：

```js
// providers: Set<string> | null    —— llm.listProviders() 同步读，null=读不到
// models:    Map<provider, {ids:Set<string>, at:number}>  —— 后台 listModels() 预热，TTL 60s
// efforts:   Map<"p/m", {ok:boolean, efforts:Set<string>|null, at:number}> —— resolveModelInfo() 预热，TTL 5min

export function validateTargetSync(target) {
  if (!target?.provider || !target?.model) return { ok: false, kind: 'missing' }
  const providers = catalogProviderIds()                 // 同步；失败 -> null
  if (providers === null) return { ok: 'unknown', kind: 'catalog-unreadable' }
  if (!providers.has(target.provider)) return { ok: false, kind: 'provider' }
  const entry = modelCache.get(target.provider)
  if (!entry || Date.now() - entry.at > MODEL_CATALOG_TTL_MS) return { ok: 'unknown', kind: 'catalog-cold' }
  if (!entry.ids.has(target.model)) return { ok: false, kind: 'model' }
  if (target.reasoningEffort) {
    const e = effortCache.get(`${target.provider}/${target.model}`)
    if (!e || !e.ok || Date.now() - e.at > EFFORT_TTL_MS) return { ok: 'unknown', kind: 'effort-cold' }
    if (e.efforts && !e.efforts.has(target.reasoningEffort)) return { ok: false, kind: 'effort' }
  }
  return { ok: true }
}
```

规则（**与 t5 对齐：不可用/未知都不改，fail-safe**）：

1. **provider 已注册**：`llm.listProviders()` 里有它（排除本插件自身 id，沿用 `SELF_PROVIDER_IDS`）。
2. **模型在目录里**：该 provider 的模型缓存必须已预热且未过期，并且包含该模型。
   - 缓存冷/过期/该 provider 拉取失败 → `unknown` → **不 select**，记 `unverified` 告警（黄，info 级），后台刷新后下一条消息再试。
   - 缓存热且没有该模型 → `invalid` → 不 select，记 `model` 告警（红）。
3. **思考档**：只对配置里出现的 `(provider, model)` 预热 `llm.resolveModelInfo()`。目标带显式 `reasoningEffort` 时，effort 缓存也必须已预热：**已知不支持** → 不 select（红）；**缓存冷/查询失败** → `unknown` → 不 select（黄）。目标不带 effort（=适配器默认）→ 不检查。`resolveModelInfo` 持续失败的目标视为「不可验证」，不路由；目录刷新/`set` 会重试。用户想绕过这个限制，把该目标的 effort 设为「默认（空）」即可（只校验 provider/model）。
4. **llm 不可用 / providers 读不到** → `unknown` → 不 select，记 `llm-unavailable` 告警；不阻塞会话。
5. 预热触发：`apply`、`llm/adapters-updated`、开关打开、`set` 保存、`toggle` 打开。**预热永不在 inbox 同步路径上 await**（沿用现有 `refreshModelCatalog` 的后台刷新模式）。
6. 冷启动代价：apply 后第一条消息可能因缓存未热而「不路由」（可见 info 告警）；这是 fail-safe 的代价，比把一个坏目标写进会话再炸回合好。预热通常在一次 `listModels` / `resolveModelInfo` 往返内完成。

### 1.4 失败回落链（固定，不许自由发挥）

```
候选目标（唯一一个，来自 §3）
  ├─ agent.model.current() === undefined
  │    -> 记录 no-current 告警；不 select（没有可恢复/可比较的基线）
  └─ validateTargetSync(target)
       ├─ ok                -> agent.model.select(target)  【总是调用，核心自己去重】
       │                       changed = !sameSelection(previousCurrent, target)
       │                       outcome = changed ? 'selected' : 'noop-same'
       ├─ unknown（目录/effort 冷，llm 不可用）
       │    -> 记录 unverified 告警（黄，info）；【不 select】；保持 current；后台刷新；下一条消息再试
       ├─ invalid（provider/model/effort 真不可用）
       │    ├─ 目标来自普通档位且 tier !== low
       │    │    -> 尝试 resolveTargets(cfg).low 的 valley 目标：
       │    │         ├─ ok      -> select(low)，fallback='low'，红告警保留（t6：失败回退 low）
       │    │         └─ 不可用  -> 不 select，保持 current，红告警
       │    ├─ 目标来自 low 档或来自 advanced(max)
       │    │    -> 不 select，保持 current，红告警（max 不回退 low：不静默降质）
       └─ 通过校验后仍在 step 内失败（只可能是预热后适配器能力变化）
            -> agent/request-error 观察器记录 request-failed 告警（下一次 get 可见）
select() 抛错（session append 失败等）
  -> catch；记录 select-failed 告警；不重试；本 turn 保持 current（preStep 已读到旧值则本步用旧值）
```

> **回退矩阵的取舍**：t6 明确要求「分级异常/失败 → 回退 low」；t5/t8 要求「目录不可用/未知 → 不改」。本文把两者落成：
> - **未知**（目录/effort 未热、llm 不可用）→ 不改（fail-safe，下一条消息重试）；
> - **真不可用**（目录已热、明确没有）且来自 high/mid → 回退 **low.valley**（省钱、能跑），红告警保留；
> - **low 自身不可用** / **max 的 advanced 不可用** → 保持 current（max 不回退 low，避免静默降质）；
> - **select 抛错** → 保持 current（换 low 也会抛，无意义）。
> 这是唯一允许的「改道」；不允许 peak↔valley、advanced→档位、restore 的自动改道（§12）。

> 为什么 `current == target` 仍要调用 `select()`：`AgentModel.select()` 只在「与**已记录**选择相同」时去重（`model-selection.js:88-92`）。如果会话还没有 `model/selection` 事件，`current()` 回退到 `agent.options`，此时 `select({...同 options})` **会** append 一条记录（README：「仅与初始 options 相同仍会记录」）。插件不掌握 `recordedSelection`，所以不要自己猜「是否已记录」；统一调用 `select()`，让核心决定是否落事件。`changed` 只用于日志/GUI 说明「视觉上是否切换」。

### 1.5 「插件改写会话已记录模型」的副作用边界

`select()` 的副作用（必须写进 README/CHANGELOG）：

| 会改 | 不会改 |
|---|---|
| 该会话的持久 `model/selection`（`pending` → 下一次 `request/header` 转 `lastUsed`） | 部署默认模型（`agentDefaultModel` 的配置）——除非 `internal/get` 默认层也命中（§1.8） |
| 会话模型选择器显示、重开/重启后的选择 | 其它会话、其它 agent |
| 下一次步骤的 `request/header.config` | provider/适配器配置、凭据、价格 |
| 若 agent preset 装了 `installModelSelection`，跨模型时下一步会多一条 `[model changed: …]` 用户可见 notice（`model-selection.js:101-137`） | 会话历史里已生成的内容 |

**归因缺口**：`model/selection` 事件没有 source/author 字段（`toSelection` 只写三元组，`model-selection.js:11-13`），插件无法区分「用户手选」和「自己选的」。采用调研 §0.1B 的启发式：

```
current = agent.model.current()
if  current 等于 lastApplied            -> 是我们上次选的，继续
else if current 等于 restore            -> 用户手动改回了原模型，视为外部选择：以 current 为新 baseline
else                                     -> 外部（用户/其它插件）选择：以 current 为新 baseline，本 turn 不再覆盖
```

外部选择时更新 `restore = current`、`lastApplied = null`，记 `external-selection` 日志。用户选择优先，绝不和用户抢。

### 1.6 恢复策略（必须实现）

**数据**（`state.json` 每会话条目，§6.1）：

```json
{ "enabled": true, "updatedAt": 1795010000000,
  "restore": { "provider": "deepseek-official", "model": "deepseek-chat", "reasoningEffort": "high" },
  "applied": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low" },
  "restorePending": false }
```

**规则**：

1. 首次介入前记录 `restore = agent.model.current()`（只在 `restore` 为空时写；之后只有外部选择才更新）。
2. `applied = 本次 select 的目标`（即使 `select()` 因相同而 no-op，也记 `applied`，但 `restore` 保持不变）。
3. 关闭开关 / 会话解耦 / `inherit` 且默认关 / 插件 dispose：
   - 该 agent 活着：若 `current` 等于 `applied` → `select(restore)`；否则不动（用户已改）。
   - agent 不在：置 `restorePending=true`；下次该会话出现（`agent/created` 或 `inbox/inserted`）且开关仍关时，若 `current == applied` → 恢复一次并清标记。
4. 设置页「恢复原模型」：RPC `restore({sessionId})`，语义同 3（用户显式要求，即使用户改过也按 `restore` 恢复；恢复后清 `applied`）。
5. 恢复本身也会 append `model/selection` 并可能触发 notice；接受，并记 `restore:` 日志。
6. 0.15.0 没有持久 `restore`：升级后第一次介入时 `current()` 可能是 0.15 路由后的模型。此时把它当 baseline 是唯一可得的事实；GUI 明示「升级前已被路由的会话，原模型可能已丢失，可手动选择或点恢复」。

### 1.7 观察面（只读，绝不改本步）

| 事件 | 监听方式 | 用途 |
|---|---|---|
| `agent/request` | `ctx.on(..., async (payload,next) => { const c = await next(); observeRequest(payload,c); return c }, {global:true})` | 记录**实际生效**的 config；回归断言逐字段不变 |
| `agent/pre-step` | `ctx.on(..., async (payload,next) => { const d = await next(); observePreStep(payload); return d }, {global:true})` | 记录 `modelSelection` / `turn` / `step`，与 `expected` 对比；**不 select** |
| `agent/request-error` | `ctx.on(..., (payload,next) => { observeError(payload); return next() }, {global:true})` | 记录 prepareCall/请求失败，关联到本轮告警（可选，t8 可后置） |

`observePreStep` 只读 payload：`{agent, messages, turn, step, signal, modelSelection}`（`dsh-agent-loop/lib/index.js:685-689`）。`observeRequest` 的 payload 只有 `{agent, turn, step, signal}`，config 是 `next()` 的返回值。

### 1.8 `internal/get` 默认模型层（保留，但降级为「预览」）

- 保留现有 `internal/get` → `agentDefaultModel` 包装（`lib/index.js:500-516`），用于**新会话的默认/选择器预览**。t5 要求保留；它对已经存在的会话没有权威性。
- 默认层**不做分级**（没有消息文本）：固定按 `low` 档 + 该档峰谷表解析；`max` 与三档在首条消息的 `select()` 里决定。这样新会话的预览与「默认全走低档」一致。
- 例外：`base.currentSelection()` 显式要求 `reasoningEffort === 'max'` 时，默认层**不覆盖**（保留 base）——否则会把用户显式设置的 max 默认冲掉，max 轴永远不生效。首条消息的 baseline = current = max → 走 advanced（§4.5）。
- 包装内同样做 `validateTargetSync`：目标不可路由 → 回落 `base.currentSelection()` 并记录告警；`enabled=false` 或 `base` 不存在 → 原样返回。
- **不改** `agentDefaultModel.saveSelection`，不写 profile。
- 启动时探测一次：`hostSeams.defaultSeam = true/false`。若 0.2.2-rc.1 下未收到 `internal/get`（或 `name !== 'agentDefaultModel'`），只记 `host: default-seam missing`，路由不受影响（权威路径是 select）。t5 必须实测这一点，把结果写进 CHANGELOG。

### 1.9 接缝伪代码（可直接落 `lib/index.js`）

```js
export const inject = ['llm']                 // 不新增硬依赖；agents 用 ctx.get('agents') 可选

export function apply(ctx, config) {
  // ...load policy/state/catalog（沿用现有）...

  ctx.on('agent/inbox/inserted', (payload) => {
    const { agent, message } = payload || {}
    if (!agent || !message) return
    try { onInboxInserted(agent, message) }
    catch (error) { warnThrottled('inbox-failed', error) }
  }, { global: true })

  ctx.on('agent/turn-stopping', async (payload) => {
    const agent = payload?.agent
    if (!agent) return
    try { onTurnStopping(agent) }
    catch (error) { warnThrottled('turn-stopping-failed', error) }
  }, { global: true })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try { observePreStep(payload, decision) } catch {}
    return decision
  }, { global: true })

  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try { observeRequest(payload, config) } catch {}
    return config                             // ★ 逐字段原样返回
  }, { global: true })

  // 卸载/关闭时尽力恢复
  ctx.effect(() => () => { try { restoreAllLiveAgents('dispose') } catch {} })
}

function onInboxInserted(agent, message) {
  maybeRestorePending(agent)                  // 开关已关 + 上次没机会恢复 -> 先恢复一次
  if (!enabledFor(agent)) return
  if (message.source?.kind !== 'user') return
  if (typeof agent.model?.select !== 'function') { recordWarning(agent, 'host-unsupported'); return }

  const b = turnBoundaryOf(agent.session)     // 实现：lazy ctx.get('agents')?.turnBoundaryOf?.(agent.session)
  if (!b) return
  const where = locatePending(agent, message.id)   // 在 agent.inbox.nextTurn / nextStep 里找
  if (!where) return

  if (where === 'next-step') {
    if (b.openTurnStartSeq === null) return
    if (decisionFor(agent, b.lastTurn)) return       // 本 turn 已判定 -> 冻结
    decideAndSelect(agent, { turn: b.lastTurn, messages: userTexts(agent.inbox.nextStep), midTurn: true, via: 'steer-adopt' })
    return
  }

  // next-turn
  if (b.openTurnStartSeq !== null) return            // 当前 turn 在跑：等 turn-stopping
  decideAndSelect(agent, { turn: b.lastTurn + 1, messages: userTexts(agent.inbox.nextTurn), via: 'inbox' })
}

function decideAndSelect(agent, req) {
  // 1) 外部选择检测：current 既不是 applied 也不是 restore -> 用户/其它插件改过
  //    更新 restore=current、applied=null，基线与判定都用 current（§1.5）
  refreshBaselineFromCurrent(agent)
  // 2) 用 §3/§4 的纯函数算 decision（max -> tier -> cost）
  const decision = decide({ agent, cfg, state, now: new Date(), ...req })
  // 3) 记 decision（即使 disabled/unverified 也要可用于 GUI）
  rememberDecision(agent, decision)
  if (decision.outcome === 'disabled') return
  // 4) 校验 + select（§1.4）
  applyDecision(agent, decision)
}

function onTurnStopping(agent) {
  if (!enabledFor(agent) || typeof agent.model?.select !== 'function') return
  if (agent.inbox.nextStep.length > 0) return       // 别的监听器把本 turn 续上了，别为下一 turn 选
  const pending = userTexts(agent.inbox.nextTurn)
  if (pending.length === 0) return
  const b = turnBoundaryOf(agent.session)
  decideAndSelect(agent, { turn: (b?.lastTurn ?? 0) + 1, messages: pending, via: 'turn-stopping' })
}
```

> `agent/turn-stopping` 是 serial 事件，且**允许其它监听器 `steer()` 把本 turn 续开**（README）。我们的监听器**不要 prepend**（让已有监听器先跑），并在进门时检查 `nextStep.length > 0` → 放弃本次决策。这样不会把「为下一 turn 选的目标」误用到当前 turn 的下一步。

> `turnBoundaryOf` 用 **lazy 解析**：每次取 `ctx.get('agents')`（找到后缓存引用），拿不到就跳过本次决策（不 throw、不阻塞）。`agent.model.select` 用**逐 agent** 探测（不要只信进程级缓存）。

> **会话身份**：`sessionIdOf(agent) = agent?.session?.header?.id ?? agent?.id`（优先 session header；`agent.id` 作兼容回退，沿用 0.14 的修复）。`enabledFor(agent)` = `state.sessions[sessionId]?.enabled ?? state.enabled`（`null` = 跟随默认）。所有 state 键、warning、decision、restore 都用这个 id。

**注意**：`locatePending` 只读 `agent.inbox.nextTurn` / `nextStep`（`ReactLoopInbox` 的 getter，`dsh-agent-loop/lib/index.js:79-91`；`dsh-agent/README.zh.md:104` 也把 `nextTurn/nextStep` 写成公开结构）。`turnBoundaryOf` 在 0.2.2 存在（`dsh-agent/lib/index.js:486`；投影定义 `lib/types/projection.js:14-52`）；0.2.0 已确认**没有**（`.recon-b` 的 `dsh-agent` 无该 API），0.2.1 未核、按「没有」做能力探测。那两条线本来也没有 `agent.model`（0.2.0 的 `model-selection.js` 没有 `AgentModel` 类），所以不构成回归路径，见 §9.3。

---

## 2. (B) 配置 schema v2

### 2.1 完整示例（新装默认值，`lib/text.js` 的 `DEFAULTS`）

```json
{
  "schemaVersion": 2,
  "revision": 1,
  "utcOffsetMinutes": 480,
  "holidays": [[2026,10,1],[2026,10,2],[2026,10,3],[2026,10,4],[2026,10,5],[2026,10,6],[2026,10,7],[2026,10,8],[2027,1,1],[2027,1,2],[2027,1,3]],
  "tierRouting": {
    "enabled": false,
    "concreteThreshold": 0.55,
    "mediumThreshold": 0.28
  },
  "targets": {
    "low": {
      "valley": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low" },
      "costRouting": true,
      "peak": {
        "enabled": false,
        "weekdays": [1,2,3,4,5,6,7],
        "windows": [["09:00","12:00"],["14:00","18:00"]],
        "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low"
      }
    },
    "mid":  { "share": "low" },
    "high": { "share": "low" }
  },
  "advancedSupport": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "max" }
}
```

- **默认三档共用低档配置**：`mid`/`high` 只存 `{ "share": "low" }`，路由时解析成 low 的整张表（含 `valley`、`peak`、`costRouting`）。
- `advancedSupport` 仍是独立的 max 轴，**不是**未命中的兜底。
- `revision` 只用于 GUI 冲突检测（§6.2）；手工编辑可省略。
- **成本决策默认开启，但默认不切峰**：`costRouting=true` 是每档默认（任务要求）；新装 `peak.enabled=false`，所以 0.16.0 默认行为仍是「全周谷时 = DeepSeek Flash low」，与 0.15.0 等价。用户必须显式启用峰时并配置峰时目标才会切峰。

### 2.2 字段表

| 路径 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `schemaVersion` | 2 | 2 | 写死；读 v1 时缺失 |
| `revision` | 非负整数 | 1 | 服务端维护；`set` 冲突用 |
| `utcOffsetMinutes` | 整数 | 480 | -840..840；只影响时间解释，不改系统时区 |
| `holidays` | `[y,m,d][]` | 见上 | 每项 3 个整数；年 2000..2100；月 1..12；日 1..31；去重排序 |
| `tierRouting.enabled` | bool | **false** | 总开关；false → 恒 `low`（§4.5） |
| `tierRouting.concreteThreshold` | 0..1 | 0.55 | 必须 > `mediumThreshold`；`c >=` 它 → low |
| `tierRouting.mediumThreshold` | 0..1 | 0.28 | `mediumThreshold <= c < concreteThreshold` → mid；`c <` 它 → high |
| `targets.low.valley` | 模型三元组 | flash@low | provider/model 必填 |
| `targets.low.peak` | 对象 | 见上 | `enabled`、`weekdays[1..7]`、`windows[[HH:MM,HH:MM]]`、三元组 |
| `targets.low.costRouting` | bool | **true** | 每档可关；false → 恒 valley |
| `targets.mid/high.share` | `"low"` \| null | `"low"` | 只允许 mid/high；low 不允许 share；share 时其余字段被忽略（规范化输出会删掉） |
| `targets.mid/high.valley/peak/costRouting` | 同上 | — | 仅当 `share` 为空时生效 |
| `advancedSupport` | 模型三元组 | flash@max | **必填**（保留 0.15 不变式）；只用于 max |

**窗口约束**：`HH:MM` 24 小时制；`start < end`（**不允许跨午夜**，跨午夜请拆两段；这是 0.15 的既有语义，见 §12 的明确不做）；同档窗口可重叠，命中任意一段即峰时。时间边界：**start 含、end 不含**（`12:00` 不是峰时）。

**模型三元组**：`{ provider: string(非空), model: string(非空), reasoningEffort?: string }`。`reasoningEffort` 缺省 = 适配器默认（`select()` 不继承旧值，`dsh-agent/README.zh.md:50`；GUI 必须显示「默认（适配器）」而不是悄悄沿用旧档）。

### 2.3 规范化算法（`lib/routing.js#normalizeConfig`）

输入 → 输出必须是**确定性**的；`set` 严格抛错（GUI 显示），加载时捕获并回落 DEFAULTS（现有行为保留）。

```
normalizeConfig(input):
  1. 若 input.targets 存在 -> v2；否则若 input.strategies 存在 -> migrateV1；否则 -> DEFAULTS
  2. 逐字段类型校验；非法 -> throw ConfigError(code, path, message)
  3. targets:
       low: 必须完整（valley + peak + costRouting）；缺失 -> throw（加载时改用 DEFAULTS）
       mid/high: 有 share -> 规范化为 {share:'low'}；无 share -> 必须完整
       共享解析：resolveTargets(cfg) = low 原样；mid/high = 若 share 则深拷贝 low，否则自身
  4. tierRouting: 数值范围 + concrete > medium；否则 throw
  5. holidays: 去重 + 按 (y,m,d) 升序
  6. advancedSupport: provider/model 必填；缺 -> throw（保持 0.15 契约）
  7. 输出 canonical v2（丢弃未知字段；保留 input.revision 由调用方覆盖）
```

`get` RPC 同时返回 `config`（canonical）与 `effective`（`resolveTargets` + 解析后的三元组），GUI 只渲染 `effective`，保存时提交 canonical（共享档只提交 `{share:'low'}`）。

### 2.4 v1 → v2 迁移矩阵（逐字段写死）

| v2 字段 | v1 来源 | 规则 |
|---|---|---|
| `low.valley` | `strategies[0].primary` | 原样 |
| `low.peak.enabled` | `strategies[0].peak.enabled` | 原样（缺省 false） |
| `low.peak.weekdays` | `strategies[0].weekdays` | 原样（缺省 `[1..5]`，与 v1 `normalizeStrategy` 一致） |
| `low.peak.windows` | `strategies[0].peak.windows` | 原样（缺省 `[]`） |
| `low.peak` 三元组 | `strategies[0].peak`（扁平或历史嵌套 `peak.model`） | 沿用 `peakModelSource` 兼容；缺省回退 `primary` |
| `low.costRouting` | 无 | **true**（保住 v1 的峰时切换能力） |
| `mid` | `low` | `{ "share": "low" }` |
| `high.valley` | `advancedSupport` | 独立档，`share` 为空 |
| `high.peak` | 无 | `enabled:false`、weekdays 用 `low.peak.weekdays`、windows 用 `low.peak.windows`、三元组 = `advancedSupport` |
| `high.costRouting` | 无 | true（peak 关闭，实际恒 valley） |
| `tierRouting.enabled` | 无 | **false**（保证迁移后行为与 0.15 等价：恒 low） |
| `tierRouting` 阈值 | 无 | 0.55 / 0.28 |
| `holidays` / `utcOffsetMinutes` | 根级 | 原样 |
| `advancedSupport` | 根级 / `exclusive` | 原样（`exclusive` 仍接受） |
| `strategies[1..]` | 有 | **不参与路由**；首次保存时写入 `legacy: { strategies, advancedSupport, migratedAt }`（只读快照，不参与路由），并在 debug.log 记 `migrate: dropped N strategies (kept in legacy)` |
| 未命中（周末/假期/星期不在表内） | v1 `fallback-first-primary` | v2 没有「无方案」这个概念：`tierRouting.enabled=false` 时**恒 low**（这就是「未命中走 low」）；开启分级时按分类选档，再由该档的 `peak-weekday/peak-holiday` 落 valley。两种路径都**不再**升维 advanced |

**等价性验收**：用 0.15 的 `resolveSelectionDetailed` 作为 oracle，对迁移后的 v2 在「工作日/周末/节假日 × 峰时窗内外 × 峰时开关」矩阵上做差分测试，所有时刻的 selection 必须一致（t10 第 6 条）。

**旧文件不迁移也能读**：`loadPolicyFile()` 发现 v1 → 在内存里迁移成 v2 返回；**不写盘**。只有用户点保存（或 `set`）才写 v2，并在写前把原文件备份为 `policy.json.bak-v1-<ts>`。启动日志记 `policy: read v1 (in-memory v2)`。

---

## 3. (C) 成本决策语义

### 3.1 决策顺序（纯函数，可单测）

```
decide(now, text, hasImage, sessionBaseline, cfg):
  A. max 轴（最高优先级）
     if sessionBaseline.reasoningEffort === 'max' and cfg.advancedSupport:  -> target=advancedSupport, axis='max'
  B. 档位
     tier = cfg.tierRouting.enabled ? classify(text, hasImage) : 'low'
     table = resolveTargets(cfg)[tier]
  C. 成本决策（只对当前档）
     if table.costRouting === false:            -> valley, costReason='cost-off'
     if table.peak.enabled !== true:            -> valley, costReason='peak-disabled'
     local = shift(now, cfg.utcOffsetMinutes)
     if weekday not in table.peak.weekdays:     -> valley, costReason='peak-weekday'
     if isHoliday(local, cfg.holidays):         -> valley, costReason='peak-holiday'
     if !timeInWindows(minutes, windows):       -> valley, costReason='peak-outside'
     else                                       -> peak,   costReason='peak'
  return { axis, tier, target, tierReason, costReason, weekday, holiday, minutes }
```

顺序是契约：`cost-off` 先于 `peak-disabled`，`weekday` 先于 `holiday` 先于 `window`。测试按这个顺序断言。

### 3.2 时间函数（复用并小幅改写）

沿用 `lib/index.js:249-310` 的 `minutesOf` / `timeInWindows` / `isHoliday` / `resolveSelectionDetailed` 思路，改成：

```js
export function localParts(date, utcOffsetMinutes) { /* 同 v1：shifted = date + offset，取 UTC 字段 */ }
export function timeInWindows(minutes, windows) {
  return windows.some(([s,e]) => minutes >= minutesOf(s) && minutes < minutesOf(e))
}
export function isHoliday(year, month, day, holidays) { /* 同 v1 */ }
```

- `utcOffsetMinutes` 仍是「把 UTC 平移到本地」的做法，不做系统时区转换（与 v1 完全一致，差分测试才可比）。
- `weekday` 仍是 1=周一..7=周日（`((getUTCDay()+6)%7)+1`）。
- `timeInWindows` 不处理跨午夜（配置校验已拒绝 `end <= start`）。
- 节假日只影响 `peak` 分支；`valley` 全周可用。

### 3.3 reason 枚举（对 GUI 与日志稳定）

| 字段 | 值 | 含义 |
|---|---|---|
| `axis` | `max` \| `tier` | 走的是 max 高级轴还是档位轴 |
| `tierReason` | `tier-disabled` | `tierRouting.enabled=false` → low |
| | `tier-low` / `tier-mid` / `tier-high` | 分级命中 |
| | `override-high-safety` | 安全 override（全项目/发布/回滚/删库…） |
| | `override-high-explicit` | 「认真想/先规划/给方案…」 |
| | `override-low-explicit` | 「直接改/快点/别想太多…」 |
| | `tier-fallback-low` | 无文本 / 分级异常 → 安全回退 low |
| | `max-advanced` | baseline 要求 max → 高级轴 |
| `costReason` | `peak` | 峰时窗内 → peak 目标 |
| | `cost-off` | 该档 `costRouting=false` → valley |
| | `peak-disabled` | `peak.enabled=false` → valley |
| | `peak-weekday` | 星期不在峰时表 → valley |
| | `peak-holiday` | 法定节假日 → valley |
| | `peak-outside` | 不在任何峰时窗 → valley |
| `outcome` | `selected` | select 被调用且目标与 current 不同（视觉上切换） |
| | `noop-same` | select 被调用但目标与 current 相同（核心可能去重；不产生第二次切换 notice） |
| | `unroutable` | 目标不可用，保持 current |
| | `select-failed` | select 抛错 |
| | `host-unsupported` | 核心没有 `agent.model.select` |
| | `disabled` | 开关关 / 会话覆盖关 |
| `fallback` | `null` \| `"low"` | 仅当 high/mid 目标真不可用、改道到 low.valley 时置 `"low"`（§1.4） |

GUI 文案映射见附录 B；未知值一律显示「未知原因」，不得崩。

### 3.4 每档峰谷表 / 窗口 / 节假日

- **每档各自的峰谷表**：`targets.low/mid/high` 各有 `valley`、`peak`、`costRouting`。
- **峰谷窗口**：每档 `peak.weekdays` + `peak.windows` 各自可编辑；某档 `peak.enabled=false` 时该档不切峰。
- **节假日**：根级 `holidays` 一份，全部档共享。**明确不做每档独立节假日**：节假日是日历事实，不是每档策略；每档差异用 `peak.enabled/weekdays/windows` 表达。若未来需要，再加 `targets[t].peak.holidays`（本次不加，避免 GUI 三份日历）。
- 窗口为空且 `enabled=true`：规范化为 `enabled=false` 并记日志（v1 的 `normalizeStrategy` 也是这么做的）。

---

## 4. (D) 分级判定

### 4.1 输入

- 只取「本轮 turn 首步将被领取」的用户消息文本：
  - 空闲：`agent.inbox.nextTurn` 里 `source.kind === 'user'` 的全部消息（合并成一段，批内合并）。
  - `turn-stopping`：`agent.inbox.nextTurn` 全部 user 消息。
  - 中途接管：`agent.inbox.nextStep` 全部 user 消息 + `turnPosition` 加成。
- 文本块：`content` 中 `type === 'text'` 的 `.text` 拼接（`\n` 分隔）；`type === 'image'` 记 `hasImage=true`；`type === 'file'` 视为具象证据（同路径，+0.06，见 4.3）。
- 截断：特征计算只看前 12000 字符（避免超长日志拖慢）；override 关键词在前 4000 字符内检测。
- 不读会话历史、不读工具集、不发网络请求、不调模型。

### 4.2 「一次 turn 只判一次」状态机（硬要求）

`decisionByTurn: Map<"sessionId:turn", {tier, score, target, at}>`（LRU 200）。

| 场景 | 行为 |
|---|---|
| 空闲 agent 第一条 user 消息 | `turn = lastTurn + 1`；计算 + select；写 `decisionByTurn` |
| 空闲 agent 同批第二条 user 消息（turn 尚未开始） | 同一 turn：允许**重新合并计算**并覆盖 select（turn 还没开始，安全）；仍只算一次「生效判定」 |
| 运行中 insert 的 `next-turn` 消息 | **不决策、不 select**（会污染当前 turn 的后续 step）；等 `turn-stopping` |
| 运行中 insert 的 `next-step`（steer），本 turn 已有判定 | **冻结**：不重新分级、不降档、不升档 |
| 运行中 insert 的 `next-step`，本 turn 无判定（插件中途加载/错过） | 中途接管：用 `nextStep` 文本 + `turnPosition` 加成计算一次，只对后续 step 生效 |
| `turn-stopping` 且有 `nextTurn` | 为 `lastTurn + 1` 计算 + select；这是排队 followup 的唯一正确时机 |
| 同一 turn 的后续 step（工具结果/运行时上下文） | 不是 user 消息，监听器直接忽略；`step>1` 不触发重新分级 |

**迟滞（防抖）**：同一会话 10 分钟内，新档位若与上次档位相邻且分数落在边界 ±0.05 内，保持上次档位（不 select）。边界：high/mid = `mediumThreshold`，mid/low = `concreteThreshold`。记 `tier-hysteresis` 日志。

**批内合并的已知代价**：`turn-stopping` 时若 `nextTurn` 有 2 条消息，循环只领取第 1 条开启下一 turn；但分级把两条合并计算。这是刻意的（与 RESEARCH §7.1「同一批 next-turn 合并分类一次」一致）：保证排队的后续消息也有决策，代价是第 2 条消息所在的 turn 沿用首批档位。用户再发一条新消息会重新判定。写进 README「已知限制」。不要为此引入「每个排队消息一个预决策」的复杂状态机（收益小、不可解释）。

**turn 异常结束的边界**：`agent/turn-stopping` 只在 `turnEnds` 为正且 `nextStep` 为空时触发；回合因错误/取消结束时不会触发。此时排队的 `nextTurn` 消息若被后续唤醒，可能沿用上一次决策；下一条新用户消息会重新判定。记 `turn-stopping-missed` 日志（在 `agent/request-error` 或 `turn/end` 观察里），写进 README 已知限制。不要为此在 `pre-step` 里补救（改不到本步）。

### 4.3 特征与权重（v2 定稿）

`concreteness ∈ [0,1]`，越高越具象（→ low）。权重固定写在 `lib/classifier.js`，不暴露给 GUI；阈值可配（§2.2）。**与 RESEARCH §6.2 的差异**：删掉「step>1 +0.25」作为常规项，因为本架构只在 turn 首步分级；它只作为「中途接管」的 `turnPosition` 加成保留。

| id | 判定 | 权重 | 说明 |
|---|---|---|---|
| `code` | 出现 ``` 围栏，或 ≥3 行以 4 空格/Tab 开头 | +0.22 | 贴代码通常要改/查 |
| `path` | `[\w./\\-]+\.(ts|tsx|js|mjs|cjs|py|json|md|ya?ml|toml|ps1|sh|go|rs|java|c|h|css|html|sql)` | +0.18 | 指向仓库对象 |
| `command` | 行首 `$ ` / `> `，或 `\b(npm|pnpm|yarn|node|git|dsh|pytest|vitest|jest|cargo|go test|python|pip|tsc|docker|kubectl|python3)\b` | +0.18 | 「跑一下」最典型 |
| `symbol` | 反引号标识符、`Foo.bar(`、`:123`、`\b(E[A-Z]{2,}|TS\d{4}|ENOENT|EADDRINUSE)\b`、堆栈行 | +0.12 | 具体 bug |
| `file` | `type === 'file'` 内容块 | +0.06 | 附件偏具象 |
| `verb` | 改/加/删/跑/装/提交/修/重命名/迁移/替换 + fix/run/add/remove/rename/install/commit/replace | +0.15（与 path/command/symbol/file 任一同时出现）；否则 +0.075 | 动词 + 对象才可靠 |
| `multi` | ≥2 个问号，或编号列表（`1)`、`- [ ]`、第一/第二） | −0.12 | 多任务偏规划 |
| `abstract` | 为什么/原理/设计/方案/评估/取舍/tradeoff/架构/对比/该不该/解释/总结/梳理 + why/design/architecture/evaluate/compare/explain/summarize | −0.20 | 「要判断，不要动手」 |
| `long` | 长度 > 1500 | −0.08 | 弱权重，长 ≠ 抽象 |
| `short` | 长度 < 80 且无任何正特征 | −0.05 | 概念短问 |
| `image` | 有 `type === 'image'` | +0.08 | 弱证据 |
| `turnPosition` | 中途接管（本 turn 已在运行，插件错过首步） | +0.25 | 只在 adopt 路径生效 |

`score = clamp01(Σ 权重 × 特征强度)`；布尔特征强度 1（`verb` 单独出现按 0.5）。阈值：

```
score >= concreteThreshold(0.55)      -> low
score >= mediumThreshold(0.28)        -> mid
score <  mediumThreshold              -> high
```

**没有文本**（`text.trim()===''`）：`tier='low'`、`tierReason='tier-fallback-low'`、`score=null`（t6 明确要求回退 low）；**分级抛异常**同样回退 low 并记日志。

### 4.4 override（在打分之前判定，优先级从高到低）

1. `override-high-safety`：`全项目|整个项目|所有文件|全部文件|批量|发布|上线|回滚|删库|迁移整个|重构整个|生产环境|所有测试|全量` → high。
2. `override-low-explicit`：`直接改|直接执行|快点|简单回答|别想太多|最短路径|just do it|quickly` → low。
3. `override-high-explicit`：`认真想|仔细想|深入思考|深入分析|想清楚|先规划|先给方案|给方案|评估一下|不要动手|先别改|设计一[下个]` → high。
4. 冲突时：安全 > low explicit > high explicit（安全最高，其次用户明确要求省事，最后才是「认真想」）。

override 仍受 `tierRouting.enabled` 约束：总开关关时恒 low，override 不生效（避免「关了分级却被关键词改档」的意外）。

### 4.5 与 max 高级思考模型的优先级（定死）

```
1) sessionBaseline.reasoningEffort === 'max' 且 advancedSupport 有效
      -> 直接用 advancedSupport；不走档位、不走峰谷；costReason 不适用
2) 否则：tierRouting.enabled ? 分级 : low；再按该档 costRouting/峰谷表选 peak/valley
3) advancedSupport 永不作为「周末/节假日/无匹配」的兜底（0.15 规则保留）
4) baseline 的来源是 restore（用户介入前/用户手选后的选择），不是 lastApplied
5) advancedSupport 不可路由 -> 可见告警 + 保持 current（不改道到档位目标，§1.4）
6) tierRouting.enabled=false -> 恒 low（即便 baseline 不是 max、即便文本很抽象）
```

`sessionBaseline` 解析：

```
restore = state.sessions[id].restore
current = agent.model.current()
baseline = restore ?? current
若 current 与 applied 不同且与 restore 不同 -> external：restore = current, baseline = current
```

### 4.6 反例（必须进测试，逐条）

| # | 输入 | 期望 |
|---|---|---|
| 1 | 长文 + 「总结一下」 | 不因长度进 low；抽象词抵消后 mid/high |
| 2 | 贴报错日志 + 「为什么」 | 代码/符号正权 + 抽象负权；按分数落档，不许崩 |
| 3 | 极短「跑一下测试」 | command + verb 压过 short，落 low |
| 4 | 「帮我重构整个项目」 | 无路径/命令，但 safety override → high |
| 5 | 同 turn 第 3 步（工具后续） | 不重新分级（无 user 消息） |
| 6 | 中英混写 / 纯英文 | 双语关键词表命中；无 `\b` 依赖中文 |
| 7 | 「引用这段代码，解释一下」 | abstract 抵消 code，落 mid/high |
| 8 | 纯图片 / 空文本 | `tier-fallback-low`，不抛错 |
| 9 | 两条消息同批（一条抽象一条命令） | 合并文本后一个分数、一个档 |
| 10 | 分级器内部抛错（注入坏 content） | 回退 low + 限流日志 |

### 4.7 校准与影子

- 总开关关时**不计算**（省 CPU），但 `probe` RPC 可随时试算。
- 打开后每次决策写 `decisions.jsonl`（§5.4）；GUI 显示最近 20 条与档位分布。
- 阈值校准：用 `decisions.jsonl` 的 `score` 按目标分布取分位数回填 `concreteThreshold/mediumThreshold`（RouteLLM `calibrate_threshold.py` 的做法）；GUI 只显示建议值，用户点「应用」才写入。
- 验收代理指标：低档请求的失败/重试率、同会话手动升级比例（本期只记录，不做自动调参）。

---

## 5. (E1) 可见告警契约

### 5.1 数据结构（`get` RPC 下发，内存态，不写盘）

```ts
type Selection = { provider: string, model: string, reasoningEffort?: string }

type Warning = {
  at: string;                       // ISO
  sessionId: string;
  turn: number;
  kind: 'provider' | 'model' | 'effort' | 'missing' | 'unverified' | 'llm-unavailable'
      | 'select-failed' | 'no-current' | 'host-unsupported' | 'request-failed'
      | 'sync-read-failed' | 'state-write-failed' | 'default-seam-missing';
  severity: 'error' | 'info';       // error=红（配置/能力问题），info=黄（目录未热，等刷新）
  target: Selection | null;         // 尝试的目标
  kept: Selection | null;           // 实际保留的模型
  detail: string;                   // 英文技术细节（debug 用）
  count: number;                    // 去重累计
}

type Decision = {
  at: string; sessionId: string; turn: number;
  axis: 'max' | 'tier';
  tier: 'low' | 'mid' | 'high';
  score: number | null;
  tierReason: string;              // §3.3
  costReason: string | null;       // §3.3
  target: Selection;               // 计划目标
  applied: boolean;                // select 是否被调用
  changed: boolean;                // 与 current 是否不同
  outcome: 'selected' | 'noop-same' | 'unroutable' | 'select-failed' | 'host-unsupported' | 'disabled';
  fallback: 'low' | null;           // high/mid 真不可用 -> low.valley 时置 'low'
  warningKind: string | null;
}
```

- `warnings`：按 `sessionId|kind|target` 去重，最多 20 条；`get.warnings` 返回数组。`severity='info'`（目录未热/llm 不可用）不阻塞、不吓人；`severity='error'`（provider/model/effort 真不可用）红色。
- **自动消失**（t8 硬要求）：每次决策、每次目录刷新成功后，重新 `validateTargetSync` 所有 warning 的 `target`；返回 `ok` 则删除该 warning 并记 `warning: cleared`。`unverified` 在目录热且目标通过后自动降级清除；切回可用目标/目录恢复后，GUI 横幅自动消失。
- `lastDecision`：全局最近一条 + `sessions[id].lastDecision`（最近 200 个会话，LRU）。
- 告警只影响展示，**不影响请求路径的 fail-safe**：读不到目录仍然不 select、不报错、不阻塞（t5：不可用/未知则不改）。

### 5.2 日志行（验收要 grep）

```
inbox: decision session=<id> turn=<n> tier=<low|mid|high> score=<0.123|-> target=<p/m@e|p/m> axis=<max|tier> tierReason=<...> costReason=<...|-> fallback=<low|-> via=<inbox|turn-stopping|steer-adopt>
inbox: select -> <p/m@e> (session <id> turn <n>; was <p/m@e>)
inbox: no-op-same -> <p/m@e> (session <id> turn <n>)
inbox: unroutable kind=<provider|model|effort|missing> target=<p/m@e> -> keeping <p/m@e|-> (session <id>)
inbox: unverified kind=<catalog-cold|catalog-unreadable|effort-cold|llm-unavailable> target=<p/m@e> -> keeping <p/m@e|-> (session <id>)
inbox: select failed: <message> (session <id> target <p/m@e>)
pre-step: session=<id> turn=<n> step=<n> modelSelection=<p/m@e> expected=<p/m@e|-> match=<true|false>
request: observed session=<id> config=<p/m@e>
restore: session=<id> -> <p/m@e> (reason=<toggle-off|inherit|dispose|manual|pending>)
warning: cleared <kind> <p/m@e> (session <id>)
host: model-select <present|missing>; default-seam <present|missing>; llm <present|missing>
```

`agent/request` 的旧日志 `agent/request: overriding` / `nothing to rewrite` **全部删除**（避免与新接缝混淆）。

### 5.3 GUI 展示

- 设置页顶部横幅：`⚠ 目标不可路由：<p/m>（<kind 文案>）→ 已保持 <kept 或「会话原模型」>`；可展开看最近 5 条；有 warning 时红/黄底。
- 会话列表小灯：该会话有 warning 时加 `title` 文案并换色（红点）；无 warning 恢复蓝色。小灯仍表示「开关意图」，但 warning 时 title 说明「目标不可路由，已保持原模型」。
- 每次成功决策后，该会话的 warning 自动消失（不需要用户手动关）。

### 5.4 `decisions.jsonl`

- 位置：`$DSH_HOME/plugins/dsh-peak-valley-router/decisions.jsonl`（与 `debug.log` 同目录）。
- 每行一个 `Decision` + `version`；`appendFileSync`；apply 时若 > 2 MB，保留最后 2000 行并原子重写。
- 只做诊断/校准，不被 GUI 直接读文件（GUi 用内存 `recentDecisions`）。

---

## 6. (E2) 跨窗口 / 多进程状态同步

### 6.1 `state.json` v2 与「读-改-写」合并

```json
{
  "schemaVersion": 2,
  "revision": 12,
  "updatedAt": 1795010000000,
  "enabled": true,
  "enabledUpdatedAt": 1795010000000,
  "sessions": {
    "<sessionId>": {
      "enabled": true,
      "updatedAt": 1795010000000,
      "restore": { "provider": "...", "model": "...", "reasoningEffort": "..." },
      "applied": null,
      "restorePending": false
    }
  }
}
```

- **读 v1**：`{ enabled, sessions: { id: boolean } }` → 规范化为 v2（`enabled→enabled`、`sessions[id]→{enabled,updatedAt:0}`）。不写盘，直到下一次变更。
- **tombstone**：取消会话覆盖用 `enabled: null` + `updatedAt`，**不要 delete**；否则另一进程的旧快照会在合并时把键复活。读取时 `null` 等价「跟随默认」。
- **容量**：最多 500 个会话条目；超限淘汰 `updatedAt` 最旧的（含 tombstone），记日志。
- **合并**：`mergeState(disk, memory)`：
  - 全局：`enabledUpdatedAt` 大者胜（相等取 disk）。
  - 会话：每个键取 `updatedAt` 大者；相等取 disk。
  - `revision = max(disk.revision, memory.revision) + 1`。
- **写锁**：`state.json.lock`（`open(path,'wx')`，内容 `{pid, at}`）；拿不到就每 20 ms 重试，最多 25 次；若锁的 `at` 超过 5 秒视为陈旧，删除后重试一次；仍失败 → 记 `state: lock timeout`，本次变更只在内存生效（不阻塞会话）。
- **原子写**：沿用 `writeJsonAtomic`（`lib/index.js:322-332`）。
- 内存里的 `sessions` 仍用 `Map`（整数键顺序问题，`lib/index.js:366-368` 的注释仍然成立）。
- **写频率**：`restore` 只在首次介入/外部选择时变；`applied` 每次目标变化才变。用 1 秒去抖合并写盘，正常每 turn 至多一次；`enabled` 切换立即写（用户动作要立刻落盘）。

`mutateState(fn)` 的契约：**只应用本次变更的键**，不整表覆盖：

```js
async function mutateState(applyChange) {
  await withFileLock(stateLockPath(), async () => {
    const disk = await loadStateFile()           // v1/v2 规范化
    const merged = mergeState(disk, memoryState)
    const next = applyChange(structuredClone(merged))   // 只改目标键
    next.revision = Math.max(disk.revision, merged.revision) + 1
    next.updatedAt = Date.now()
    await writeJsonAtomic(statePath, toJson(next))
    memoryState = next
    debugLog(`state: merged revision=${next.revision} (disk ${disk.revision}) sessions=${sessionsCount(next.sessions)}`)
  })
}
```

### 6.2 `policy.json` revision 与保存冲突

- 写盘加 `revision`（整数）与 `updatedAt`；`set` 接受可选 `expectedRevision`。
- 在 `policy.json.lock` 内重读当前 revision：`expectedRevision` 存在且不等 → 返回错误 `{ code:'stale-revision', message, details:{ revision, config } }`；GUI 显示「另一窗口已修改」并给「重新加载/覆盖保存」。
- 不传 `expectedRevision`（旧客户端）→ 最后写入者胜，记日志。
- 保存前备份 v1 原文件（§2.4）。

### 6.3 文件监视 + 客户端轮询

- Node：`fs.watch(pluginDir, { persistent: false })`，debounce 250 ms；事件后重读 `policy.json` 与 `state.json`：
  - policy 解析失败 → 保留旧 cfg，记 warning `sync-read-failed`，不覆盖文件。
  - state 解析失败 → 保留旧内存，记日志。
  - **自触发抑制**：每次自己写盘后记录内容 hash；watch 回调先比 hash，相同则跳过。
- 只更新内存，**不回写**。
- 会话内的「当前模型选择」不走 `state.json`：它已经在会话日志的 `model/selection` 里，同进程多窗口通过 `modelSelection` projection 共享（模型选择器自然同步）。跨进程同时驱动同一会话不在承诺内（§6.3 末）。
- 客户端：设置页可见时每 **3 秒** `get` 一次（t9 明确要求）；`document.visibilityState === 'hidden'` 时暂停，`visibilitychange`/`focus` 时立即拉一次。用 `stateRevision`/`configRevision` 判断是否需要更新 UI。
- 草稿保护：设置页维护 `baseRevision` 与 `dirty`（canonical JSON 比较）。轮询发现 `configRevision` 变了且 `dirty=false` → 自动替换；`dirty=true` → 顶部显示「配置已在其它窗口更新」+「重新加载」，不得静默覆盖用户正在编辑的草稿。
- 多进程限制（写进 README）：两个 DSH 进程同时驱动**同一个会话**不在本设计承诺内（核心不允许两个写句柄）；本设计只保证开关/配置/恢复元数据不互相覆盖。

### 6.4 失败降级

| 失败 | 行为 |
|---|---|
| 锁超时 | 只改内存；日志；下一条消息仍按内存决策；GUI 仍显示本地状态 |
| 写盘失败 | 同上；`get` 返回 `lastWarning.kind='state-write-failed'`（可选） |
| 读盘失败 | 保留内存；不把状态清空（绝不因读失败把开关变 false） |
| watch 不可用 | 仍靠 3 秒轮询；日志一次 |

---

## 7. (E3) GUI 信息架构

> 侧边栏底部开关、composer 左侧开关、会话列表小灯**沿用 0.15.0**，插槽（`sidebar.footer.action` / `conversation.input.left` / `sidebar.session.row.leading`）不动；本节只重排「设置 → 避峰岗」区块，并在小灯上加 warning 颜色/title。

### 7.1 布局（`settings.section`，id 仍为 `peak-valley-router`）

```
避峰岗                                    v0.16.0   [宿主能力徽标]
按请求类型与峰谷时段自动选择模型。

[状态区]
  此刻生效：<provider>/<model>@<effort> · <tier 文案> / <cost 文案> / <max 文案>
  ⚠ 目标不可路由：<target>（<kind>）→ 已保持 <kept>        [最近 5 条展开]
  最近决策（折叠）：turn/档位/分数/目标/原因/是否生效

[A. 智能程度路由]  (默认关)
  [开关] 开启后按消息的「具象度」分三档：抽象→高、中等→中、具象执行→低。
  阈值：具象 ≥ [0.55] → 低档；中等 ≥ [0.28] → 中档；其余 → 高档
  [样例试算] 粘贴一段 prompt → 显示 分数/命中特征/档位/最终目标/原因（probe RPC）

[B. 三档模型]
  ┌ 低档（具象执行） ─────────────────────────────┐
  │ 谷时模型 [provider ▾][model ▾][effort ▾]        │
  │ [x] 成本决策（峰时用峰时模型）                  │
  │ [x] 启用峰时 星期[一..日] 窗口[09:00-12:00][+]  │
  │ 峰时模型 [provider ▾][model ▾][effort ▾]        │
  └────────────────────────────────────────────────┘
  ┌ 中档（中等） ──────────────────────────────────┐
  │ [x] 跟随低档（默认）   ← 勾选时显示继承值（只读）│
  │ 取消勾选后展开与低档相同的编辑器                 │
  └────────────────────────────────────────────────┘
  ┌ 高档（抽象） ──────────────────────────────────┐
  │ 同上（默认跟随低档）                            │
  └────────────────────────────────────────────────┘

[C. 峰谷与节假日]
  时区偏移 [UTC+8 (480 分钟)]
  法定节假日：[[2026-10-01] ×] ...  [+ 添加日期]
  说明：节假日全天走谷时；窗口 start 含、end 不含；暂不支持跨午夜窗口。

[D. 高级模型支援（max）]
  会话要求 max 思考时使用：[provider ▾][model ▾][effort ▾]（必填）

[E. 诊断]
  [刷新模型列表]  最近不可路由警告  已路由会话列表 + [恢复原模型] / [全部恢复]
  decisions：最近 20 条（折叠）+ 档位分布

[保存] [重新加载]   “已保存 22:10” / 冲突提示
```

### 7.2 交互契约

- **共用低档**：中/高默认勾选「跟随低档」；勾选时提交 `{share:'low'}`，编辑器显示 `effective` 的只读值；取消勾选时把当前继承值复制成独立配置（用户可改）。
- **成本决策开关**：每档一个；关闭时该档的峰时子区置灰但保留窗口（不删数据）。
- **窗口编辑**：开始/结束时间 `input type=time`；新增/删除行；校验 `start < end`，空窗口允许但 `enabled` 时提示会失效；保存时服务端再校验。
- **节假日**：日期选择器 + 删除；按年分组显示；去重排序；保存时服务端校验。
- **恢复原模型**：列出 `sessionDetails` 里有 `restore` 的会话（最近 20 个），每个一行：会话标题/id + 原模型 → 当前模型 + [恢复]；[全部恢复] 对活 agent 生效，不在线的标 `restorePending`。
- **样例试算**：调 `probe({text, at?})`，只读；显示命中特征列表，帮助用户理解分数。
- **冲突**：保存返 `stale-revision` → 顶部红条「配置已在其它窗口更新」+ [重新加载] / [用我的覆盖]（覆盖=不带 expectedRevision 再保存一次，需二次确认）。
- **轮询**：3 秒；hidden 暂停。
- **不阻塞保存**：目录（providers/models）拉取失败仍可保存（沿用 0.14 行为）；缺模型时下拉保留当前值。

### 7.3 文案

所有新文案只进 `lib/text.js` 的 `zh/en`（`copy.test.mjs` 会抓硬编码中文）。key 清单见附录 B。`lib/client.js` 由 `node src/build-client.mjs` 重建并提交。

### 7.4 客户端源码拆分（建议）

| 文件 | 内容 |
|---|---|
| `src/client/00-shared.js` | store 增加 `refresh()`/轮询/`sessionDetails`/warnings；RPC 增加 `probe/restore` |
| `src/client/10-toggle.js` | 不变；小灯加 warning 颜色/title |
| `src/client/20-modelpicker.js` | 不变（三档卡片复用）；可加 `efforts` 过滤（可选） |
| `src/client/30-strategy.js` → `30-target-card.js` | 三档卡片 + 峰谷窗口编辑器（替换旧策略编辑器） |
| `src/client/40-settings.js` | 新区块布局、状态区、告警、试算、诊断 |
| `src/client/50-holidays.js`（新） | 节假日编辑器 |
| `src/client/90-apply.js` | 注册不变 |

`catalog-refresh.test.mjs` 直接引用了 `StrategyEditor`/`ModelPicker` 假组件，改 UI 时必须同步更新（保持「刷新不重载草稿」的断言）。

---

## 8. RPC 契约

所有 handler 必须保持 `lib/index.js` 现有 6 空格缩进（`verify.mjs` 的 handler 正则 `^\s{6}([A-Za-z]\w*):\s*async\s*\(` 依赖它）。

| 方法 | 入参 | 成功返回 `value` | 失败 |
|---|---|---|---|
| `get` | `{}` | `{ config, effective, configRevision, enabled, sessions:{id:boolean}, sessionDetails, stateRevision, version, host:{modelSelect,defaultSeam,llm}, active, lastDecision, warnings, recentDecisions, stateFilePath? }` | 无（读失败返回缓存/空） |
| `set` | `{ config, expectedRevision? }` | `{ config, effective, configRevision }` | `bad-request` / `stale-revision`（details 带当前 config+revision） |
| `toggle` | `{ enabled?, sessionId?, inherit? }` | `{ enabled, sessions, sessionId?, sessionEnabled?, restored? }` | `bad-request`（sessionId 非空串校验保留） |
| `providers` | `{ strict? }` | `{ providers:[{id,name}] }` | 非 strict 返回空 |
| `models` | `{ provider, strict? }` | `[{id,name}]` | 非 strict 返回空 |
| `modelInfo`（新） | `{ provider, model }` | `{ ok, efforts:[{id,name}], defaultEffort? }` 或 `{ ok:false }` | 不抛；未知返回 `ok:false` |
| `probe`（新） | `{ text, at?, sessionId? }` | `Decision`（不落盘、不 select） | `bad-request`（text 非字符串） |
| `restore`（新） | `{ sessionId }` | `{ restored:boolean, current, target }` | `bad-request` |

- `sessions` 保持 `{id: boolean}`（兼容旧客户端与 `peakRoutingSessions`）；详细 v2 条目走 `sessionDetails`。
- `get.active`：无文本时的「此刻」预览（等价 `probe({text:''})`），带上 `axis/tier/costReason`；旧字段 `provider/model/reasoningEffort/reason/weekday/holiday/strategyIndex/advancedForMax` 尽量保留别名，`strategyIndex` 置 `null`。
- `probe.at` 是 ISO 字符串；用于 GUI 试算与测试；真实路由永远用 `new Date()`。
- 直接 `POST /api/dsh-peak-valley-router.get` 在桌面端会 401（无桌面会话凭据，t3 已实测），验收必须走 GUI 或 headless 通道（§10.3）。

---

## 9. (F) 版本与兼容

- `package.json` 的 `version` 升到 **0.16.0**；`CHANGELOG.md` 新增 `## [0.16.0]`；`README.md` / `SKILL.md` 的「当前版本」同步；`lib/client.js` 重建后提交；`npm test` 与 `node scripts/verify.mjs` 全绿。
- 运行时可从三处确认：设置页版本行、`get.version`、`debug.log` 的 `apply: v0.16.0, …`。

### 9.1 `peerDependencies`

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-llm": "^0.2.0-rc.2 || ^0.2.1-rc.2 || ^0.2.2-rc.1"
}
```

- 显式点名 `0.2.2-rc.1`（semver：prerelease 只被同名三元组的区间接受；`^0.2.1-rc.2` 不接受 0.2.2-rc.1）。
- `^0.2.2-rc.1` 同时接受 `0.2.2-rc.N`（N≥1）与 `0.2.2` 正式版，但不接受 `0.2.3-rc.1`（下一个三元组必须显式加）。
- **保留旧线是「可安装/可加载」声明，不是「旧线可路由」声明**：0.2.0 已确认没有 `agent.model`（`.recon-b`）；0.2.1 未核、按能力探测处理。没有该 API 的线在 0.16.0 上会显示 `host-unsupported` 并保持透明（§9.3）。旧线用户应留在 0.15.0。这个取舍要写进 README/CHANGELOG。

### 9.2 `host-compat.test.mjs` 同步改

```js
const VERIFIED_HOSTS = ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1']
const REJECTED_HOSTS = ['0.1.1-rc.2', '0.2.3-rc.1', '0.3.0-rc.1', '1.0.0']
```

- 新增反控：
  - `satisfies('0.2.2-rc.1', '^0.2.1-rc.2') === false`（证明旧区间确实不覆盖）。
  - `satisfies('0.2.2-rc.1', combined) === true`、`satisfies('0.2.2', combined) === true`、`satisfies('0.2.3-rc.1', combined) === false`。
- `0.2.2-rc.1` 从 REJECTED 移到 VERIFIED；注释更新为「0.2.3-rc.1 是新的 sharp case」。

### 9.3 宿主能力探测与旧线行为

```js
function hasModelSeam(agent) { return typeof agent?.model?.select === 'function' }
// get.host.modelSelect = 最近一次观察到的 agent 能力（用于 GUI 徽标）；路由判断永远用 hasModelSeam(agent)
const hostSeams = {
  defaultSeam: /* 收到过 internal/get agentDefaultModel */,
  llm: !!llm,
}
```

- `hasModelSeam(agent) === false`：开关仍可开，但每次插入记一次 `host-unsupported` 告警（限流），不调用任何改写；GUI 徽标显示「当前核心不支持会话内路由（需 0.2.2-rc.1+）」。
- `defaultSeam=false`：只记日志；不影响路由。
- 绝不在旧线回退到 `agent/request` 改写：这正是 0.16 要拆掉的雷（且 0.2.2 会 throw）。双路径会让测试矩阵翻倍、行为分叉。

### 9.4 「装不上」判定（注意：桌面端的 peer 是 advisory）

**关键更正（t3 已实测）**：桌面端 0.14.0 的 Plugin Manager 对 peer 不匹配只打 `[desktop] compatibility warning`（`dsh-app-boot evaluatePluginCompatibility`），**不会硬拒**。所以「peer 区间没写 0.2.2-rc.1」在桌面端**不是**装不上的原因；仍要改，是因为 CLI/profile 启动路径与其它管理器会校验，且声明必须诚实。

按顺序判定：

| 步 | 命令/观察 | 装不上的证据 |
|---|---|---|
| 1 | Plugin Manager `install_bundle` 回执 | `application=failed` / `error.code`（`already-installed` 不是兼容问题，按提示先 remove） |
| 2 | `$DSH_HOME/profiles/desktop/package.json`（或实际安装的 profile，例如 `web`） | `dependencies["dsh-peak-valley-router"]` 不是 `0.16.0`，或 `dsh.profile.bundles` 不含它 |
| 3 | `$DSH_HOME/profiles/.generations/live/` | 没有 `dsh-peak-valley-router+0.16.0+*` |
| 4 | `$APPDATA%/dsh-desktop/plugin-operations/operations.jsonl` | 最近 install 未 `settled version 0.16.0` |
| 5 | `$APPDATA%/dsh-desktop/harness/profiles/web/.generations-deferred.json` 或日志 | `failed peer validation` / `does not resolve from the installation closure`（这是真的装不上） |

### 9.5 「装上但 no-op」判定（本机最容易踩的坑）

**t3 已实证：generation 已经切到 0.15.0，但运行中的 host 仍加载 0.12.0；`set_plugin` 热重载也还是 v0.12.0，必须冷启动。** 因此「no-op」按下面 0–6 的顺序排查：

| # | 观察 | 结论 | 处置 |
|---|---|---|---|
| 0 | `debug.log` 最新 `apply: vX` 不是 v0.16.0 | 进程仍持旧模块（generation 切换/热重载都不够） | **完全退出并重启 DSH Desktop**，不是重开窗口 |
| 1 | `get.version !== '0.16.0'` 或 `get.host.llm=false` | 同 0（或 llm 服务缺失） | 重启；查 `apply` 行 |
| 2 | `get.host.modelSelect=false` | 核心太旧（0.2.0/0.2.1） | 升级核心，或留在 0.15.0 |
| 3 | 开关/会话覆盖为 false | 根本没启用 | 打开开关或该会话覆盖 |
| 4 | `debug.log` 有 `inbox: no-op-same` | select 被调用但目标 = 当前模型，视觉上没有切换 | 把目标改成另一个已注册模型再验（这是 0.15 验收踩过的坑） |
| 5 | 有 `inbox: unverified` / `inbox: unroutable` / `host-unsupported` | 目录未热（等刷新）/ 目标不可用 / 核心不支持 | 等 1–2 秒重发；修配置；升级核心；告警会显示 |
| 6 | 有 `inbox: decision` 但下一步 `pre-step.modelSelection` 不是目标 | select 与 step 准备顺序异常 | 记录 turn/step/事件顺序，报缺陷（不应发生） |

**一次最小判定链**（复制即用）：

```powershell
$h = $env:DSH_HOME
Select-String -Path "$h/plugins/dsh-peak-valley-router/debug.log" -Pattern 'apply: v0.16.0|inbox: decision|inbox: select|pre-step:|request: observed|host:' | Select-Object -Last 20
```

期望至少出现：`apply: v0.16.0` → `inbox: decision` → `inbox: select` → `pre-step: ... match=true` → `request: observed ... config=<目标>`。

---

## 10. (G) 验收判据清单（每条可命令或可断言）

### 10.1 单元/契约测试（`node scripts/*.test.mjs`）

| ID | 文件 | 断言（必须逐条） |
|---|---|---|
| U1 | `scripts/config-v2.test.mjs` | 新装 DEFAULTS 规范化后三档齐全、mid/high=`{share:'low'}`、`tierRouting.enabled=false`、`costRouting=true`；非法窗口（`end<=start`）抛错；阈值顺序错误抛错；`effective` 解析正确 |
| U2 | `scripts/migrate-v1.test.mjs` | v1（0.15 实际 policy 样例）→ v2：low←strategies[0]、low.peak←peak、high←advancedSupport、mid=share low；`tierRouting.enabled=false`；v1 文件读取后**未写盘**（mtime 不变） |
| U3 | `scripts/migrate-equivalence.test.mjs` | 以 0.15 `resolveSelectionDetailed` 为 oracle，在 7 天 × 峰时内外 × 节假日 × peak 开关矩阵上 selection 全等 |
| U4 | `scripts/classifier.test.mjs` | 4.6 的 10 条反例逐条；中英混写；空文本→low + `tier-fallback-low`；阈值边界（0.549/0.55/0.279/0.28）；override 优先级；hysteresis ±0.05 |
| U5 | `scripts/cost-routing.test.mjs` | cost-off / peak-disabled / peak-weekday / peak-holiday / peak-outside / peak 六种 reason 的优先级；`09:00` 含、`12:00` 不含；每档独立窗口；`costRouting=false` 恒 valley |
| U6 | `scripts/inbox-routing.test.mjs`（核心） | ① 空闲插入后 `model.current()` 立即返回目标（用假 agent 在 handler 返回后同步读）；② `select` 调用发生在任何 `request/header` 之前；③ 非 user 消息（runtime-context / model-selection notice）不触发 select；④ 同 turn 第二条 steer 不重选；⑤ 运行中 next-turn 不立即 select，`turn-stopping` 才 select；⑥ `enabled=false` 时 select 调用次数为 0；⑦ select 抛错时回合不崩（handler 不抛）；⑧ 不可路由时不 select 且产生 `model` warning；⑨ 目标=current 时仍调用一次 select、`changed=false`、`outcome=noop-same`，且不产生第二次切换 notice；⑩ 同 turn 预启动阶段的批内合并只保留最后一次 planned target；⑪ 目录/effort 冷或 llm 不可用时**不 select**、产生 `unverified`/`llm-unavailable` info warning，且 handler 不抛；⑫ high/mid 目标真不可用且 low 可用 → select low、`fallback='low'`、红告警保留；low 自身不可用或 advanced 不可用 → 不 select、保持 current |
| U7 | `scripts/request-passthrough.test.mjs` | 用真插件 + 假 ctx 调 `agent/request` handler：返回对象与入参**逐字段 deepEqual**；源码静态断言不存在 `provider:`/`reasoningEffort:` 改写（正则 + 行为双证） |
| U8 | `scripts/state-v2.test.mjs` | v1 state 读取；tombstone 不复活；500 上限；revision 单调；per-key updatedAt 合并 |
| U9 | `scripts/state-sync.test.mjs` | 两个「进程」共用临时目录：A 改 session x、B 改 session y，读回两者都在；外部改文件后内存跟随；锁超时不丢内存变更；陈旧锁清理 |
| U10 | `scripts/catalog-warning.test.mjs` | 目标 provider/model 不可用 → `model` warning 出现；目录恢复 + 刷新成功后 warning 自动清除；同一原因限流（只 1 条）；读不到目录/缓存未热时**不 select** 且产生 `unverified`/`llm-unavailable` info warning（不阻塞、不抛） |
| U11 | `scripts/host-compat.test.mjs` | §9.2 的 VERIFIED/REJECTED 与反控 |
| U12 | `scripts/verify.mjs` | 删除「`agent/request` prepend 覆盖」不变式；新增「`agent/inbox/inserted` + `{global:true}`」「`agent.model.select` 只在 inbox/turn-stopping 路径」「无 `agent/request` 改写」；文案 key、RPC 契约、版本、产物新鲜度照旧 |

一键：`cd dsh-bifenggang && npm test && node scripts/verify.mjs`（全绿退出码 0）。

### 10.2 静态/红绿反控（必须先红后绿）

| ID | 判据 | 命令 |
|---|---|---|
| S1 | 先证明 U7 能抓旧 bug：把 0.15 的 `agent/request` 改写段临时贴回 → U7 必须失败 | `node scripts/request-passthrough.test.mjs`（期望 exit 1）→ 删掉 → exit 0 |
| S2 | 先证明 U6⑤ 能抓「排队 followup 用错档」：去掉 turn-stopping 分支 → 测试失败 | 同上 |
| S3 | `grep` 源码无 `proposedConfig.provider =` / `...resolved,\n provider:` 之类改写 | `grep -n "provider:" lib/index.js` 人工核对 |

### 10.3 headless 通道（t12 产出，必须用真核心跑）

按 `docs/HEADLESS_VERIFY.md`（t12 交付；若尚未产出，用下列兜底）：

```powershell
npx --yes @deepseek-ai/dsh@0.2.2-rc.1 --version      # 必须是 0.2.2-rc.1
# 独立 DSH_HOME + --profile headless + --patch <临时 patch，插入本仓库 lib/index.js>
# 断言：debug.log 出现 apply: v0.16.0；构造目标≠会话模型的一次 turn；
#       日志顺序 inbox: decision -> inbox: select -> pre-step match=true -> request: observed config=目标
#       无 "after step preparation fixed"
```

| ID | 判据 | 证据 |
|---|---|---|
| H1 | `apply: v0.16.0` + `host: model-select present` | debug.log |
| H2 | 目标 ≠ 会话模型时，`request: observed ... config=<目标>`，且无 `after step preparation fixed` | debug.log + 退出码 0 |
| H3 | 关开关后 `request: observed` 回到原模型；`inbox: select` 0 条 | debug.log |
| H4 | `probe` 返回的 decision 与真实 `inbox: decision` 同 tier/target | RPC/日志对比 |

> 桌面端不能热切换 generation（t3 实证），所以 headless 是 t10 唯一「不重启桌面端也能验真核心」的通道；t11 的桌面端验收必须在**用户冷启动后**再做。

### 10.4 桌面端验收（0.16.0 安装后，用户重启 DSH Desktop）

| ID | 场景 | 操作 | 断言 |
|---|---|---|---|
| D1 | 安装/加载 | Plugin Manager 装本地仓库 → **完全退出并重启** | `profiles/desktop/package.json` = 0.16.0；`apply: v0.16.0`；`get.version='0.16.0'` |
| D2 | 默认行为不变 | 不动配置，发一条消息 | `tierRouting.enabled=false`；tier=low；无 select 差异日志（no-op-same）或 select=flash@low；无 throw |
| D3 | 目标≠当前 | 等 `model catalog refreshed` 日志（目录预热完成）；把低档谷时模型改成另一个已注册 provider/model（如 `deepseek-account/*` 或已登录的 `codex/*`），发消息 | `inbox: select -> B`；`pre-step match=true`；`request: observed B`；回合成功 |
| D4 | 三档 | 打开分级；中档/高档取消「跟随低档」并各配不同目标；分别发「为什么这样设计」「帮我改 lib/index.js 第 120 行」「跑一下测试」 | 三条日志 tier 分别 high/mid/low，目标各自对应 |
| D5 | 成本决策 | 低档 `costRouting=true`，把峰时窗口设成覆盖「现在」，峰时目标 B2；发消息 | `costReason=peak`，目标 B2；把窗口移开 → `peak-outside`，目标 valley |
| D6 | 每档可关 | 低档 `costRouting=false`，峰时窗口仍覆盖现在 | `costReason=cost-off`，目标恒 valley |
| D7 | 节假日 | 把今天加入 holidays，峰时窗口覆盖现在 | `costReason=peak-holiday`，目标 valley |
| D8 | 12:00 边界 | 窗口 `09:00-12:00`，`probe({at:'...T12:00:00+08:00'})` | valley（end 不含）；`11:59` → peak |
| D9 | max 优先级 | 会话模型选择器选 `max` 思考（或配置 baseline@max），发消息 | `axis=max`、目标 advancedSupport；关闭分级也成立 |
| D10 | 不可路由告警 | 用 `set` RPC/手改 policy 把目标 model 改成 `does-not-exist`；发消息 | 回合不失败；`get.warnings` 有 `kind='model'`；GUI 横幅可见；把目标改回并 [刷新模型列表] → warning 消失 |
| D11 | 跨窗口开关 | 开两个窗口；A 切换开关；B 不刷新 | ≤3 秒 B 显示相同状态（或聚焦即更新） |
| D12 | 跨窗口配置 | A 保存配置；B 打开设置且有未保存草稿 | B 显示「配置已在其它窗口更新」，不静默覆盖；点重新加载后一致 |
| D13 | 多进程不丢键 | 两个 DSH 进程共用 DSH_HOME；A 改 session x、B 改 session y | 最终 state.json 两个键都在；revision 递增；无整表覆盖 |
| D14 | 恢复 | 开启并路由到 B 后关闭开关 | 会话模型回到介入前的 A；`restore:` 日志；用户手改过则不动 |
| D15 | 重启持久 | 重启后重开同一会话 | 模型选择器显示最后路由目标；`restore` 仍在；关闭开关能恢复 |

D1-D15 中，D1/D2/D3/D10/D11/D14 是「必须通过」；其余为功能验收。桌面端断言以 `debug.log`/`get`/界面文案为准；`POST /api/...` 直接调会 401（t3 实测），不要用 curl 验收。

### 10.5 `verify.mjs` 口径更新

- 删除 `[/agent\/request/, ...]` 与 `[/\{ global: true, prepend: true \}/]` 两条 must。
- 新增：
  - `[/agent\/inbox\/inserted/]` + `[/\{ global: true \}/]`（同一注册附近）。
  - `!/agent\/request: overriding/`、`!/agent\/request: routed/`（旧文案禁用）。
  - `[/agent\.model\.select/]` 出现，且只出现在 `onInboxInserted` / `onTurnStopping` / `applyDecision` 调用链（可用函数名 + 文件断言，行为测试兜底）。
- DEFAULTS 检查改为：三档齐全、`advancedSupport` 非空、`tierRouting.enabled === false`。
- 版本一致性照旧（`package.json` ↔ CHANGELOG ↔ README/SKILL）。

---

## 11. 施工顺序与文件清单（给 t5-t9）

| 顺序 | 任务 | 文件 | 依赖本文 |
|---|---|---|---|
| 1 | 配置 v2 + 迁移 + 成本决策 | `lib/routing.js`（新，或并入 `lib/index.js`）、`lib/text.js`、`scripts/config-v2.test.mjs`、`scripts/migrate-v1.test.mjs`、`scripts/migrate-equivalence.test.mjs` | §2 §3 |
| 2 | 接缝替换 + 只读 request | `lib/index.js`、`scripts/inbox-routing.test.mjs`、`scripts/request-passthrough.test.mjs`、`scripts/verify.mjs` | §1 §9.2 |
| 3 | 分级器 | `lib/classifier.js`、`lib/index.js`、`scripts/classifier.test.mjs` | §4 |
| 4 | 告警 | `lib/index.js`、`lib/text.js`、`scripts/catalog-warning.test.mjs` | §5 |
| 5 | 状态同步 | `lib/state.js`（新）或 `lib/index.js`、`scripts/state-v2.test.mjs`、`scripts/state-sync.test.mjs` | §6 |
| 6 | GUI | `src/client/*`、`lib/text.js`、`lib/client.js`（构建产物）、`scripts/copy.test.mjs`、`scripts/catalog-refresh.test.mjs` | §7 §8 |
| 7 | 版本/文档 | `package.json`、`CHANGELOG.md`、`README.md`、`SKILL.md`、`scripts/host-compat.test.mjs` | §9 |

**复用清单（不要重写）**：`writeJsonAtomic`、`debugLog`、`withTimeout`、`toProviderOption` / `toModelOption` / `isSelfProvider` / `SELF_PROVIDER_IDS`、`peakModelSource` 的嵌套兼容、`minutesOf` / `timeInWindows` / `isHoliday`、`loadStateFile` / `sessionsToJson`、RPC envelope（`readEnvelope` / `serverResponse` / `rpcError` / `fetchRouteFor`）、`lib/text.js` 文案单一来源、`src/build-client.mjs`、`scripts/*` 的断言风格、`Map` 会话表（整数键顺序注释）。

### 11.1 现有测试/脚本的处置（不处置就会红）

| 文件 | 现状 | 0.16.0 处置 |
|---|---|---|
| `scripts/roundtrip.test.mjs` | 围绕 v1 `strategies[0].peak` 往返 | **拆成** `config-v2.test.mjs`（v2 往返）+ `migrate-v1.test.mjs`（v1 兼容）；旧的 peak 形状回归并入前者的 legacy 段 |
| `scripts/session-state.test.mjs` | 用 `DEFAULTS.strategies` 断言默认目标 | 改为用 `DEFAULTS.targets.low.valley` / `effective`；新增「tierRouting=false 恒 low」「get.sessions 仍是布尔」断言 |
| `scripts/copy.test.mjs` | 断言 `advancedSupport` 旧错误文案 | 保留 max 必填文案；新增附录 B 的 key 完整性（verify 已覆盖）与本地化映射 |
| `scripts/catalog-refresh.test.mjs` | 假 `StrategyEditor`、`draft.strategies` | 改为假三档卡片组件、`draft.targets.low`；仍断言「刷新不重载草稿 / 失败保留旧目录」 |
| `scripts/session-fuzz.mjs` | 直接操作 `state.json` 的 `{enabled,sessions:{id:bool}}` | 改为 v2 形状；期望值仍独立从磁盘重算；新增 tombstone/merge 场景（或由 `state-sync.test.mjs` 覆盖，fuzz 只保留会话隔离） |
| `scripts/verify.mjs` | `DEFAULTS.strategies.length`、`agent/request prepend` | 按 §10.5 改 |

> 这些不是「可选优化」：`npm test` 在 0.16.0 必须全绿，旧测试要么改要么删（删必须有替代覆盖）。t5 先在评论里报「旧测试清单 + 处置」，再动代码（t5 任务描述已要求）。

---

## 12. 明确不做 / 已否决的方案

1. **不在 `agent/request` 里做任何字段改写**（包括「只在旧核心回退」）：会重新引入 0.2.2 的 throw，且双路径分叉。旧核心见 §9.3。
2. **不在 `agent/pre-step` 里改模型**：preStep 在 dispatch 前已取 `current()`（`:671`），改了也只影响下一步，表现为「首条永远不生效」。
3. **不做自动 cascade / 二次请求**：核心没有「换模型重跑」入口，`llm/stream` 是冻结请求；FrugalGPT 只取「成本-质量前沿」思想。
4. **不抄 embeddings / 向量库 / torch**：零依赖、离线、隐私；用特征加权 + 分位数校准（RESEARCH §1.2/§1.5）。
5. **不把 `dsh-usage-state` 当成本主信号**：无 provider→target 映射、可能 stale、无事件、无价格；0.16 的成本决策是「峰谷时间表」，不是账单归因。未来可做可选降级信号，失败 fail-open。
6. **不做跨午夜窗口**：沿用 v1 语义，配置校验拒绝 `end <= start`；需要时拆两段。避免 weekday 归属歧义。
7. **不做每档独立节假日**：节假日是日历事实；每档差异用窗口/星期/enabled 表达。
8. **不做自动改道（peak↔valley / advanced / restore）**：唯一例外是 §1.4 的「high/mid 真不可用且 low 可用 → 回退 low.valley」（t6 要求），且必须带红告警与 `fallback='low'`；其余失败保持 current。
9. **不做 GUI 权重滑块**：权重固定，只暴露两个阈值 + 样例试算 + 建议值。
10. **不承诺两个进程同时驱动同一会话**：核心不允许两个写句柄；只承诺状态/配置/恢复元数据不互相覆盖。

---

## 附录 A：决策示例（用于测试断言）

```jsonc
// 例 1：分级关，峰时窗内，costRouting=true
{ "axis":"tier", "tier":"low", "score":null,
  "tierReason":"tier-disabled", "costReason":"peak",
  "target":{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"low"} }

// 例 2：分级开，抽象问题，谷时
{ "axis":"tier", "tier":"high", "score":0.11,
  "tierReason":"tier-high", "costReason":"peak-outside",
  "target":{"provider":"<high.valley>"} }

// 例 3：baseline=@max
{ "axis":"max", "tier":"low", "score":null,
  "tierReason":"max-advanced", "costReason":null,
  "target":{"provider":"...","model":"...","reasoningEffort":"max"} }

// 例 4：costRouting=false
{ "axis":"tier", "tier":"low", "score":0.71,
  "tierReason":"tier-low", "costReason":"cost-off",
  "target":{"provider":"<low.valley>"} }
```

## 附录 B：新增文案 key（`lib/text.js`，zh/en 必须双语）

| key | zh |
|---|---|
| `tierRoutingTitle` | 智能程度路由 |
| `tierRoutingHint` | 开启后按消息的具象程度分三档：抽象→高档、中等→中档、具象执行→低档。默认关闭。 |
| `tierThresholdConcrete` | 具象阈值（≥ 此值走低档） |
| `tierThresholdMedium` | 中等阈值（≥ 此值走中档） |
| `tierProbeTitle` | 样例试算 |
| `tierProbePlaceholder` | 粘贴一段 prompt 试算档位 |
| `tierProbeRun` | 试算 |
| `tierProbeResult` | 分数 {score} · 档位 {tier} · 目标 {model} |
| `tierProbeFeatures` | 命中特征 |
| `tierFallbackLow` | 无文本/无法分级，已回退低档 |
| `targetsTitle` | 三档模型 |
| `tierLow` / `tierMid` / `tierHigh` | 低档（具象执行）/ 中档（中等）/ 高档（抽象） |
| `shareLow` | 跟随低档配置 |
| `shareLowHint` | 默认与低档共用同一张峰谷表；取消勾选后独立配置。 |
| `valleyModel` | 谷时模型 |
| `peakModel` | 峰时模型 |
| `costRoutingLabel` | 成本决策（峰时切到峰时模型） |
| `costRoutingHint` | 关闭后该档永远使用谷时模型，峰时窗口保留但不生效。 |
| `peakWindowsTitle` | 峰时窗口 |
| `peakWindowStart` / `peakWindowEnd` | 开始 / 结束 |
| `peakWindowAdd` | + 添加窗口 |
| `peakWindowInvalid` | 窗口必须同日且结束晚于开始（暂不支持跨午夜） |
| `holidaysTitle` | 法定节假日 |
| `holidaysHint` | 节假日全天走谷时。 |
| `holidayAdd` | + 添加日期 |
| `holidayInvalid` | 日期必须是 2000–2100 年之间的合法日期 |
| `advancedTitle` | 高级模型支援（max） |
| `advancedHint` | 仅在会话要求 max 思考时使用，不作为普通兜底。 |
| `warningTitle` | 路由告警 |
| `warningUnroutable` | 目标不可路由：{target}（{kind}）→ 已保持 {kept} |
| `warningUnverified` | 模型目录尚未就绪，本次暂不切换：{target} |
| `warningLlmUnavailable` | 模型服务不可用，本次暂不切换 |
| `warningHostUnsupported` | 当前核心不支持会话内路由（需要 0.2.2-rc.1 及以上） |
| `warningCleared` | 已恢复：{target} |
| `warningNone` | 没有路由告警 |
| `tierReasonDisabled` | 智能程度路由已关闭（恒低档） |
| `tierReasonLow` / `tierReasonMid` / `tierReasonHigh` | 具象执行 / 中等抽象 / 抽象 |
| `tierReasonOverrideSafety` | 高风险操作（安全 override）→ 高档 |
| `tierReasonOverrideHigh` | 用户要求深入思考 → 高档 |
| `tierReasonOverrideLow` | 用户要求直接执行 → 低档 |
| `tierReasonFallbackLow` | 无法分级，已回退低档 |
| `tierReasonMax` | 会话要求 max 思考 → 高级模型 |
| `outcomeSelected` / `outcomeNoop` / `outcomeUnroutable` / `outcomeSelectFailed` / `outcomeDisabled` | 已切换 / 无需切换 / 不可路由 / 切换失败 / 未启用 |
| `fallbackLow` | 主目标不可用，已回退低档 valley |
| `recentDecisions` | 最近决策 |
| `decisionApplied` / `decisionNoop` / `decisionUnroutable` | 已切换 / 已是最优 / 不可路由 |
| `restoreTitle` | 恢复原模型 |
| `restoreHint` | 关闭开关或点这里，把会话恢复成插件介入前的模型。 |
| `restoreOne` | 恢复 |
| `restoreAll` | 全部恢复 |
| `restoreMissing` | 没有可恢复的会话 |
| `hostBadgeOk` | 当前核心支持会话内路由 |
| `hostBadgeOld` | 当前核心过旧，路由不会生效 |
| `conflictTitle` | 配置已在其它窗口更新 |
| `conflictReload` | 重新加载 |
| `conflictOverwrite` | 用我的覆盖 |
| `reloadConfig` | 重新加载配置 |
| `costReasonPeak` | 峰时方案 |
| `costReasonValley` | 谷时方案 |
| `costReasonCostOff` | 该档已关闭成本决策 |
| `costReasonPeakDisabled` | 该档未启用峰时 |
| `costReasonWeekday` | 不在峰时星期 |
| `costReasonHoliday` | 法定节假日 |
| `costReasonOutside` | 不在峰时窗口 |
| `axisMax` | 会话要求 max 思考 |

## 附录 C：测试假 agent（t6/t10 可直接用）

```js
// scripts/lib/fake-agent.mjs（示意；不要依赖真实宿主）
export function makeAgent({ id = 's1', provider = 'p', model = 'm', effort } = {}) {
  const events = []
  let current = effort === undefined ? { provider, model } : { provider, model, reasoningEffort: effort }
  const agent = {
    id,
    session: {
      header: { id },
      requestHeader: () => undefined,
      append: (type, data) => { events.push({ type, data }); if (type === 'model/selection') current = { ...data }; return { seq: events.length } },
    },
    model: {
      current: () => ({ ...current }),
      select: (selection) => { const s = { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }; if (JSON.stringify(s) === JSON.stringify(current)) return; events.push({ type: 'select', data: s }); current = s },
    },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
  }
  return { agent, events, getCurrent: () => ({ ...current }) }
}
```

断言顺序（U6①）：派发 `agent/inbox/inserted` 后，**同步**调用 `agent.model.current()`，必须已经是目标；再模拟 `pre-step` → `agent/request`（返回 `current()` 的 config），必须与目标一致。

---

## 附录 D：给下游任务的一行接口

- t5：`normalizeConfig` / `resolveTargets` / `resolveCost` 按 §2 §3；`agent/request` 只读；select 前 `validateTargetSync`。
- t6：`classify(text, hasImage, opts)` 纯函数按 §4；一次 turn 一次；`tierRouting.enabled=false` 恒 low；max 优先级按 §4.5。
- t7：按 §7 布局与附录 B 文案；`probe`/`restore`/`sessionDetails`/`warnings` 按 §8。
- t8：warning 结构、自动清除、限流按 §5；不得改 fail-open。
- t9：state v2、合并、锁、watch、3 秒轮询、草稿保护按 §6。
- t10/t11：验收按 §10；桌面端 peer 是 advisory、generation 热切换无效按 §9.4/§9.5。
