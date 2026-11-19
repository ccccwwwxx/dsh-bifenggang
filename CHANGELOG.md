# 更新日志 / Changelog

本文件记录所有值得注意的变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

**版本号只有一个来源：`package.json`。** 运行时可在两处确认当前加载的是哪一版：

- 设置 → 避峰岗，标题下方的 `版本 vX.Y.Z`；
- `debug.log` 中每次加载插件时的那一行：`apply: vX.Y.Z, enabled=…`。
  （`DSH_HOME/plugins/dsh-peak-valley-router/debug.log`）

## 版本策略（pre-1.0）

当前处于 **0.x**：功能与界面已可用，但**路由语义、设置页布局、内部接缝（`agent/request` / `internal/get`）仍可能在小版本之间调整**。

`policy.json` / `state.json` 的字段保持向后兼容：新增字段只追加，旧文件无需迁移；历史上写出的嵌套 `peak.model` 写法仍然可读。

**1.0 的条件**：路由语义与配置格式冻结，并经过若干个版本的实际使用。在那之前的破坏性变更会写在下面。

## [0.17.7] - 2026-11-20

**按主控声明路由**：任务记录里的 `judgement` 取代文本评分。

- `execute` → 低档（沿用峰谷策略；命令失败本身不升档）
- `coverage` → 中档（Sol High）
- `adjudicate` → 高档（Astra Max）

优先级：单 Session 显式覆盖 > 声明 > 文本评分；旧任务无声明时仍按任务文本评分。
决策记录 `tierReason=declared:<judgement>` 与 `scoreSource=declared:<taskId>:<judgement>`，
便于发现派单标错。

## [0.17.6] - 2026-11-20

**新成员首单按派单任务评分**：宿主自己生成子会话的第一条提示，任务记录无法挂在它上面，
改由 `member-started` 事件（`payload.task`）携带，路由器按会话缓存并在该会话的第一次决策
消费（只消费一次）。已有成员续单继续使用消息 source 上的 `agentTeamsTask`。

## [0.17.5] - 2026-11-20

**正式派单按任务记录评分**：档位不再被派单信封（作业说明 + 质量契约 + 验收清单）稀释。

### 变更

- AgentTeams 在派单消息的 `source.agentTeamsTask` 上携带 `{ taskId, subject, description }`
  （来自它自己的任务记录）；成员仍然收到完整正文、质量契约与验收要求。
- 分类器优先用 `subject + description` 作为评分输入，正文不再参与评分；`taskId` 记录到
  `lastDecision.scoreSource`（形如 `task:t1`）与 `debug.log` 的 `score-source:` 行，便于与团队
  任务记录核对。
- 没有该字段的消息（普通聊天、旧消息、其他插件来源）行为完全不变；单 Session 显式覆盖优先级不变。
- 新成员首单也带该字段：派单任务改为创建后再以成员提示投递（创建提示保留欢迎语），避免宿主
  自行生成的创建提示丢掉结构化字段。

### 验证

- `role-binding`：派单按任务记录评分、排队消息各自独立不串单、无任务记录的消息保持原行为。
- 前后回放：同一描述作为裸文本 0.73（低档），作为派单信封 0.50（中档），改后回到 0.73。

## [0.17.4] - 2026-11-20

**续跑成员的目录过期修复**：空闲超过 TTL 后，成员的下一条任务不再沿用旧模型。

### 修复

- **keep-warm 定时预热**：启用期间每 `MODEL_CATALOG_TTL_MS / 2`（30s）刷新模型目录与 effort 缓存，
  空闲一分钟不再让缓存正好过期；过期瞬间到达的派单因此仍能按角色目标选择。
- **未验证时立即刷新**：某轮因 `catalog-cold`/`effort-cold` 保留旧模型时，立刻触发一次刷新，
  使下一条任务能在本轮请求前应用角色目标。
- **刷新请求排队**：刷新在途时到达的请求不再被丢弃（此前一次慢刷新会让 adapters-updated /
  keep-warm 的刷新被吞掉，目录保持空的直到下一分钟）。
- 可用性检查未放宽：仍然「未验证不切」，并在 `lastDecision.warningKind` / `debug.log` 记录
  原因与实际保留的模型。

### 验证

- `role-binding`：新增“冷目录保留旧模型且记录原因”“刷新成功后下一条任务应用角色目标”两项。
- 81 实机：同一验证者两次派单间隔 144 秒，第二次首请求 `pre-step modelSelection=codex/gpt-6.2-astra@max expected=… match=true`。

## [0.17.3] - 2026-11-20

**绑定可等待**：让首条任务在**冷启动**下也能按角色选模。

### 修复

- `agent-teams/member-started` 的 ack 现在带 `ready`（Promise）：绑定角色时立刻预热该角色所有
  目标（`target` + `tiers.*`）的模型目录与 reasoning effort。AgentTeams 在创建子会话前 `await`
  这个 Promise（上限 10s），所以第一条消息到达时缓存已经是热的。
- 根因记录：headless/冷启动时 provider 适配器在 `apply` 之后才注册，首次派单会命中
  `catalog-cold`/`effort-cold`，路由器按既有安全策略「不切」→ 首轮沿用创建模型。这是 0.17.2
  实机验证里「实现者计划 v4-pro@high、实际 flash@high」的原因。

