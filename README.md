# 避峰岗（dsh-peak-valley-router）

> 峰时站岗换班：谷时让 DeepSeek 干苦力，峰时换 ChatGPT Plus 顶班，你的 API 账单从此不再被高峰期收割。

DeepSeek Harness 的跨 provider 峰谷路由插件 + 公开 SKILL。详见 [SKILL.md](./SKILL.md)。

当前版本：**v0.16.1**（pre-1.0）。版本号唯一来源是 `package.json`；运行时可在设置页标题下方或 `debug.log` 的 `apply: vX.Y.Z, …` 行确认当前加载的是哪一版。变更记录与版本策略见 [CHANGELOG.md](./CHANGELOG.md)。

宿主兼容：已在 `@deepseek-ai/dsh` **0.2.0-rc.2**、**0.2.1-rc.2** 与 **0.2.2-rc.1**（桌面端 0.14.0 内置核心，v0.16.0 起显式声明）上逐条核过接缝并实测加载；`peerDependencies` 逐条声明这三条线，**新的 rc 线不会被 `^0.2.x` 自动带入**，需要显式加一项——`scripts/host-compat.test.mjs` 会因此变红。

0.16.0 在 **0.2.2-rc.1 headless 真核**上验证了新接缝（`agent/inbox/inserted` 的 `select()`，见 `docs/VERIFICATION_routing_v2.md`）；无 GUI 复核方式见 `docs/HEADLESS_VERIFY.md`。`internal/get` 的默认模型层在 0.2.2-rc.1 未被读取，已降级——新会话首条消息不再预览路由目标。

0.16.1 起，**普通 subagent 与 AgentTeams 成员的消息也参与路由**：用户意图 source 为 `user` / `agent-teams`；`system-prompt`、`runtime-context`、`model-selection`、`subagent-settled`、`plugin` 等注入类明确排除。详见下文「子智能体 / AgentTeams 成员也受路由」。

设置页的 **刷新模型列表** 会重新拉取 Provider 和模型，不重载配置、不保存策略，也不清空尚未保存的选择；刷新时禁用重复点击，失败显示错误并保留旧目录。刷新读取宿主当前提供的模型列表，不承诺清除第三方适配器内部缓存。

## 它做什么

