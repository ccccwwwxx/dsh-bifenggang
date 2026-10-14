# 避峰岗（dsh-peak-valley-router）

> 峰时站岗换班：谷时让 DeepSeek 干苦力，峰时换 ChatGPT Plus 顶班，你的 API 账单从此不再被高峰期收割。

DeepSeek Harness 的跨 provider 峰谷路由插件 + 公开 SKILL。详见 [SKILL.md](./SKILL.md)。

当前版本：**v0.9.0**（pre-1.0）。版本号唯一来源是 `package.json`；运行时可在设置页标题下方或 `debug.log` 的 `apply: vX.Y.Z, …` 行确认当前加载的是哪一版。变更记录与版本策略见 [CHANGELOG.md](./CHANGELOG.md)。

## 它做什么

- **设置页「避峰岗」**：配置有序策略。每条策略 = 触发条件（生效星期 + 峰时窗口）+ 主模型（谷时）+ 可选副模型（峰时）；另有「高级模型支援」作为升维兜底，承接所有未命中策略的时刻。
- **Provider / 模型一律下拉选择**：候选来自运行时**已注册的全部 provider**——API 与你装的订阅套餐并列（如 DeepSeek、ChatGPT Plus / Codex、Claude、Grok、Copilot、Antigravity），模型经该 provider 的 `listModels` 接口读取。避峰岗自身**不会**出现在候选里：它是 provider 之上的一层选择器逻辑，不是 provider。
- **左侧「启用避峰岗」开关**：默认关闭 = 纯透传，行为与未装插件一致。开启后由避峰岗决定实际调用的模型，**连会话里已经选过的模型也会被改写**（会话自带的模型选择器本身不改动，只做功能接管 + 尽力而为的置灰提示）。
- **每会话独立状态 + 会话列表小灯**：侧边栏底部的开关是**全局默认**；composer 输入区左侧的开关操作**当前会话**（右键清除覆盖、恢复跟随全局）。会话列表行首会出现一个**微微发蓝光的小灯**，标出哪些会话开着。没有单独设置的会话跟随全局默认——所以旧的行为习惯不变。
  - 已知限制：行首位置由宿主条件渲染，会话**正在运行（有状态点）或有未读标记**时宿主不渲染该位置，小灯在这些时刻不显示。
- **多端可用**：开关同时挂在左侧边栏底部与 composer 输入区左侧。窄屏（<1024px 侧边栏自动收起、Windows/macOS 收起态整列宽度为 0）时由 composer 入口兜底，两个入口共享同一份状态。

## 目录

- `SKILL.md` — 「避峰岗」技能说明
- `lib/index.js` — Node 端：策略引擎、`agentDefaultModel` 门控、`agent/request` 覆盖、RPC
- `lib/text.js` — **唯一维护文件**：默认定义（`DEFAULTS`）+ 中英文案（`zh`/`en`）
- `src/client/*.js` — 客户端源码（开关 / 选择器 / 策略编辑 / 设置页 / 入口）
- `lib/client.js` — **生成物**：由 `src/build-client.mjs` 拼接各 source 并注入 `lib/text.js` 文案，请勿手改
- `src/build-client.mjs` — 客户端构建脚本
- `scripts/verify.mjs` — 仓库自检（契约、不变式、版本一致性、产物新鲜度）
- `scripts/roundtrip.test.mjs` — 副模型往返回归（防止形状错配复发）
- `scripts/copy.test.mjs` — 界面文案单一来源与本地化映射检查
- `scripts/session-state.test.mjs` — 每会话状态语义（覆盖 / 跟随默认 / 清除 / 容量上限 / 会话 id 读取）
- `CHANGELOG.md` — 变更记录与版本策略
- `cordis.patch.yml` — 自激活 patch（bundle 安装用）
- `package.json` — 插件清单（含 `dsh.client` 声明）

## 开发

```bash
node src/build-client.mjs   # 重建 lib/client.js（改了 src/client 或 lib/text.js 后必跑）
npm run verify              # 三套检查：契约自检 + 副模型往返 + 文案/本地化
```

`npm run verify` 覆盖：文案 key 完整性/双语对称、client↔node RPC 契约、关键不变式
（`inject=['llm']`、`agent/request` 带 `prepend`、无 `registerAdapter`/`llm/stream` 残留、
未触碰会话模型选择器）、版本一致性（`package.json` ↔ `CHANGELOG.md`）、产物新鲜度、
副模型形状往返、界面文案无硬编码中文。

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

- `policy.json` — GUI 保存的策略
- `state.json` — 开关状态：`{ enabled, sessions }`。`enabled` 是**全局默认**，`sessions` 是**每会话覆盖**表（没有覆盖的会话跟随默认；上限 500 条，按最近写入淘汰）。旧文件（只有 `enabled`）行为完全不变。
- `debug.log` — 诊断日志（只在 apply / 目录读取失败 / 开关切换 / 每个新接管目标时各记一行）