### 验证

- `scripts/role-binding.test.mjs`：ack.ready 必须是可等待的 Promise（新增断言），其余 12 项通过。

## [0.17.2] - 2026-11-20

**识别 0.2.2-rc.5 的 `plugin` 包装来源**——这是成员派单一直没被路由的真正原因。

### 修复

- 本宿主（0.2.2-rc.5）把插件写入的消息存成 `{ kind: 'plugin', plugin: '<包名>' }`。
  AgentTeams 的每次派单（含首条任务）都走这个包装，而避峰岗把 `plugin` 归为「注入上下文」直接跳过，
  所以成员的 `inbox: decision` 根本不产生——角色绑定成功、路由却没发生。
- 现在：`plugin` 来源且 `plugin === '@nanmicoder/dsh-agent-teams'` 视为**执行意图**；其他插件的
  `plugin` 消息仍是注入上下文（不路由）。这是宿主给出的结构化来源标识，不是对提示词的猜测。

### 验证

- 隔离团队实机（81，pv-verify profile）：团队创建成功、两名成员绑定到 `实现者`/`验证者` 规则；
  修复前成员的后续派单只有 `pre-step` 观察、无 `inbox: decision`。

## [0.17.1] - 2026-11-20

**角色绑定改到「创建之前」**：修复首次派单时角色可能尚未生效的问题。

### 修复

- **绑定先于创建**：AgentTeams 现在先预留 child id 并同步发 `agent-teams/member-started`，再调用
  子会话创建。因此成员的第一条消息（**可能直接就是任务正文**）进入 inbox 时角色已经在 state 里，
  按角色规则选模成立；不再依赖「第一条消息一定是欢迎语」的顺序假设。
- **移除「跳过首条消息」的延迟启发**：0.17.0 会为每个新子会话跳过一次路由，若首条消息是任务就会
  以创建模型执行；同时普通子会话也被误跳过一次。现在没有任何跳过逻辑。
- **成员恢复**：冷启动恢复时 AgentTeams 会再次广播同一角色，绑定幂等（不新增条目、不清覆盖），
  每个新任务重新分级选模——同一验证者可以从 mid（Sol High）切到 high（Astra Max）。
- **普通子会话**：没有绑定角色的子会话完全走原峰谷策略（0.17.0 的 pending 跳过已删除）。

### 验证

- `scripts/role-binding.test.mjs`（10 项）：首条消息即任务、恢复后 mid→high、普通子会话、显式覆盖、
  重启持久化、绑定失败可见。

## [0.17.0] - 2026-11-20

**角色规则（roleRules）+ 成员角色绑定**。用于 AgentTeams：验证者/实现者这类团队角色不再被
三档峰谷表随机改模型，同时普通会话完全不受影响。

### 功能

- **policy v2 `roleRules`**（默认 `[]`）：每条规则按 `name`（+ `match` 别名）匹配会话角色，三种形态：
  - `target`：每轮固定模型（例：实现者 → `deepseek-official/deepseek-v4-pro@high`）；
  - `tiers.{low,mid,high}`：按档位分别指定，**未列出的档位回落到原峰谷策略**
    （例：验证者 mid → `codex/gpt-6.2-sol@high`、high → `codex/gpt-6.2-astra@max`，low 仍走峰谷）；
  - `decouple: true`：完全不干预该会话（成员用自己的团队模型）。
- **优先级**：单 Session 显式覆盖（`sessions[id]`）> 角色规则 > 全局峰谷；关闭全局开关时角色规则同样不生效。
- **state v2 `roles`**：`sessionId -> 角色名`，含 `rolesUpdatedAt` 与**独立** `roleTombstones`
  （清角色不会误清会话开关），逐键较新合并、上限淘汰、重启后仍有效。
- **绑定时序**（关键）：`subagent/start`（同步，早于首条消息）标记「成员待绑定」→ 该成员的
  **欢迎消息不路由**（沿用创建时的模型）→ AgentTeams 在拿到 `childId` 后同步 emit
  `agent-teams/member-started {teamId, sessionId, name, role}` → 路由落库。因此**第一条正式任务
  消息之前**绑定一定完成，且不依赖任何固定延时。
- **绑定失败可见**：emit 带可变 ack 对象，监听方同步填写 `{ok, reason}`；未绑定/无角色/无匹配规则
  分别是 `missing-session-id` / `no-role` / `no-matching-rule`，并写入 `debug.log`。
- **RPC**：`get.roles`、`setRole`（返回命中规则，供操作者查询当前生效规则）。
- **effort 预热**：角色规则的 `target`/`tiers` 目标也会预热 `resolveModelInfo`，避免首条消息
  因 `effort-cold` 保留旧模型（看起来像规则没生效）。

### 兼容 / 已知边界

- `schemaVersion` 仍为 2；旧 `policy.json` 无 `roleRules` 时行为完全不变（默认空规则）。
- 自动绑定依赖 AgentTeams 侧补丁 `dsh-agent-teams` 0.1.32-pv.1（本地分支，仅新增一条
  `member-started` 通知；未打补丁时绑定事件不会到达，角色规则不会被触发，其余功能正常）。