- **设置页「避峰岗」**：配置有序策略。每条策略 = 触发条件（生效星期 + 峰时窗口）+ 主模型（谷时）+ 可选副模型（峰时）。另有**高级思考模型**，它是**另一根轴**：只在会话本身要求 `max` 思考时使用（`reasoningEffort === 'max'`），**不作为未命中策略时的兜底**。未命中任何策略的时刻（周末、假期）→ 用**第一个方案的主模型**。设置页顶部会写明「此刻生效：model@effort · 原因」，例如「无匹配方案（周末/假期），用首个方案的主力模型」，所以任何一次目标都能解释，不会像故障。
- **智能程度路由（默认关闭，需手动开启）**：开启后按消息的具象程度分三档——抽象→高档、中等→中档、具象执行→低档。默认关闭时恒用低档，行为与 0.15 一致；阈值（具象 0.55 / 中等 0.28）可在设置页编辑，带迟滞与显式 override，另提供只读的样例试算。分类器是启发式：相邻档允许错分，但**跨档反档必须为 0**（0.16.0 验收口径；冻结集/留出集见 `docs/VERIFICATION_routing_v2.md`）。
- **成本决策路由（每档独立，默认开）**：每一档都有自己的峰谷表与 `costRouting` 开关；关闭某档的成本决策，该档就恒用谷时目标。低/中/高三档默认共用低档配置（`{ share: 'low' }`），可取消跟随改为独立表。
- **峰谷窗口与节假日可编辑**：设置页直接增删峰时窗口和节假日（按年分组、内置 2025/2026/2027 整年预设）；窗口必须 start < end 且不跨午夜，非法输入就地报错。
- **目标不可路由时可见告警**：不可用目标会回退并显示红/黄告警（`get.warnings`），`recentWarnings` 保留 cleared 历史；不再只在 `debug.log` 里静默回退。
- **跨窗口/多进程状态同步**：`state.json` v2（revision + 每键时间戳 + tombstones + applied/restore）用锁 + 原子写 + 逐键较新合并；设置页可见时 3 秒轮询，多窗口不一致时给「重新加载/用我的覆盖」冲突条；`set` 带 `expectedRevision` 乐观并发。
- **子智能体 / AgentTeams 成员也受路由**：消息 source 为 `user` 或 `agent-teams` 时按用户意图分级/路由；`system-prompt`、`runtime-context`、`model-selection`、`subagent-settled`、`plugin` 等注入类排除；未知 source 跳过并记 `source-kind:<kind>` 限流日志。分级前会剥离 `AgentTeams message from …:` / `Agent <id> sent a message:` 投递前缀。
- **首启引导**：第一次打开设置页会显示一条可关闭、不阻塞保存的引导条（默认关闭、三档含义、每档峰谷表/节假日在哪），保存一次后不再出现；是否首次由 `get.firstRun` 判定（启动时无 `policy.json`=true，本进程保存成功后=false，v1 迁移文件存在=false）。
- **Provider / 模型一律下拉选择**：候选来自运行时**已注册的全部 provider**——API 与你装的订阅套餐并列（如 DeepSeek、ChatGPT Plus / Codex、Claude、Grok、Copilot、Antigravity），模型经该 provider 的 `listModels` 接口读取。避峰岗自身**不会**出现在候选里：它是 provider 之上的一层选择器逻辑，不是 provider。
- **左侧「启用避峰岗」开关**：默认关闭 = 纯透传，行为与未装插件一致。开启后由避峰岗决定实际调用的模型，**连会话里已经选过的模型也会被改写**（会话自带的模型选择器本身不改动，只做功能接管 + 尽力而为的置灰提示）。启用状态有独立于策略配置的全局默认与每会话覆盖；要让某个已有会话生效，检查该会话实际使用的开关状态，而不只看全局开关。
- **每会话独立状态 + 会话列表小灯 + 全局解耦**：
  - **全局 = 总闸**：侧边栏底部那个开关，切换它会对所有「跟随中」的会话一次性生效（扫一遍）。
  - **局部可单独改**：composer 输入区左侧第一个按钮切换**当前会话**；一旦单独改过，该会话就**不再被全局切换带走**（两个方向都是）。
  - **显式的「全局解耦」开关**：composer 左侧第二个按钮。两个圆环相接＝跟随全局，分开＝已解耦；点一下在「解耦 / 接回」之间切换。它**只切换连接关系**，不改变此刻是否生效。右键第一个按钮也能恢复跟随（等价快捷方式）。
  - **会话列表小灯**：每行一个微微发蓝光的小灯，亮 = 该会话此刻生效；已解耦的会多一圈淡环。全局默认开着时每行都会亮（它们跟随默认），只有被单独关掉的会话不亮。
  - **全局侧可见**：侧边栏开关的提示里会显示「· N 个已解耦」。
  - **已知限制**：行首位置由宿主条件渲染，下列四种行**不渲染**该插槽，小灯在这些时刻不显示——归档（archived）、空白（blank）、**正在运行**（显示状态点）、**有未读标记**。依据：`.recon/workspace.client.js` 里 `!row.archived && !row.blank && (showStatus ? … : unread ? … : renderSlot("sidebar.session.row.leading", …))`。这是宿主行为，插件不去改它。
  - 另需注意：小灯反映的是**开关意图**，不是"此刻一定生效"。若策略目标不在 provider 目录里（模型下线/改名），插件会保持会话原模型并写入 `warnings`（设置页红/黄横幅），`debug.log` 同时留一行 `warning: …`；目录恢复后自动清除。
- **多端可用**：开关同时挂在左侧边栏底部与 composer 输入区左侧。窄屏（<1024px 侧边栏自动收起、Windows/macOS 收起态整列宽度为 0）时由 composer 入口兜底，两个入口共享同一份状态。

## 目录

