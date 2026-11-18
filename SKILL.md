---
name: bifenggang
description: "避峰岗：谷时让 DeepSeek 扛大梁，峰时换 ChatGPT Plus 顶班。按峰谷时段自动切换模型，别让高峰期把你的 API 账单薅秃。"
---

# 避峰岗（Peak Avoidance Post）

> 当前版本 **v0.16.1**（pre-1.0）。版本号唯一来源是 `package.json`；运行时可在「设置 → 避峰岗」标题下方或 `debug.log` 的 `apply: vX.Y.Z, …` 行确认。变更记录与版本策略见 [CHANGELOG.md](./CHANGELOG.md)。
>
> 宿主兼容：已在 `@deepseek-ai/dsh` **0.2.0-rc.2**、**0.2.1-rc.2** 与 **0.2.2-rc.1**（桌面端 0.14.0 内置核心）上实测；`peerDependencies` 逐条声明这三条线，新 rc 线要显式加进去（见 `scripts/host-compat.test.mjs`）。无 GUI 复核见 `docs/HEADLESS_VERIFY.md`。

站岗的人都知道：该换班就换班，别死磕。DeepSeek 的 API 现在也是这个道理——峰时价格翻倍、谷时半价。避峰岗就是给你的模型调用排一张「换班表」：谷时让 DeepSeek 干苦力（便宜），峰时换 ChatGPT Plus 顶班（订阅费反正已经付了）。

## 换班表（峰谷规则）

DeepSeek 官方峰谷定价（2026-08-17 起）：

- **高峰时段**：北京时间周一至周五（不含中国法定节假日）`09:00–12:00`、`14:00–18:00`
- **空闲时段**：其余全部时间，含周末与法定节假日全天
- 闲时价格 = 峰时的 1/2

## 它能干什么

一个挂在 DeepSeek Harness（DSH）里的模型路由策略引擎，支持：

1. **三档智能程度路由（默认关闭）**：开启后按消息的具象程度分档——抽象→高、中等→中、具象执行→低；阈值可编辑，带迟滞/override 与只读样例试算。关闭时恒用低档（与 0.15 行为一致）。
2. **每档各自的峰谷表**：低/中/高三档各有谷时模型、峰时开关/星期/窗口/峰时模型；中/高默认 `{ share: 'low' }` 跟随低档，取消跟随后独立。
3. **成本决策路由（每档独立，默认开）**：每档一个 `costRouting` 开关；开启时峰时窗口切到该档峰时目标，关闭时恒用谷时。
4. **峰谷窗口与节假日可编辑**：设置页直接增删窗口/节假日（内置 2025–2027 整年预设），窗口必须 start < end 且不跨午夜。
5. **可见告警与跨窗口同步**：目标不可路由时回退并显示红/黄告警（含 cleared 历史）；`state.json` v2 + 3 秒轮询让多窗口/多进程保持一致。
6. **高级思考模型**：与时间无关的独立一档，只在会话要求 `max` 思考时启用；旧名 `exclusive` 仍兼容，但它不是"未命中就兜底"。
7. **GUI 配置**：设置页里直接编辑三档、窗口、节假日，不用手改 JSON。
8. **子智能体 / AgentTeams 成员路由（0.16.1）**：用户意图 source 为 `user` / `agent-teams`；`system-prompt`、`runtime-context`、`model-selection`、`subagent-settled`、`plugin` 等注入类明确排除；未知 source 跳过并记 `source-kind:<kind>` 限流日志。分级前剥离 `AgentTeams message from …:` / `Agent <id> sent a message:` 投递前缀。
9. **首启引导**：第一次打开设置页显示可关闭的引导条（默认关闭、三档含义、峰谷表/节假日在哪），保存一次后消失；是否首次由 `get.firstRun` 判定（启动时无 `policy.json`=true，本进程保存成功后=false，v1 迁移文件存在=false）。

默认换班表（0.16.0 起；智能程度路由默认关闭 → 实际恒用低档）：

| 场景 | 用谁 | 说明 |
|---|---|---|
| 低档（默认落点，全周任意时刻） | `deepseek-official` / `deepseek-flash` @ low | 官方 Flash 低思考档，不依赖订阅额度 |
| 中档 / 高档 | 默认 `{ share: 'low' }` 跟随低档 | 开启智能程度路由且未取消跟随时，三档共用低档配置 |
| 会话显式要求 `max` 思考 | `deepseek-official` / `deepseek-flash` @ max | 独立的「高级思考」轴，与时间无关 |
| 各档峰时窗口（默认关闭） | 需显式开启并配置峰时目标 | 开启后按该档 `peak.weekdays/windows` 切到订阅 provider（如 `codex`） |

## 安装与配置

插件本体是 `dsh-peak-valley-router`（本仓库的 `package.json` + `lib/`），可通过 DSH 插件管理装成 bundle，或直接 patch 层 `insert`。