- 欢迎消息不路由是**有意的**：此时角色尚未绑定，按成员创建模型运行最安全。

## [0.16.1] - 2026-11-19

**子智能体路由修复 + 节日校验/UTC 钳制 + 首启引导 + `get.firstRun`**。

### 修复

- **子智能体路由（本次最实质的行为修复）**：普通 subagent 的消息一直按 `user` source 参与路由；
  AgentTeams 成员投递的消息此前用 `agent-teams` source，被 inbox 的「仅 user」筛选跳过，表现为成员会话
  完全不走避峰岗。0.16.1 把 `agent-teams` 纳入用户意图，**成员会话现在也会产生
  `inbox: decision → inbox: select → pre-step: … match=true` 并按策略路由**。
  - 用户意图 source：`user`、`agent-teams`。
  - 明确排除的注入类：`system-prompt`、`runtime-context`、`model-selection`、`subagent-settled`、`plugin`。
  - 未知 source：跳过路由，并记一行 `source-kind:<kind>` 限流日志，便于以后扩展。
  - 分级前剥离首行投递前缀 `AgentTeams message from …:` / `Agent <id> sent a message:`（只做分类预处理，
    阈值/权重未动）。

### 节日校验 / 时区钳制

- **节日日期合法性校验**：合法范围 **1970–2100**（`Date.UTC` 回读校验真实日历日）。这是**行为变更**：
  2000 年以前的合法日期现在会通过（旧实现下限为 2000）。
- 非法日期（如 2026-02-30、2027-02-29）不再让整份配置报错，而是逐条丢弃并计数；`get.warnings` 出现
  info 级 `invalid-holidays`（`extraCount=N`、同 key 限流），保存合法列表后自动清除。配置其余部分照常可用。
- **UTC 偏移钳制**：`utcOffsetMinutes` 非数字/缺失回默认 480；其余四舍五入后夹到 **[-720, 840]**。

### 首启引导

- **设置页首启引导（first-run guide）**：非弹窗、可关闭、不阻塞保存的引导条，说明「默认关闭需手动开启 /
  三档含义与默认共用低档 / 每档峰谷表与节假日在哪」；保存一次后不再出现。
- **`get.firstRun`（新字段，布尔）**：启动时 `policy.json` 不存在 → `true`；存在（v1 或 v2，含迁移文件）
  → `false`；本进程 `set` 成功后置 `false`（校验失败/写盘失败保持 `true`）。设置页优先读该字段，缺失时
  回退 `configRevision <= 1` 推断并用 `legacy` 排除 v1 老用户。

### 兼容 / 已知边界

- `schemaVersion` 仍为 2；v1 `strategies` 自动迁移逻辑未变；`peerDependencies` 未变。
- `plugin` source 仍视为「已知非意图」：released-format 宿主上的 AgentTeams 包装消息不会触发路由；
  本次只承诺当前桌面端的 `agent-teams` source。
- **外部进程创建 policy.json 的边界**：进程启动后才由外部进程创建 policy.json 时，`firstRun` 在本进程
  成功保存一次之前仍为 `true`（不影响引导关闭后的行为）。
- 节日校验只校验日期是否为真实日历日，不校验「是否落在已配置的峰时星期」。

## [0.16.0] - 2026-11-19

**智能程度路由（默认关闭）+ 三档峰谷表 + 可见告警 + 跨窗口状态同步**。
0.15 的单策略配置自动迁移为 v2 `targets.low`（旧策略只读快照保留在 `legacy`）；旧文件无需手工迁移。

### 历史整合

本版建立在 `origin/master` 之上，历史与原 0.14.x/0.15 线合并为一条线性历史（旧线保留在分支 `backup/pre-rebase-016` 与标签 `v0.14.0` / `v0.14.1` / `v0.15.0`）。
远端 0.13.x 线的 `integrations/cc-haha/` 与 `market/` 元数据**完整保留**；其另外四项特性（节日日期合法性校验、UTC 偏移钳制、首次使用引导、market 版本号）尚未并入，计划在 0.16.1 补齐（见 `docs/RELEASE_0.16.0_CHECKLIST.md` 末尾的待办）。`scripts/roundtrip.test.mjs` 已由 `config-v2.test.mjs` + `migrate-v1.test.mjs` 取代。

### 功能

