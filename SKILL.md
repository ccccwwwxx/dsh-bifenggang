---
name: bifenggang
description: "避峰岗：谷时让 DeepSeek 扛大梁，峰时换 ChatGPT Plus 顶班。按峰谷时段自动切换模型，别让高峰期把你的 API 账单薅秃。"
---

# 避峰岗（Peak Avoidance Post）

> 当前版本 **v0.11.0**（pre-1.0）。版本号唯一来源是 `package.json`；运行时可在「设置 → 避峰岗」标题下方或 `debug.log` 的 `apply: vX.Y.Z, …` 行确认。变更记录与版本策略见 [CHANGELOG.md](./CHANGELOG.md)。

站岗的人都知道：该换班就换班，别死磕。DeepSeek 的 API 现在也是这个道理——峰时价格翻倍、谷时半价。避峰岗就是给你的模型调用排一张「换班表」：谷时让 DeepSeek 干苦力（便宜），峰时换 ChatGPT Plus 顶班（订阅费反正已经付了）。

## 换班表（峰谷规则）

DeepSeek 官方峰谷定价（2026-08-17 起）：

- **高峰时段**：北京时间周一至周五（不含中国法定节假日）`09:00–12:00`、`14:00–18:00`
- **空闲时段**：其余全部时间，含周末与法定节假日全天
- 闲时价格 = 峰时的 1/2

## 它能干什么

一个挂在 DeepSeek Harness（DSH）里的模型路由策略引擎，支持：

1. **多策略**：从你已经配置好的 API（DeepSeek、ChatGPT Plus/codex 等）里挑来源，给每条策略指定「API × 主模型名」。
2. **峰谷副模型**：主模型里可开启峰谷选项，峰时自动切到副模型。
3. **触发条件**：每条策略写一句文字描述（对应它的时间条件），按顺序首条命中生效。
4. **互斥策略**：所有策略都没命中时兜底；**设了策略就必须配互斥策略**，否则直接报错。
5. **GUI 配置**：设置页里直接增删改策略，不用手改 JSON。

默认换班表示例：

| 时段 | 用谁 | 说明 |
|---|---|---|
| 谷时（工作日夜间/周末/节假日） | `deepseek-official` / `deepseek-flash` | 便宜，半价 |
| 峰时（工作日 9–12 / 14–18） | `codex` / `gpt-5.6-luna` @ max | 订阅已付，不额外掏钱 |

## 安装与配置

插件本体是 `dsh-peak-valley-router`（本仓库的 `package.json` + `lib/`），可通过 DSH 插件管理装成 bundle，或直接 patch 层 `insert`。

配置结构（`cordis.patch.yml` 或设置页写入的 `policy.json`）：

```yaml
config:
  utcOffsetMinutes: 480          # 北京时间 UTC+8
  holidays: [[2026, 10, 1], ...] # 中国法定节假日，全年谷时
  strategies:                    # 按顺序首条命中生效
    - name: "避峰岗"
      description: "工作日白天避开 DeepSeek 高峰"
      weekdays: [1, 2, 3, 4, 5]
      primary:                   # 主模型（谷时）
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: high
      peak:                      # 峰谷选项
        enabled: true
        windows: [["09:00", "12:00"], ["14:00", "18:00"]]
        provider: codex          # 副模型（峰时）
        model: gpt-5.6-luna
        reasoningEffort: max
  exclusive:                     # 互斥策略（必填兜底）
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
```

路由规则：当前时刻命中某条策略 → 用它的主模型（峰时窗内用副模型）；全部未命中 → 用互斥策略。用户在会话里**显式选的模型永远优先**，不会被覆盖。

## 依赖注意

- 插件**零 DSH 包 import**：只用 `ctx` 服务 + `process.env.DSH_HOME` + Node 内置 `fs/path`，避免绝对路径加载时解析不到依赖。
- ChatGPT Plus 的 `codex` provider 由 `dsh-plugin-subscriptions`（OAuth 登录）提供，插件只按名引用、用 `ctx.llm.listProviders()` 动态列出给 GUI 选，不重复实现登录。

## 维护

- `holidays`（中国法定节假日）每年按国务院安排刷新一次；周末自动判谷，不用管。
- 换模型来源时，先确认对应 provider 已在 DSH 里登录/配置好（尤其 `codex`）。