配置结构（`cordis.patch.yml` 或设置页写入的 `policy.json`，v2）：

```yaml
config:
  schemaVersion: 2
  revision: 1                    # 乐观并发用；设置页保存时自动递增
  utcOffsetMinutes: 480          # 北京时间 UTC+8
  holidays: [[2026, 10, 1], [2026, 10, 2]]  # 中国法定节假日，全年谷时

  tierRouting:                   # 智能程度路由：默认关闭 → 恒低档
    enabled: false
    concreteThreshold: 0.55      # ≥ 此值 → 低档（具象执行）
    mediumThreshold: 0.28        # ≥ 此值 → 中档；再低 → 高档（抽象）
                                 # 两个阈值都在 0–1，且 concrete > medium

  targets:
    low:                         # 低档：具象执行（默认落点）
      valley:                    # 谷时目标
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: low
      costRouting: true          # 成本决策：峰时窗口用峰时目标
      peak:
        enabled: false           # 默认不切峰时
        weekdays: [1, 2, 3, 4, 5, 6, 7]
        windows: [["09:00", "12:00"], ["14:00", "18:00"]]
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: low

    mid:  { share: low }         # 中档：默认跟随低档整张表
    high: { share: low }         # 高档：默认跟随低档整张表
    # 取消跟随时改成独立表（示例）：
    # high:
    #   valley: { provider: deepseek-official, model: deepseek-v4-pro }
    #   costRouting: true
    #   peak:
    #     enabled: true
    #     weekdays: [1,2,3,4,5]
    #     windows: [["09:00","12:00"]]
    #     provider: deepseek-official
    #     model: deepseek-v4-pro

  advancedSupport:               # 会话显式要求 max 时的升维目标（独立轴，不是兜底）
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: max
```

### 旧版（0.15 及以前）配置的兼容

- `schemaVersion: 1` 的 `strategies` 会自动迁移为 v2 `targets.low`：第一条策略的 `primary`/`peak`/`weekdays` 原样搬过去；**第 2 条及以后不再参与路由**，但保留在只读 `legacy` 快照里，并在设置页给出 `legacy-extra-strategies` 提示。无需手工改文件。
- 旧的 `exclusive` 是 `advancedSupport` 的别名，仍兼容；历史上写出的嵌套 `peak.model` 写法仍可读。

路由规则：先按智能程度分档（关闭时恒低档）→ 在命中档内按该档峰谷表选择：`costRouting=true` 且当前落在 `peak.windows`（且是 `peak.weekdays`、非节假日）→ 用峰时目标；否则用 `valley`。目标不可路由（provider/model 不在目录、effort 不可用）时保留会话原模型并写入红/黄告警，不再静默。**高级思考模型只在会话本身要求 `max` 思考时使用**，与时间无关，不会被当作未命中的兜底。设置页顶部会写明「此刻生效：model@effort · 原因」，并显示档位来源与成本决策原因。

### 已知边界（验收口径）

1. 每条被路由消息一次 `state.json` 原子写（含 no-op；已实测 3 条消息 revision 1→3）。
2. 坏 `state.json` 时 fail-closed：开关回默认 false、该回合不路由，文件原样保留不清空。
3. 冷启动首条消息可能因目录/effort 未热而 info unverified 不路由，第二条重试。
4. `internal/get` 默认模型层在 0.2.2-rc.1 未被读取，已降级（新会话首条消息不再预览路由目标）。
5. 分类器为启发式，相邻档允许错分（冻结集 6 条、留出集 3 条），**跨档反档必须为 0**；智能程度路由默认关闭，需手动开启。
6. 节日合法范围 **1970–2100**（行为变更：2000 年以前的合法日期现在会通过）；非法日期被丢弃并给 info `invalid-holidays` 告警，保存合法列表后清除。UTC 偏移四舍五入后夹在 `[-720, 840]`。
7. `plugin` source 视为已知非意图，旧宿主上的 AgentTeams 包装消息不触发路由；当前桌面端的 `agent-teams` 正常。
8. 外部进程在启动后创建 `policy.json` 时，`firstRun` 在本进程保存一次前仍为 true（不影响引导关闭后的行为）。

## 依赖注意

- 插件**零 DSH 包 import**：只用 `ctx` 服务 + `process.env.DSH_HOME` + Node 内置 `fs/path`，避免绝对路径加载时解析不到依赖。
- ChatGPT Plus 的 `codex` provider 由 `dsh-plugin-subscriptions`（OAuth 登录）提供，插件只按名引用、用 `ctx.llm.listProviders()` 动态列出给 GUI 选，不重复实现登录。

## 维护

- `holidays`（中国法定节假日）每年按国务院安排刷新一次；周末自动判谷，不用管。
- 换模型来源时，先确认对应 provider 已在 DSH 里登录/配置好（尤其 `codex`）。