- **智能程度路由（默认关闭，需手动开启）**：`tierRouting.enabled=false` 时恒用低档，行为与 0.15 一致；开启后按消息的具象程度分三档——抽象→高、中等→中、具象执行→低。阈值可编辑（`concreteThreshold` 默认 0.55、`mediumThreshold` 默认 0.28），带 10 分钟迟滞与显式 override（safety / low-explicit / high-explicit）；空文本/纯图片回退低档。设置页提供样例试算（`probe` RPC，只读不落盘）与两阈值编辑。
- **成本决策路由（每档独立，默认开）**：`targets.<tier>.costRouting` 为 true 时该档在峰时窗口使用峰时目标，false 时恒用谷时；low/mid/high 默认都开，每档可单独关闭。
- **每档各自的峰谷表**：`targets.low` 独立；`targets.mid` / `targets.high` 默认 `{ share: 'low' }` 跟随低档整张表，取消跟随后可独立配置谷时模型、峰时开关/星期/窗口/峰时模型。
- **峰谷窗口与节假日可编辑**：设置页支持时区偏移、节假日增删（按年分组、内置 2025/2026/2027 整年预设）；峰时窗口必须 start < end 且不跨午夜，非法输入就地报错。
- **目标不可路由时可见告警**：`get.warnings[]`（红/黄分级、上限 20）与 `recentWarnings[]`（含 cleared 历史、上限 50）；不可用目标回退并告警，不再静默。v1 多策略迁移产生 `legacy-extra-strategies` 提示。
- **跨窗口 / 多进程状态同步**：`state.json` v2 带 `revision`、各键 `*UpdatedAt`、`tombstones`、`applied`、`restore`、`restorePending`；锁 + 原子写 + 逐键较新合并。`set` 支持 `expectedRevision` 乐观并发，冲突返回 `stale-revision`；设置页可见时 3 秒轮询。

### 新接缝

- 路由改写从 `agent/request` 改到 `agent/inbox/inserted` 的 `select()`：在 step preparation **之前**固定模型选择，满足 0.2.2-rc.1 的硬校验（在 `agent/request` 之后改 provider/model/effort 会抛 `after step preparation fixed`）；`agent/request` 改为只读观测（返回 `next()` 同一对象）。
- 真核实测（0.2.2-rc.1 headless）：`inbox: decision → inbox: select → pre-step match=true → request: observed`，目标≠会话模型不再报错；同环境 0.15.0 反向证伪成立（见 `docs/VERIFICATION_routing_v2.md`）。

### 迁移与兼容

- `schemaVersion: 1` 的 `strategies` 自动迁移为 v2 `targets.low`（峰时表/星期/窗口一并迁移）；第 2 条及以后不再参与路由，但保留在只读 `legacy` 快照中，并给出 `legacy-extra-strategies` 提示。无需手工改文件。
- `advancedSupport` 仍是独立的 max 轴（只在会话显式要求 `max` 时使用，不作为未命中兜底）。
- `peerDependencies` 增加 `^0.2.2-rc.1`（已在 0.2.2-rc.1 真核实测）；`^0.2.0-rc.2 || ^0.2.1-rc.2` 保留。
- 配置/状态仍向后兼容：新增字段只追加；历史上写出的嵌套 `peak.model` 写法仍可读。

### 已知边界（验收口径）

1. 每条被路由消息一次 state.json 原子写（含 no-op；已实测 3 条消息 revision 1→3）。
2. 坏 state.json 时 fail-closed：开关回默认 false、该回合不路由，文件原样保留不清空。
3. 冷启动首条消息可能因目录/effort 未热而 info unverified 不路由，第二条重试。
4. `internal/get` 默认模型层在 0.2.2-rc.1 未被读取，已降级（新会话首条消息不再预览路由目标）。
5. 分类器为启发式，相邻档允许错分（冻结集 6 条、留出集 3 条），**跨档反档必须为 0**，这是我们认可的验收口径。

### 测试与文档

- 16 套 node 测试接入 `npm test` / `npm run verify`：新增 config-v2 / migrate-v1 / cost-routing / classifier / tier-routing / probe / catalog-warning / state-sync / restore / inbox-routing / request-passthrough；`scripts/roundtrip.test.mjs` 被 v2 接缝测试取代并移除。
- README / SKILL 更新 v2 配置示例与已知限制；新增 `docs/HEADLESS_VERIFY.md`、`docs/VERIFICATION_routing_v2.md`、`docs/RELEASE_0.16.0_CHECKLIST.md`。

## [0.15.0] - 2026-11-18

**默认值切换为 DeepSeek Flash fail-safe**：默认配置不再把会话押在 ChatGPT（`codex`）订阅额度上。

- `lib/text.js` 的 `DEFAULTS`：策略改为**全周**（`weekdays: [1..7]`）`deepseek-official/deepseek-flash` @ `low`；`peak.enabled: false`（峰时窗口保留但不参与路由）；`advancedSupport` 改为 `deepseek-official/deepseek-flash` @ `max`。
- 动机：GPT 订阅额度枯竭时（`usage_limit_reached` / HTTP 429），旧默认把工作日峰时段和 `max` 思考请求路由到 `codex`，表现成「一装避峰岗就报错」。新默认在订阅额度不可用时仍在官方 DeepSeek Flash 上工作；「峰时切订阅模型」仍是受支持能力，只是需要显式开启并显式配置副模型。
- 路由逻辑未改（`lib/index.js` 不动）：`resolveSelectionDetailed` 仅在 `peak.enabled` 为真且峰时窗口命中时才走峰时分支；默认配置下工作日峰时与周末都解析为策略主模型（`reason=primary`），峰时分支不触发。
- 测试：`scripts/session-state.test.mjs` 补 `advancedSupport` 的 `reasoningEffort` 断言（实际下发必须与默认一致）、断言默认目标必须全部留在官方 DeepSeek Flash，并新增「默认配置在工作日峰时窗口与周末均不触发峰时分支」的回归。
- 文档：README / SKILL 的「当前版本」与 SKILL 的默认换班表、配置示例同步为新默认。

