# 避峰岗（dsh-peak-valley-router）

> 峰时站岗换班：谷时让 DeepSeek 干苦力，峰时换 ChatGPT Plus 顶班，你的 API 账单从此不再被高峰期收割。

DeepSeek Harness 的跨 provider 峰谷路由插件 + 公开 SKILL。详见 [SKILL.md](./SKILL.md)。

当前版本：**v0.12.0**（pre-1.0）。版本号唯一来源是 `package.json`；运行时可在设置页标题下方或 `debug.log` 的 `apply: vX.Y.Z, …` 行确认当前加载的是哪一版。变更记录与版本策略见 [CHANGELOG.md](./CHANGELOG.md)。

## 它做什么

- **设置页「避峰岗」**：配置有序策略。每条策略 = 触发条件（生效星期 + 峰时窗口）+ 主模型（谷时）+ 可选副模型（峰时）。另有**高级思考模型**，它是**另一根轴**：只在会话本身要求 `max` 思考时使用（`reasoningEffort === 'max'`），**不作为未命中策略时的兜底**。未命中任何策略的时刻（周末、假期）→ 用**第一个方案的主模型**。设置页顶部会写明「此刻生效：model@effort · 原因」，例如「无匹配方案（周末/假期），用首个方案的主力模型」，所以任何一次目标都能解释，不会像故障。
- **Provider / 模型一律下拉选择**：候选来自运行时**已注册的全部 provider**——API 与你装的订阅套餐并列（如 DeepSeek、ChatGPT Plus / Codex、Claude、Grok、Copilot、Antigravity），模型经该 provider 的 `listModels` 接口读取。避峰岗自身**不会**出现在候选里：它是 provider 之上的一层选择器逻辑，不是 provider。
- **左侧「启用避峰岗」开关**：默认关闭 = 纯透传，行为与未装插件一致。开启后由避峰岗决定实际调用的模型，**连会话里已经选过的模型也会被改写**（会话自带的模型选择器本身不改动，只做功能接管 + 尽力而为的置灰提示）。
- **每会话独立状态 + 会话列表小灯 + 全局解耦**：
  - **全局 = 总闸**：侧边栏底部那个开关，切换它会对所有「跟随中」的会话一次性生效（扫一遍）。
  - **局部可单独改**：composer 输入区左侧第一个按钮切换**当前会话**；一旦单独改过，该会话就**不再被全局切换带走**（两个方向都是）。
  - **显式的「全局解耦」开关**：composer 左侧第二个按钮。两个圆环相接＝跟随全局，分开＝已解耦；点一下在「解耦 / 接回」之间切换。它**只切换连接关系**，不改变此刻是否生效。右键第一个按钮也能恢复跟随（等价快捷方式）。
  - **会话列表小灯**：每行一个微微发蓝光的小灯，亮 = 该会话此刻生效；已解耦的会多一圈淡环。全局默认开着时每行都会亮（它们跟随默认），只有被单独关掉的会话不亮。
  - **全局侧可见**：侧边栏开关的提示里会显示「· N 个已解耦」。
  - **已知限制**：行首位置由宿主条件渲染，下列四种行**不渲染**该插槽，小灯在这些时刻不显示——归档（archived）、空白（blank）、**正在运行**（显示状态点）、**有未读标记**。依据：`.recon/workspace.client.js` 里 `!row.archived && !row.blank && (showStatus ? … : unread ? … : renderSlot("sidebar.session.row.leading", …))`。这是宿主行为，插件不去改它。
  - 另需注意：小灯反映的是**开关意图**，不是"此刻一定生效"。若策略目标不在 provider 目录里（模型下线/改名），路由会**静默回落到会话原模型**，只在 `debug.log` 留一行——此时小灯仍是亮的。
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
- `scripts/session-fuzz.mjs` — 随机化差分属性测试：200 次随机操作 × 12 个探针 id（含 `__proto__`、`constructor`、超长与 Unicode id），**期望值独立地从 `state.json` 重算**，用来抓跨会话串扰与身份透传违规（`npm run fuzz`，可传种子）
- `CHANGELOG.md` — 变更记录与版本策略
- `cordis.patch.yml` — 自激活 patch（bundle 安装用）
- `package.json` — 插件清单（含 `dsh.client` 声明）

## 开发

```bash
node src/build-client.mjs   # 重建 lib/client.js（改了 src/client 或 lib/text.js 后必跑）
npm run verify              # 五套检查（只读，不写任何产物）
npm run fuzz                # 只跑随机化差分属性测试（可传随机种子）
```

`npm run verify` 覆盖：文案 key 完整性/双语对称、client↔node RPC 契约、关键不变式
（`inject=['llm']`、`agent/request` 带 `prepend`、无 `registerAdapter`/`llm/stream` 残留、
未触碰会话模型选择器）、版本一致性（`package.json` ↔ `CHANGELOG.md` ↔ `README.md`/`SKILL.md`
的「当前版本」）、产物新鲜度（**构建到临时文件比对，不重写仓库里的产物**）、仓库顶层文件集合、
副模型形状往返、界面文案无硬编码中文、每会话状态语义、随机化差分属性测试。

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

## 已知限制

- **跨窗口/多进程不同步**：开关状态在插件加载时读一次，客户端也不轮询。同一台机器上开两个窗口，A 的改动要等 B 重新加载才可见；两个 DSH 进程共用同一个 `DSH_HOME` 时，各自持有自己的快照，后写的一方会覆盖**整张** `sessions` 表（写入是原子的，但没有合并语义）。单窗口单进程使用不受影响。
- **目标模型不在目录里时静默回落**：策略目标（主模型/副模型/高级思考模型）若不在该 provider 当前的模型目录中（下线、改名、订阅登出），路由会保留会话原模型，只在 `debug.log` 记一行。此时开关与小灯仍显示"开"——它们反映的是**开关意图**，不是"此刻一定生效"。
- **配额/限流不归避峰岗管**：它只决定"用哪个 provider/model"。若目标 provider 的账号池处于 429 冷却（如订阅套餐的 5 小时窗口用尽），请求会在 provider 层失败。避峰岗不会自动改道到别的模型——那会让"为什么换模型"变得不可预测；需要时请改配置或暂时关掉开关。
- **行首小灯的显示条件**：见上文「每会话独立状态」一节的四条隐藏条件（宿主行为）。
- **并发点击**：写盘期间开关按钮是禁用的，被丢弃的那次点击不会报错（没有队列）。