- `SKILL.md` — 「避峰岗」技能说明
- `lib/index.js` — Node 端：RPC、每会话开关、`agent/inbox/inserted` 接缝、告警与状态接入
- `lib/routing.js` — 配置 v2 规范化 / v1 迁移 / 峰谷与三档决策
- `lib/classifier.js` — 智能程度分类器（纯函数，无 I/O）
- `lib/state.js` — `state.json` v2 状态存储（锁 + 原子写 + 跨进程合并/轮询）
- `lib/text.js` — **唯一维护文件**：默认定义（`DEFAULTS`）+ 中英文案（`zh`/`en`）
- `src/client/*.js` — 客户端源码（开关 / 选择器 / 档位卡片 / 设置页 / 入口）
- `lib/client.js` — **生成物**：由 `src/build-client.mjs` 拼接各 source 并注入 `lib/text.js` 文案，请勿手改
- `src/build-client.mjs` — 客户端构建脚本
- `scripts/verify.mjs` — 仓库自检（契约、不变式、版本一致性、产物新鲜度）
- `scripts/config-v2.test.mjs` / `migrate-v1.test.mjs` — v2 配置与 v1→v2 迁移
- `scripts/classifier.test.mjs` / `tier-routing.test.mjs` / `cost-routing.test.mjs` / `probe.test.mjs` — 三档分类、成本决策与只读试算
- `scripts/catalog-warning.test.mjs` — 目标不可路由告警与自动恢复
- `scripts/state-sync.test.mjs` / `restore.test.mjs` — 跨进程状态合并与「恢复原模型」
- `scripts/inbox-routing.test.mjs` / `request-passthrough.test.mjs` — 新接缝与 `agent/request` 只读
- `scripts/agent-teams-source.test.mjs` / `first-run.test.mjs` — 子智能体/AgentTeams source 路由、首启 `firstRun`
- `scripts/t10-*.mjs` — 独立验证脚本（分类器校准、接缝、状态 I/O、跨窗口、0.15 差分）
- `scripts/copy.test.mjs` — 界面文案单一来源与本地化映射检查
- `scripts/session-state.test.mjs` — 每会话状态语义（覆盖 / 跟随默认 / 清除 / 容量上限 / 会话 id 读取）
- `scripts/host-compat.test.mjs` — 宿主兼容回归：声明的 `peerDependencies` 必须接受**已实测的宿主线**（`0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.2-rc.1`）、并且必须排除相邻 rc 线与大版本；自带反控
- `scripts/session-fuzz.mjs` — 随机化差分属性测试：200 次随机操作 × 12 个探针 id（含 `__proto__`、`constructor`、超长与 Unicode id），**期望值独立地从 `state.json` 重算**，用来抓跨会话串扰与身份透传违规（`npm run fuzz`，可传种子）
- `docs/HEADLESS_VERIFY.md` — 无 GUI 的 headless 验证通道（0.2.2-rc.1）
- `docs/VERIFICATION_routing_v2.md` — 0.16 独立验证报告
- `docs/RELEASE_0.16.0_CHECKLIST.md` / `docs/RELEASE_0.16.1_CHECKLIST.md` — 各版本重启后逐条验收清单
- `CHANGELOG.md` — 变更记录与版本策略
- `cordis.patch.yml` — 自激活 patch（bundle 安装用）
- `package.json` — 插件清单（含 `dsh.client` 声明）

## 开发

```bash
node src/build-client.mjs   # 重建 lib/client.js（改了 src/client 或 lib/text.js 后必跑）
npm test                    # 18 套 node 测试
npm run verify              # 仓库自检 + 全套测试（只读，不写任何产物）
npm run fuzz                # 只跑随机化差分属性测试（可传随机种子）
```

`npm run verify` 覆盖：文案 key 完整性/双语对称、client↔node RPC 契约、关键不变式
（`inject=['llm']`、新接缝 `agent/inbox/inserted`、`agent/request` 只读、无 `registerAdapter`/`llm/stream` 残留、
未触碰会话模型选择器）、版本一致性（`package.json` ↔ `CHANGELOG.md` ↔ `README.md`/`SKILL.md`
的「当前版本」）、产物新鲜度（**构建到临时文件比对，不重写仓库里的产物**）、仓库顶层文件集合、
界面文案无硬编码中文、每会话状态语义、宿主兼容区间（含反控）、随机化差分属性测试，以及 0.16 新增的
三档分类/成本决策/告警/状态同步/迁移回归。

无 GUI 复核（不重启桌面端）：按 `docs/HEADLESS_VERIFY.md` 用 `@deepseek-ai/dsh@0.2.2-rc.1` + 隔离
`DSH_HOME` 启动 headless 回合，看隔离目录下 `plugins/dsh-peak-valley-router/debug.log` 的
`apply: vX.Y.Z` 与 `inbox: decision … tier=…` 行。

## 安装

1. 装成 bundle（推荐，GUI 生效）：
   ```bash
   dsh plugin --profile web add <本仓库路径或 git URL>
   ```