## [0.14.1] - 2026-10-28

- 保存成功后显示明确的成功 Toast，并仅在 `set` RPC 正常返回后显示；失败时显示错误提示，不会误报成功。
- 刷新模型列表按钮继续保留，并与保存状态反馈区分显示。

## [0.14.0] - 2026-10-28

- 设置页新增常驻「刷新模型列表」按钮，重新读取 Provider 和模型，不重载或保存策略，不改变未保存编辑与当前选择。
- 刷新期间显示加载状态并阻止重复点击；失败可重试并保留此前目录。客户端启用严格目录错误信封，避免将请求失败伪装成空目录；旧 RPC 调用保持降级行为。
- 修复当前核心公开 `agent.id` 身份下的每会话开关识别，兼容旧的嵌套 session 字段。
- 跨模型路由且策略未指定思考档时，不再携带原模型的显式思考档。
- 当前 npm next 为 0.2.1-rc.4，同属 0.2.1 预发布三元组，现有 peer 范围已覆盖，无需放宽至未经验证的 0.2.2-alpha。
- 新增设置页刷新组件回归：重拉目录、刷新状态、重复点击、草稿保留及失败保留。客户端现场 Inspect 超时，尚未完成真实页面视觉验收；不宣称 rc.4 完整启动验证。

## [0.13.0] - 2026-10-18

**新核心 0.2.1-rc.2 适配版**：逐条核对接缝、在真核心上跑过，结论是**代码不用改，声明的兼容区间必须改**。

### 背景

桌面端 `0.12.0` 仍绑宿主包 `0.2.0-rc.2`；npm 上 `@deepseek-ai/dsh` 的 `next` 是 **`0.2.1-rc.2`**
（`latest` 仍是 `0.2.0-rc.2`）。本版是拿 `0.2.1-rc.2` 的独立核心（`core-switch.ps1` 那一套）逐项验的。

### 接缝核对（先看目录，再看真核心）

用宿主自带的机器可读目录 `dsh-tool-cordis/lib/types/api-catalog.js` 做逐条比对
（旧核心 609,169 字节 / 新核心 663,240 字节）：

- **事件**：`agent/request`、`agent/request-error`、`llm/adapters-updated` 的签名与 waterfall/emit
  模式**逐字相同**。新增的只有 `plugin-market/changed`。
- **服务**：`agentDefaultModel` 的方法表完全相同（`currentSelection()` / `saveSelection()`）；
  `llm` 只有**新增**（`imageRequestTarget()`、`prepareCall()` 多一个可选 `configure` 参数），
  避峰岗用到的 `listProviders()` / `listModels(provider)` 没动；
  `connection` 的 `fetch.register` / `rpc` 仍在（`operator` 改名 `browserPeer`，本插件没用它）。
  服务总体是「多 8 个、少 1 个」：新增的 8 个（`workingDirectory` / `webApp` / `worktrees` / `translator` …）
  与删掉的 1 个（`invariants`）都没有被本插件引用。
- **cordis**：`4.0.4` → `4.0.5`；`{ global: true, prepend: true }` 这两个监听选项仍在
  —— 也就是「避峰岗在 `agent/request` 里最外层改模型」这件事依然成立。
- **客户端**：`sidebar.footer.action`、`conversation.input.left`、`sidebar.session.row.leading`、
  `settings.section` 四个插槽都在；`ctx.locale.register/bind`、`connection.rpc.call('/api', …)`
  签名不变。

### 实测（0.2.1-rc.2 独立核心，隔离 DSH_HOME）

- 插件装进 profile 后正常加载：`apply: v0.12.0, enabled=true, … llm -> true`。
- 三条 RPC（`get` / `providers` / `models`）全部 **HTTP 200**；`get` 里的 `active` 决策正确
  （周日 → `fallback-first-primary`），说明策略引擎与 `llm.listProviders()` 在新核心上都在工作。
- 客户端模块确实被宿主打包下发：`dsh-peak-valley-router` 出现在 page 预载的 client bundle 里。
- 用 `dsh --profile headless --patch`（只把插件插进这一棵树）真跑了一个 turn：
  `agent/request: routed model "deepseek-official/deepseek-flash" is not in the provider catalog`
  —— 该 home 没有 `DEEPSEEK_API_KEY`，请求在 provider 层以 `MISSING_CREDENTIAL` 结束（零 token 消耗），
  但**接缝真的被执行了**，这一行就是证据。
- 最后把它装进真正会被启用的那个 home（`home/0.2.1-rc.2-shared`，会话与桌面端共享）再跑一次：
  `apply: v0.13.0, enabled=false, … llm -> true`；`get` 回包的 `version` 是 `0.13.0`；
  客户端模块同样出现在该 home 下发的 client bundle 里。安装用 `dsh plugin --profile web add <本仓库>`，
  但 CLI 只写了 `dependencies`、**没有把包名加进 `dsh.profile.bundles`**，手动补一行才被加载。
- 该 home 里组件默认仍是**关闭**（`state.json` 未写，行为与未装插件一致），要不要打开由你决定。

### 修复（唯一硬阻塞）

`peerDependencies` 里的 `@deepseek-ai/dsh-llm` 原本是 `^0.2.0-rc.2`，而它**不接受 `0.2.1-rc.2`**：
semver 里预发布版本只能被「点名了同一个 `[major, minor, patch]` 三元组」的区间接受，
`0.2.1-rc.2` 与 `0.2.0-rc.2` 不是同一个三元组（实测 `satisfies('0.2.1-rc.2', '^0.2.0-rc.2') === false`）。
接缝全是好的，但强制 peer 的插件管理器会因此把安装/激活判成「与宿主不兼容」。

- 区间改为 **`^0.2.0-rc.2 || ^0.2.1-rc.2`**（后续每条 rc 线都要显式加一项，不会被 `^0.2.x` 自动带入）。
- 同时去掉 `^0.1.1-rc.2` / `^0.1.7-rc.1`：那两条是历史声明，当前代码没有在 0.1.x 上验过；
  留着等于宣称一种没人测过的兼容。

### 新增

- `scripts/host-compat.test.mjs`：把「声明的区间必须接受已实测宿主、且必须排除相邻 rc 线与大版本」
  钉成回归测试，并**自带反控**（先断言 `^0.2.0-rc.2` 拒绝 `0.2.1-rc.2`，证明检查器不是恒真）。
  已接进 `npm test` 与 `npm run verify`。

### 顺带观察（未改，留档）

手工编辑 `state.json` 时若带 UTF-8 BOM，`JSON.parse` 会抛错，插件按「关闭」静默处理
（验证过程中踩到一次）。GUI 写出的文件没有 BOM，所以只影响手工编辑；要修的话是在解析前剥掉 BOM，
属于独立的一件事，不混进本版。

## [0.12.0] - 2026-10-17

**DSH 0.12.0 兼容版**：逐个核对最新宿主的接缝，并把「此刻为什么是这台模型」变成界面上看得见的一行。

### 背景（升级排查结论）

DSH 桌面端由 0.11.x 升到 **0.12.0**（宿主包 `@deepseek-ai/dsh-*` 全部 `0.2.0-rc.2`），同时第三方
`dsh-plugin-subscriptions@0.9.9` 把 ChatGPT/Claude/Grok 等订阅变成 provider，新增**模型优先级**、
**池成员轮换**与 **429 冷却**；`codex` 目录新增 `gpt-6.1-sol`（priority 1）与 `gpt-6-sol`。

按宿主自带的事件目录（`api-catalog`）逐条核对后确认**避峰岗的接缝没有断**：
`agent/request` 的 payload 仍带 `agent`（由 `@deepseek-ai/dsh-scope` 在分发时注入），
`internal/get`、`llm.listProviders()` / `llm.listModels()` 以及三个客户端插槽（`sidebar.footer.action`、
`conversation.input.left`、`sidebar.session.row.leading`）全部照旧。

真正的现象是：**周末/假期没有任何策略匹配 → 落到 `advancedSupport` 兜底**，而兜底目标恰好配额耗尽
（HTTP 429 `usage_limit_reached`），于是表现为"避峰岗一开就报错"。这是设计行为叠加 provider 配额状态，
不是接口断裂——但它此前只写在 `debug.log` 里，界面上完全看不出来。

### 语义修正（重要，定义改了两处）

原来把 `advancedSupport`（高级模型支援）当成了「**没有方案匹配时就用它**」的兜底。在"方案都是周一到周五"
这类常见配置下，那等于**整个周末和假期把所有会话都顶到最贵的高级模型上**——这次就是这么把 `codex/gpt-6-astra`
的订阅池额度烧穿的（HTTP 429 `usage_limit_reached`，5 小时窗口）。现在按正确的划分改写：

> `{ 方案们（主力模型、错峰模型），高级思考模型 }` —— 高级思考模型是**另一根轴**，不是兜底方案。

- **无方案匹配（周末/假期）→ 用第一个方案的「主力模型」**（不再用高级模型）。
- **高级思考模型只在「会话本身要求 max 思考」时使用**（`reasoningEffort === 'max'`），与时间无关；
  普通请求（low/medium/high/xhigh）永远不会被升到它。
- 完全没有配置方案时，高级思考模型是唯一目标，用它是合理的，原因标记为 `advanced-only`。

### 新增

- **设置页顶部「此刻生效：provider/model@effort · 原因」**。原因取值：峰时方案 / 平时方案 /
  无匹配方案（周末/假期，用首个方案的主力模型）/ 未配置方案只有高级思考模型 / 会话要求 max 思考 / 无可用目标；
  末尾还会附上「会话要求 max 思考时→X」，把高级模型这根独立的轴写在明面上。
- `get` RPC 新增 `active` 字段（当前目标 + 原因 + 星期 + 是否假期 + `advancedForMax`），供界面与外部脚本读取。
- 路由日志带上原因，例如 `... via fallback-first-primary`。

### 修复