2. 或手工 patch `insert`（仅 Node 端，无 GUI）：
   ```yaml
   - insert:
       - id: dsh-peak-valley-router
         name: <本仓库/lib/index.js 绝对路径>
         config: { ...见 SKILL.md 的配置结构... }
   ```

装完**重启 DSH**，打开「设置 → 避峰岗」即可在 GUI 里配置多模型协同策略。

## 峰谷规则

- 高峰：北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00
- 谷时：其余时间（含周末、节假日全天），价格为峰时 1/2

## 运行时数据

插件只在 `DSH_HOME/plugins/dsh-peak-valley-router/` 下写三个文件：

- `policy.json` — GUI 保存的 v2 配置：`schemaVersion`、`revision`、`utcOffsetMinutes`、`holidays`、`tierRouting`、`targets.low/mid/high`、`advancedSupport`。v1（`strategies`）会被自动迁移；旧策略只读保留在 `legacy` 快照。
- `state.json` — 开关与同步状态（v2）：`revision`、`updatedAt`、`enabled`/`enabledUpdatedAt`、`sessions`/`sessionsUpdatedAt`、`tombstones`、`applied`/`appliedUpdatedAt`、`restore`/`restoreUpdatedAt`、`restorePending`/`restorePendingUpdatedAt`。`enabled` 是**全局默认**，`sessions` 是**每会话覆盖**表（上限 500 条，按最近写入淘汰）；合并按每个键的 `*UpdatedAt` 取较新者。旧文件（只有 `enabled`）行为不变。
- `debug.log` — 诊断日志：`apply: vX.Y.Z`、`inbox: decision … tier=… target=…`、`inbox: select`、`warning: …`、目录刷新与开关切换。

## 已知限制

- **每条被路由消息一次 `state.json` 原子写**（含 no-op；已实测 3 条消息 revision 1→3）：高频会话需关注写入量。
- **坏 `state.json` 时 fail-closed**：文件原样保留、不清空，但开关回默认 `false`，该回合纯透传、**不路由**（不是「路由仍能工作」）。
- **冷启动首条消息可能 `unverified` 不路由**：provider 目录/effort 未热时记 info 告警并跳过，等
  `model catalog refreshed (adapters-updated)` 后第二条重试。
- **`internal/get` 默认模型层在 0.2.2-rc.1 未被读取，已降级**：新会话首条消息不再预览路由目标；以 `debug.log` 的 `inbox: decision` 为准。
- **分类器为启发式，相邻档允许错分**（冻结集 6 条、留出集 3 条）；**跨档反档必须为 0**，这是 0.16.0 的验收口径。智能程度路由**默认关闭**，需手动开启。
- **节日日期合法性 1970–2100**：非法日期（如 2026-02-30）不再报错，而是被丢弃并给 info `invalid-holidays` 告警（保存合法列表后清除）。注意这是行为变更：**2000 年以前的合法日期现在会通过**。
- **UTC 偏移会被钳制**：`utcOffsetMinutes` 非数字/缺失回默认 480，其余四舍五入后夹在 `[-720, 840]`。
- **`plugin` source 不路由**：它被视为「已知非意图」（released-format 宿主上的 AgentTeams 包装消息）；当前桌面端的 `agent-teams` source 正常。
- **`firstRun` 的外部创建边界**：进程启动后才由外部进程创建 `policy.json` 时，`firstRun` 在本进程成功保存一次之前仍为 `true`（不影响引导关闭后的行为）。
- **配额/限流不归避峰岗管**：它只决定"用哪个 provider/model"。若目标 provider 的账号池处于 429 冷却（如订阅套餐的 5 小时窗口用尽），请求会在 provider 层失败。避峰岗不会自动改道到别的模型——那会让"为什么换模型"变得不可预测；需要时请改配置或暂时关掉开关。
- **目标不可路由时现在会告警**：目录里没有该 model / provider 未注册 / effort 不可用 → 保持会话原模型并写入 `warnings`（设置页红/黄横幅），目录恢复后自动清除；`debug.log` 同时留一行 `warning: …`。
- **行首小灯的显示条件**：见上文「每会话独立状态」一节的四条隐藏条件（宿主行为）。
- **并发点击**：写盘期间开关按钮是禁用的，被丢弃的那次点击不会报错（没有队列）。