- `peerDependencies` 里的 `@deepseek-ai/dsh-llm` 由精确的 `0.2.0-rc.2` 放宽为 `^0.2.0-rc.2`，
  0.2.0-rc.3 / 0.2.x 宿主不再被判为不兼容。
- 随机化属性测试第 4 阶段（重载）的假模型目录只列了 `gpt-5.6-luna`，周六会落到 `advancedSupport`
  的 `gpt-6-astra` 而被目录校验拦下——**该用例会随"今天星期几"随机失败**。已补齐目录，使它只在真缺陷时失败。
- 排查中抓到并修掉自己的一处回归：`logOverride` 少写 `reason` 形参，导致每次路由抛
  `reason is not defined` 被 catch 吞掉、整体退化为"不路由"（属性测试 1174 项失败当场暴露）。

### 与 Provider 配额的关系（重要）

避峰岗只决定"用哪个 provider/model"，**不管理配额**；目标池冷却时请求会在 provider 层失败。
按修正后的语义，周末/假期只会落到方案的**主力模型**，不会消耗高级模型的额度；
只有你（或会话）明确要求 max 思考时才会动用高级思考模型。想单独规定周末用哪个模型，
照旧加一条 `weekdays: [6, 7]` 的方案即可。

## [0.11.0] - 2026-10-15

**显式的「全局解耦」小开关**：把「这个会话跟不跟随全局」变成一件可见、可控的事。

### 语义（明确下来）

- **全局 = 总闸**：切换它对所有「跟随中」的会话一次性生效（扫一遍）。
- **局部单独改过的会话不再被全局切换带走**——两个方向都不跟随；要重新跟随就显式接回。
- **解耦 / 接回只切换连接关系**，不改变「此刻是否生效」。

### 新增

- composer 输入区左侧新增第二个小开关「解耦」（两个圆环相接＝跟随全局，分开＝已解耦）：
  - 跟随中 → 点一下**解耦**：把当前有效值固定为本会话的独立值，可见状态不变，此后全局切换不再影响它；
  - 已解耦 → 点一下**接回**：清除独立值，重新跟随全局。
- 会话列表小灯对已解耦的会话多一圈淡环，提示文案也区分「跟随全局 / 已解耦」。
- 侧边栏的全局开关提示里显示「· N 个已解耦」——否则解耦过的会话在全局侧完全不可见。
- 第一个按钮的右键「恢复跟随全局」保留，作为接回的快捷方式。

### 工程

- `scripts/verify.mjs` 的文案 key 校验此前只匹配 `t('key')`，漏掉带参数的 `t('key', { … })`；已修正。这次 `decoupledCount` 的命名不一致（客户端叫 `decoupledCount`、文案表写成 `decoupleCount`）正是被放宽后的正则与 copy 测试一起抓出来的。
- 新增断言：已解耦的会话在全局**两个方向**翻转时都不跟随，接回后重新跟随。

## [0.10.2] - 2026-10-14

独立复核（对抗性）报出的缺陷修复。复核的 9 项必查全部通过，以下是我据此改掉的真问题。

### 修复

- **整数型会话 id 不再被提前淘汰**：JS 对象会把整数型键排到最前并按升序枚举，所以「删除后重新赋值」**不会**把它移到末尾——`"0"` 这种 id 刚设置完就会被当成最旧条目淘汰，覆盖**静默消失**（与 0.10.1 修的 `__proto__` 属于同一类静默丢失）。内存里的覆盖表改用 `Map`（插入顺序对所有键形状都精确）；落盘仍是 `{ id: boolean }` 对象，旧文件与客户端契约不变。补了针对整数型 id 的回归断言（旧的容量测试只用 `s${i}`，抓不到）。
- **非字符串 `sessionId` 不再静默变成全局开关**：`toggle { sessionId: 12345, enabled: false }` 过去会走进"没有会话 id"的分支，把**所有**会话的默认路由关掉，而且回包里没有 `sessionId` 字段，调用方根本看不出走了哪个分支。现在「存在但不是非空字符串」一律返回 `bad-request`，并记一行日志。
- **`toggle` 的两种参数形状语义统一**：按会话的路径在不传 `enabled` 时会翻转当前有效值，而全局路径过去是**静默 no-op**。现在全局路径同样翻转。
- **视觉接管不再闪烁**：挂载/卸载与取值更新拆成两个 effect。此前每次切换都会先注销（清掉注入的样式与 `html` 属性）再重新注册，模型选择器的置灰会闪一下。
- **首次加载不再先显示错误状态**：第一次 `rpc.get` 返回前不渲染开关（此前会先显示"未启用"再翻成真实状态）。读失败仍会渲染并带 `!` 标记。

### 工程

- `npm run verify` 改为**只读**：产物新鲜度检查现在把客户端**构建到临时文件**再比对，不再重写仓库里的 `lib/client.js`；比对前统一换行符，CRLF 检出不再误报"产物陈旧"。
- 版本一致性守卫扩展到文档：`README.md` 与 `SKILL.md` 的「当前版本」行必须与 `package.json` 一致。此前 README 停在 `v0.9.0` 而 package.json/CHANGELOG/tag 都已是 0.10.x，旧守卫只核对 CHANGELOG，所以一直是绿的。
- 新增随机化差分属性测试（`npm run fuzz`，可传种子）：200 次随机操作 × 12 个探针 id（含 `__proto__`、`constructor`、超长与 Unicode id），期望值独立地从 `state.json` 重算。

### 文档

- README 补齐行首小灯的**四条**隐藏条件（归档 / 空白 / 正在运行 / 有未读），此前只写了两条。
- 新增「已知限制」一节：跨窗口与多进程不同步（后写覆盖整张 `sessions` 表，无合并）、目标模型不在目录时静默回落（小灯反映的是开关意图而非此刻必生效）、并发点击在写盘期间被禁用且不报错。

## [0.10.1] - 2026-10-14

### 修复

- 覆盖表改用 null-prototype 映射：会话 id 若是 `__proto__` 这类特殊键，在普通对象上赋值会被原型 setter 静默吞掉——覆盖看起来存下了、却永不生效。node 端与客户端两处都改，并加了回归断言。

## [0.10.0] - 2026-10-14

**每会话独立的避峰岗状态**，并在会话列表上用一个小蓝灯标出哪些会话开着。

### 新增

- 开关从「全局」扩展为「全局默认 + 每会话覆盖」：没有覆盖的会话跟随全局默认，单独设置过的会话以自己的状态为准。`state.json` 里 `enabled` 是默认值，`sessions` 是每会话覆盖表；**没有 `sessions` 的旧文件行为完全不变**。
- 会话列表行首小灯：注册在 `sidebar.session.row.leading`，仅当该会话的有效状态为开时出现（小圆点 + 柔和外发光 + 极缓慢呼吸，尊重 `prefers-reduced-motion`）。
- 会话内开关（composer 输入区左侧）改为操作**当前会话**；**右键**可清除覆盖、恢复为跟随全局默认。侧边栏底部的开关仍然是全局默认。
- 覆盖表有上限（500 条，按最近写入淘汰），长期使用不会无限增长。

### 变更

- `get` RPC 增加 `sessions`（每会话覆盖表）。
- `toggle` RPC 支持 `{ enabled, sessionId }` 与 `{ sessionId, inherit: true }`。
- 模型选择器的置灰改为跟随**当前会话**的有效状态（会话内入口优先），不再只看全局开关。
- 日志里的接管/决策行带上会话 id，便于核对是哪个会话被路由。

### 说明与已知限制

- 会话 id 取自 `agent.session.header.id`（`session.id` 同值）。读不到时按**全局默认**处理，不会静默关闭路由。
- 行首位置由宿主决定：会话**正在运行（有状态点）或有未读标记**时，宿主不渲染该插槽，因此小灯在这些时刻不显示。这是宿主的条件渲染，插件不去改它。

## [0.9.0] - 2026-10-14

首个公开版本（V0.9）。

### 功能

- 按时间路由：策略 = 生效星期 + 峰时窗口；命中峰时用副模型，否则用主模型。
- 高级模型支援（升维兜底）：所有策略都未命中时使用。
- 设置页三档下拉：Provider / 模型 / 思考档；候选全部来自 harness 运行时的注册表，**API key 与订阅登录同源**，没有硬编码名单。
- 左侧「启用避峰岗」开关（侧边栏入口 + 会话输入区备用入口），按控件**自身容器宽度**自适应。
- 开关打开时，策略对**模型与思考档**均有决定权：会话里已显式选定的模型同样会被接管。
- 模型级兜底：策略目标不在该 Provider 目录中时保留原模型，绝不阻塞请求；目录刷新全程在后台，请求路径不等待网络。
- 版本可在运行时确认（设置页与 `debug.log`）。

### 修复（0.9.0 定版前修掉）

- **副模型形状错配**：服务端曾把副模型写成嵌套的 `peak.model = {provider, model, …}`，而设置页与 `lib/text.js` 默认定义读的是扁平字段 `peak.provider` / `peak.model`。后果是每次 get/set 往返后副模型下拉变空，且保存时被静默替换成主模型。现在输出统一为扁平；旧的嵌套写法仍能被读入，并在下次保存时改写为扁平。
- **思考档不生效**：模型相同但思考档不同时曾被判定为"无需改写"，导致策略里配的思考档失效。现在思考档不同同样按策略改写。
- **加载安全性**：非法配置不再让插件加载失败，而是回退到默认定义并留一行日志。
- **请求路径零阻塞**：过期的目录刷新曾发生在请求路径上（同步发起 `listModels`），已移出到下一个宏任务。
- **事件作用域**：`llm/adapters-updated` 补上 `global`，避免依赖作用域默认行为。
- **界面文案**：英文界面下星期显示中文（硬编码）已移入文案表；服务端校验报错中文化并保留「第几条策略」；保存后给出明确的成功/失败反馈。

### 工程

- `lib/text.js` 是**界面文案与默认定义的唯一维护文件**；客户端产物 `lib/client.js` 由 `src/build-client.mjs` 生成，不手工编辑。
- 测试：`npm run verify` = 契约自检 + 副模型往返回归 + 文案与本地化检查。
