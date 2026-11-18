# 0.16 独立验证报告：新接缝、分类器校准、兼容回归

> 验证者：researcher（t10），不复用实现者自报结论；每一条都重新跑过。
> 证据口径：命令 + 退出码 + 日志行/文件字节；不能验证的写「无法验证」，不写成通过。
> 日期：2026-11-18。仓库版本仍为 `package.json` 0.15.0（0.16 的版本号/CHANGELOG 归 t11）。

---

## 0. 结论摘要

| 项 | 结论 | 关键证据 |
|---|---|---|
| 新接缝（真核 0.2.2-rc.1） | **通过** | `inbox: decision → inbox: select → pre-step match=true → request: observed deepseek-v4-pro`，无 `after step preparation fixed`（§B1） |
| 旧实现反向证伪 | **通过（红）** | `v0.15.0/lib/index.js` 同一环境必抛 `agent/request proposed … use agent.model.select()`（§B3） |
| 静态：`agent/request` 只读 | **通过** | 源码块无 provider/model/effort 赋值；动态返回与 `next()` 同一对象（§A） |
| probe 边界/纯度 | **通过** | 09:00 含、12:00 不含、23:30 不匹配；probe 前后 policy/state/debug.log 字节与 `get` 全同（§D） |
| v0.15 单策略差分 | **通过** | 6 个时刻（峰/边界/谷/周末/节假日）目标逐字段相等（§E1） |
| legacy 多策略 | **通过** | 2 条策略：不报错、只走第一条、`legacy-extra-strategies` 告警；1 条不告警（§E2） |
| 分类器校准（40+ 独立样例） | **修复前 FAIL / 修复后 PASS** | 修复前 accuracy 0.809、3 条 low→high；t13 修复后冻结集 0.872（反档 0）、留出集 0.912（反档 0），见 **§C2** |
| 状态 I/O / 坏文件 / 跨窗口 | **通过（含 1 条 t9 口径纠正）** | 每条消息 1 次原子写；reload 0 写；坏 JSON 字节不变但开关回到默认 OFF；20 轮并发不丢键；轮询 297ms（§F） |
| 测试/自检 | **通过** | `npm test` EXIT=0；`npm run verify` EXIT=0；`node scripts/verify.mjs` EXIT=0（§G） |

**放行建议（供 Lead/t11 决策）**：接缝与兼容面可以放行。分类器在 t13 修复后**两组复验门禁均 PASS**（§C2）；t10 提出的 D1/D2/D3 已在 t13 修复，仅留 D8（留出集相邻档退化 0.029，无反档）。是否默认开启仍由产品决定——默认关闭时该风险不影响 0.16.0 发布。

---

## 1. 环境与方法

- 桌面宿主：DSH desktop **0.14.0**，内置核心 `@deepseek-ai/dsh-agent / dsh-agent-loop / dsh-llm` 均为 **0.2.2-rc.1**（读自 `resources/app.asar/node_modules/@deepseek-ai/*/package.json`）。
- 真核通道：`@deepseek-ai/dsh@0.2.2-rc.1` headless + 隔离 `DSH_HOME`（`%LOCALAPPDATA%\dsh-t10-*`）+ `--patch` 挂 `lib/index.js`；Node 用 Harness 自带 v24.21.0（详见 `docs/HEADLESS_VERIFY.md`）。
- 无真实 DeepSeek key（本机没有）：回合用 `DEEPSEEK_API_KEY=sk-t10-invalid`，因此**所有回合都以 `AUTH` EXIT=1 结束**。这不影响接缝验证（decision/select/pre-step/request 都在 provider 鉴权之前完成），但**无法验证「带真 key 的完整回合 EXIT=0」**。
- 冷目录陷阱：必须在日志出现 `model catalog refreshed (adapters-updated): N ok` 之后再投递消息（用一个延迟写 stdin 的进程包装），否则会看到 `unverified kind=catalog-cold` 并误判「不路由」。

---

## A. 静态：`agent/request` 不得改写选择（任务 1）

- 源码：`lib/index.js:1184-1197`，注释与实现都是「OBSERVATION ONLY」，`return config`（下游对象原样返回）。
- 独立检查脚本 `scripts/t10-seam-checks.mjs`：
  - 截取 `ctx.on('agent/request'…` 到监听器结束的源码块，断言块内不存在 `provider/model/reasoningEffort` 的赋值（正则含 `!=` 排除）；
  - 动态调用监听器，`next()` 返回带 `maxTokens/nested/extraFlag` 的对象，断言返回值**就是同一个对象**（`===`）且 `deepEqual`。
- 结果：`ok static…`、`ok dynamic…`，12/12→14/14 通过，`EXIT=0`。

---

## B. 真核证伪（任务 2/3/4）

### B1. H1：目标 ≠ 会话已选模型（enabled=true）

隔离 home：policy v2 `low.valley = deepseek-official/deepseek-v4-pro`（**不写显式 reasoningEffort**，否则首回合会命中 `effort-cold`，见 §H D7），session 默认 `deepseek-flash`，消息 `npm run verify`。

`debug.log`（2026-11-18T15:53:32Z）：
```
inbox: decision … tier=low score=- target=deepseek-official/deepseek-v4-pro axis=tier tierReason=tier-disabled costReason=peak-disabled
inbox: select -> deepseek-official/deepseek-v4-pro (… was deepseek-official/deepseek-flash)
pre-step: … modelSelection=deepseek-official/deepseek-v4-pro expected=deepseek-official/deepseek-v4-pro match=true
request: observed … config=deepseek-official/deepseek-v4-pro
```
- 退出码 1 来自 `dsh: AUTH: Authentication Fails …`（假 key），**不是**接缝失败。
- stderr/debug.log 全文无 `after step preparation fixed`。
- 结论：新接缝在真核上**确实生效**。

### B2. H2：tierRouting 开启后的高档次路径

policy `tierRouting.enabled=true`，`high.valley=deepseek-v4-pro`，消息 `为什么这个方案要这样设计，考虑过哪些取舍？`：
```
inbox: decision … tier=high score=0 target=deepseek-official/deepseek-v4-pro axis=tier tierReason=tier-high costReason=cost-off
inbox: select -> deepseek-official/deepseek-v4-pro (… was deepseek-official/deepseek-flash)
pre-step: … modelSelection=deepseek-official/deepseek-v4-pro expected=… match=true
request: observed … config=deepseek-official/deepseek-v4-pro
```
分层器、档位目标、select、生效四段在同一条真核链路上闭合。

顺带验证了「高档目标不在目录」的分支：把 `high.valley` 设为目录里不存在的 `deepseek-chat` 时，日志是
`warning: model … -> falling back to low.valley deepseek-official/deepseek-flash` + `inbox: no-op-same`，**不抛错、不阻塞**（fail-open）。

### B3. H3：开关关闭对照

`state.json {"enabled":false}`，其余不变：日志只有 `pre-step … modelSelection=deepseek-official/deepseek-flash` 与 `request: observed … deepseek-flash`，**无 `inbox: decision/select`**。纯透传成立。

### B4. 反向证伪：v0.15.0 在同一环境真炸

- `git archive v0.15.0` 解到 `%TEMP%\pv-v015`，patch 指向 `pv-v015/lib/index.js`，隔离 home 用 v1 policy（primary=`deepseek-v4-pro`@low）。
- 同一包装脚本、同样等目录预热：
```
agent/request: overriding -> deepseek-official/deepseek-v4-pro@low (… model was deepseek-official/deepseek-flash)
dsh: UNKNOWN: agent "…": agent/request proposed "deepseek-official/deepseek-v4-pro" after step preparation fixed
     "deepseek-official/deepseek-flash"; use agent.model.select() before step preparation
```
- 结论：**没有这条红，新接缝就无法证明自己修好了**。这条红已拿到。

### B5. 复核 app.asar 里的硬校验仍在

`resources/app.asar/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（66,629 字节，version 0.2.2-rc.1），`prepareRequest()` 内：
```js
if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model)
  throw new Error(`… after step preparation fixed "…"; use agent.model.select() before step preparation`)
if (proposedConfig.reasoningEffort !== selection.reasoningEffort) throw new Error(…)
```
（标记 `after step preparation fixed` 位于该文件 offset 35665。）

---

## C. 分类器防过拟合（任务 5）——**门禁 FAIL**

样例：`scripts/t10-calibration.mjs`，**47 条**，验证者自写，不抄 `classifier.test.mjs` / 设计 §4.6；覆盖抽象原理、多子问题、中英混写、极短命令、代码块/路径/报错执行、追问、图片审计、长日志、英文。标签口径：high=只要判断/设计；mid=带具体锚点的评审或单文件改动；low=纯执行（跑/装/只跑不改）。

混淆矩阵（行=期望，列=实际）：

| expected\actual | high | mid | low |
|---|---|---|---|
| high (20) | **19** | 1 | 0 |
| mid (17) | 2 | **12** | 3 |
| low (10) | **3** | 0 | 7 |

- 逐档召回：**high 0.950 / mid 0.706 / low 0.700**（mid/low 刚过 0.7）。
- 总体 accuracy **0.809（38/47）**。
- **反档（硬门禁）**：3 条 `low → high`，门禁判 **FAIL**。

反档明细（均为「便宜的执行请求被判成抽象 → 送高档模型」，成本反向）：

| 样例 | 判定 | 实际得分/特征 | 根因 |
|---|---|---|---|
| `跑一遍全部测试然后把结果贴出来` | low → **high** | 0.075，仅 `verb` | `COMMAND_PATTERN` 只认 `跑一下/跑下/跑个/跑测试`，不认「跑一遍」；无 command 特征就没有 `short-command` 桥 |
| `安装 eslint 并生成默认配置` | low → **high** | 0.075，仅 `verb`（无对象减半） | 中文「安装」只命中 `VERB_PATTERN` 的「装」，没有 command 锚点 |
| `Run the full test suite and summarize which suites are red.` | low → **high** | 0.13，`command,verb,abstract` | `summarize` 的 −0.20 抵消了 command+verb；`short-command` 又因有负特征被跳过（这条标签偏严，可视为 mid，但仍是「执行被抬高」方向） |

相邻错分（非硬门禁，但说明精度）：
- `把 config-v2.test.mjs 里第三个用例改成…`、`删掉 scripts/roundtrip.test.mjs` → **mid→low 0.88**：文件名里的 `test` 命中了 `COMMAND_PATTERN` 的 `\btests?\b`，再叠加 `short-command +0.37`。
- `TypeError … at run (lib/index.js:44:12) 为什么…` → **high→mid 0.43**：栈帧里的函数名 `run` 命中 `COMMAND_PATTERN` 的 `\brun\b`（把「为什么」问题抬成中档）。
- `重构 lib/state.js 的写入顺序…` → **mid→high 0.18**：`VERB_PATTERN` 没有「重构」，只剩 path。
- `把 README…补一段说明，解释…` → **mid→high 0**：`README` 无扩展名不算 path，「解释」−0.20。

**船长特别关心的 `short-command +0.37`**：对「短但抽象」没有误伤——
`为什么不生效？` → `tier=high score=0 reasons=abstract,short`。
它真正的风险是**放大 D2**：当 `test/run` 出现在文件名/标识符里时，command 特征被误触发，`short-command` 再把本应 mid 的 scoped edit 推到 low（0.88）。

**结论**：不回头改权重（按任务要求）。样例集与矩阵已留在 `scripts/t10-calibration.mjs`，可直接复跑：
```
node scripts/t10-calibration.mjs   # EXIT=1（门禁 FAIL），输出矩阵
```
修法建议（交 Lead，不是本任务改）：D1 扩展中文命令识别（跑一遍/运行/安装/执行）；D2 让 `COMMAND_PATTERN` 只在行首/命令位匹配，或先剔除文件名/标识符再匹配；D3 补「重构/补」等动词。**不要用调阈值的方式掩盖 D1**——阈值下降会让更多抽象请求掉到 low。

---

## C2. 修复后复验（t15，2026-11-19）

> t13 修复分类器后的独立复验。**冻结集与留出集都先核 sha256 再跑**，标签一律用 t14 冻结时的值，未因结果重标。

### C2.1 输入完整性（先核哈希，防偷改）

| 集合 | 路径 | 期望 sha256（t14） | 实测 |
|---|---|---|---|
| 冻结集（47 条，入库） | `scripts/fixtures/calibration-set-v1.json` | `0e1664db…5a5845` | **一致**（10678 bytes） |
| 留出集（34 条，封存在仓库外） | `%TEMP%\t14-holdout-v1.json` | `87329280…90d7b15` | **一致**（5256 bytes） |

`lib/classifier.js` 由 11064 bytes（t10/t14 版本）变为 **19663 bytes**（mtime 2026-11-19 00:07）；验证者未修改该文件。

### C2.2 双跑结果

**冻结集（47，标签=t10 冻结值）**

| expected\actual | high | mid | low |
|---|---|---|---|
| high (20) | **18** | 2 | 0 |
| mid (17) | 0 | **14** | 3 |
| low (10) | 0 | 1 | **9** |

- 召回：**high 0.900 / mid 0.824 / low 0.900**（门槛 0.7）
- accuracy **0.872（41/47）**；**反档 0**
- 相邻错分：v1-03 high→mid 0.37（target,verb,abstract）、v1-15 high→mid 0.52（code,verb）、v1-22 mid→low 0.73（command,verb,sequence,short-command）、v1-25 mid→low 0.60（path,symbol,verb）、v1-35 mid→low 0.60（path,symbol,verb）、v1-44 low→mid 0.48（path,verb）。

**留出集（34，同一封存文件）**

| expected\actual | high | mid | low |
|---|---|---|---|
| high (14) | **13** | 1 | 0 |
| mid (8) | 0 | **7** | 1 |
| low (12) | 0 | 1 | **11** |

- 召回：**high 0.929 / mid 0.875 / low 0.917**
- accuracy **0.912（31/34）**；**反档 0**
- 相邻错分：h-03 low→mid 0.50（command,verb）、h-24 high→mid 0.37（target,verb,abstract）、h-33 mid→low 0.60（target,verb,short-command）。

### C2.3 与 t14 修复前基线逐项对比

| 指标 | 冻结集 基线 → 修复后 | 留出集 基线 → 修复后 |
|---|---|---|
| accuracy | 0.809 → **0.872**（+0.063） | 0.941 → **0.912**（−0.029） |
| high 召回 | 0.950 → **0.900**（−0.050） | 1.000 → **0.929**（−0.071） |
| mid 召回 | 0.706 → **0.824**（+0.118） | 0.750 → **0.875**（+0.125） |
| low 召回 | 0.700 → **0.900**（+0.200） | 1.000 → **0.917**（−0.083） |
| 反档数 | **3 → 0** | 0 → **0** |

- 冻结集：三条 `low→high`（v1-42/43/46）全部消除，mid/low 召回显著上升；这是修复目标。
- 留出集：**门禁仍过（召回均 ≥0.7、反档 0），但 accuracy 较基线退化 0.029（32→31）**。按 Lead 口径，退化单独记录、不作为门禁通过的理由：
  - **h-03**「执行 git diff --stat 看一下改了哪些文件」：命令（0.20）+ verb（0.30）= 0.50 → mid。根因是「改了哪些文件」里的**「改」命中 EDIT_VERB_CN**，`short-command` 因 `editVerb` 被抑制。属相邻档（low→mid），可接受但确实是退化。
  - **h-24**「对比『关成本决策』和『删掉峰时配置』两种做法」：target 0.15 + 操作动词 0.30 + abstract −0.08 = 0.37 → mid。D1「执行锚点压过抽象词」的副作用；相邻档（high→mid）。
  - **h-33**「把 tmp.log 删掉」：target（`log`）+ verb + short-command = 0.60 → low（基线是 mid→high 0.075）。仍是 mid 档误判，只是方向从 high 变 low；`.log` 不在 `PATH_PATTERN` 扩展名表里。
  - 正向变化：基线中 **h-04（probe.test.mjs 编辑）mid→low 0.88 已修正**（D2 的 command 位置判定生效）。
- 结论：**留出集没有因「为过冻结集而把执行类压过头」出现反档**；退化集中在相邻档，且 mid/high 侧各有 1 条新错分，建议持续观察（D8）。

### C2.4 门禁结论

**PASS（两组均满足）**：每档召回 ≥0.7 且反档 = 0。

- 冻结集：0.900 / 0.824 / 0.900，反档 0；
- 留出集：0.929 / 0.875 / 0.917，反档 0；
- 未放宽任何门槛。

### C2.5 争议标签（Lead 已裁决，不改）

- `v1-46`「Run the full test suite and summarize…」标 **low**：保留。执行意图明确，summarize 是执行后处理；本轮已判对（low）。
- `v1-22`「运行 pnpm test 并报告结果」标 **mid**：保留原标签（尽管 Lead 倾向 low），理由是**看过结果后重标即数据泄露**。本轮仍为 mid→low（0.73），属相邻档歧义，**不影响反档门禁**；按 Lead 口径在矩阵旁注明：`v1-22` 是已知相邻档歧义样本，保留原标签、未因结果重标。

### C2.6 §4.6 十条既有反例回归

- `node scripts/classifier.test.mjs` **EXIT=0**：`#1`（长文+总结）、`#2`（报错日志+为什么）、`#3`（极短命令）、`#4`（重构整个项目 safety→high）、`#6`（中英混写）、`#7`（引用代码解释）、`#8`（纯图片/空文本）、`#9`（同批两消息一个分数）、`#10`（内部抛错回退 low）全部 `ok`。
- `#5`（同 turn 第 3 步不重分级）在接缝层：`node scripts/tier-routing.test.mjs` **EXIT=0**，`ok a steer inside the same turn never re-tiers or downgrades`。
- 结论：§4.6 十条**全部仍绿**（其中 #5 由 tier-routing 覆盖，不在 classifier.test 内）。

### C2.7 字符串特判扫描

脚本：`%TEMP%\t15-specialcase-scan.mjs`（去掉注释后只扫代码；同时扫两套样例）：

- 整句泄漏：**0 条代码级**；唯一命中 `git status` 出现在**注释**（`lib/classifier.js:52` 的说明性例子），不是逻辑。
- 特征 n-gram 泄漏（≥12 汉字 / ≥5 ASCII token）：**0**。
- 代码中含空格/句读的多词中文字面量：**0**（t13 引用的示例 `"执行 pnpm verify"`、`"运行 npm run build"`、`"npm 的 check 脚本"`、`"改 lib/index.js 第 120 行"`、`"把 build 脚本补一下"` 全部在注释行 189-191/314/345，不是运行时字面量）。
- 留出集专属词扫描：`429 / calibration / HEADLESS / probe.test / deepEqual / 春节 / 自适应 / 目录冷 / 第一条消息 / 峰时窗口 / tmp.log / nginx / redis` 在 `lib/classifier.js` 中**均无命中**。
- 结论：**未发现针对具体句子/词语的字符串特判**；新增 `target` / `sequence` 是通用语法特征（动词+对象名词、多步序列）。

### C2.8 命令与退出码（t15）

| 命令 | 退出码 | 结果 |
|---|---|---|
| node 核 sha256（fixture + holdout） | 0 | 两个哈希与 t14 一致 |
| `node %TEMP%\t14-eval.mjs post-fix <fixture> <holdout>` | 0 | 两组矩阵/召回/反档见 C2.2 |
| `node %TEMP%\t15-specialcase-scan.mjs` | 0 | 特判 0；summary `whole=0 ngram=0 suspiciousLiterals=0` |
| `node scripts/classifier.test.mjs` | 0 | §4.6 #1-4,#6-10 绿；t13 自集矩阵 1.000 |
| `node scripts/tier-routing.test.mjs` | 0 | §4.6 #5 同 turn 不重分级绿 |
| `npm test` | 0 | 全 suite 绿（含 fuzz） |
| `node scripts/verify.mjs` | 0 | 文案/契约/产物新鲜/版本/宿主兼容全绿 |

### C2.9 结论与遗留

- **门禁 PASS（两组）**：反档为 0，召回均 ≥0.7；修复方向正确，D1/D2/D3 的主要症状（v1-42/43/46 的 low→high）已消除。
- **D8（信息，非门禁）**：留出集较基线退化 0.029（h-03、h-24 为相邻档新错分，h-33 错向改变）；未出现反档，但建议 Lead 决定是否在 0.16.0 后继续校准（尤其「过去式动词（改了）触发 editVerb 抑制 short-command」与「抽象对比句里出现操作动词」两类）。
- 冻结集/留出集哈希未变；`lib/classifier.js` 未被验证者改动；留出集仍在仓库外封存，未给实现者看。

---

## D. probe 边界与纯度（任务 6）

`scripts/t10-seam-checks.mjs`（14/14，EXIT=0）：

- **09:00 含**：`at=2026-11-18T09:00:00+08:00`（周三）→ `reason=peak`、target=`deepseek-v4-pro`；
- 11:59 含；**12:00 不含**（`target=deepseek-flash`，`reason≠peak`）；
- **23:30 不匹配** 09:00–12:00 窗口（无跨午夜渗透）；
- 同一钟点、非配置星期（周日）→ valley；
- 强制 `tier=high` 在 `tierRouting=false` 时仍给出完整试算（试算可用）；
- **纯度**：`policy.json`/`state.json`/`debug.log` 前后**字节完全相同**，`get` 的 JSON 前后相同；
- 非法 `at` / 非法 `tier` → `{ok:false,error:{code:'bad-request'}}`；
- 候选 `config` 生效但不落盘。

---

## E. 兼容与回归（任务 7/8/9/10）

### E1. v0.15 单策略多时刻差分

`scripts/t10-v015-diff.mjs`：同一 v1 policy（peak 09:00–12:00、primary flash@low、peak codex/gpt-5.6-luna@high、节假日 2026-10-01）分别喂 v0.15.0 引擎与 v0.16 引擎，6 个时刻全部逐字段相等：

```
Wed 09:30 peak        v0.15=codex/gpt-5.6-luna@high  v0.16=同
Wed 11:59 peak edge   同
Wed 12:00 valley edge deepseek-flash@low            同
Wed 13:30 valley      同
Sat 10:00 weekend     同
Thu 10:00 holiday     同
EXIT=0
```

### E2. legacy 多策略（真核）

- 2 条策略的 v1 policy（s1 flash、s2 v4-pro）：`policy: read v1 (in-memory v2)` → `warning: legacy-extra-strategies reason=legacy-v1-migration`；回合只走 s1（`target=deepseek-flash@low`），**无报错**（EXIT=1 仍是假 key 的 AUTH）。
- 1 条策略：`legacy-extra-strategies` 出现次数 **0**。

### E3. 行为面（实现者测试 + 代码复核）

以下用实现者测试重跑并复核代码（**属于测试证据，不是独立复现**）：
- `node scripts/tier-routing.test.mjs` EXIT=0（含「同 turn steer 不降档」「max 轴失败不回退 low」「tierRouting=false 恒 low」）；
- `node scripts/cost-routing.test.mjs` EXIT=0（含 `costRouting=false` 仍 valley、默认不切峰）；
- `node scripts/migrate-v1.test.mjs` EXIT=0（v1→v2、peak 扁平往返）；
- `node scripts/catalog-warning.test.mjs` EXIT=0（告警 raised/cleared、legacy 生命周期、限流）。

独立补充：`probe` 的 `costRouting=false/true` 对照（§D 最后两项）直接证明「关成本决策仍谷时、开则峰时」。

### E4. 状态 v1→v2 / 双写 / 告警恢复

- v1 `{"enabled":true,"sessions":{}}` 启动后被读成 v2（`schemaVersion/revision/updatedAt` 写入，见 §F），路由正常。
- 双写不丢键、开关+会话互不覆盖、1s 轮询收敛：§F。
- 告警「出现→恢复→消失」：实现者 `catalog-warning.test.mjs` 覆盖；独立只验证了「出现 + 回退 low」（§B2），**恢复段未独立复现**（见 §H）。

### E5. host-compat

`node scripts/host-compat.test.mjs` EXIT=0：
- 声明范围点名 `0.2.2-rc.1` 并接受它；
- 拒 `0.2.3-rc.1` / `0.3.0-rc.1` / `1.0.0`；
- 反控（control）能红：`^0.2.1-rc.2` 拒绝 `0.2.2-rc.1`、旧范围会拒绝真核。

---

## F. 状态 I/O、坏文件、跨窗口（船长补充 1/2/3）

### F1. 「一次纯路由读取写了几次 state.json」（补充 1）

独立脚本 `scripts/t10-state-io.mjs`（fake agent：idle 下 followup，3 条消息 `npm run verify`）：

```
after message 1: revision=1 applied=1 restore=1
after message 2: revision=2 applied=1 restore=1
after message 3: revision=3 applied=1 restore=1
observed atomic writes: 3
fields changed: schemaVersion, revision, updatedAt, enabledUpdatedAt, sessionsUpdatedAt,
                tombstones, applied, appliedUpdatedAt, restore, restoreUpdatedAt,
                restorePending, restorePendingUpdatedAt
reload alone changed state.json: false
size: 30 -> 609 bytes
```
- **每条消息（每个 turn）恰好 1 次原子写**；第 2/3 条是 `no-op-same` 也照样写（因为 applied/restore 元数据要落盘）。
- **纯 reload 不写**（`reload alone changed: false`）——所以 §F3 的 drain 不是在掩盖读路径写。
- ⚠ 这是 0.16 新增 I/O 行为，建议进 CHANGELOG 已知边界：**每条被路由的消息一次 state.json 原子写**（含 no-op 目标），高频会话下写放大与旧版不同。

### F2. fuzz 的 30ms drain：等价性证明（补充 1）

同 seed 对比（`session-fuzz.mjs` 的 persistence 段）：

| 变体 | seed 20261014 | seed 1 | seed 42 | seed 7 |
|---|---|---|---|---|
| 原版（drain 30ms） | EXIT=0 | EXIT=0 | EXIT=0 | EXIT=0 |
| **去掉 drain** | EXIT=1 | EXIT=1 | EXIT=1 | EXIT=1 |
| drain 0ms | EXIT=0 | — | — | — |
| drain 5ms | EXIT=0 | — | — | — |

去掉 drain 时的失败固定为 `FAIL state.json changed across a reload`——原因是**上一条操作排队中的写**落在 `before` 与 `after` 之间，不是 reload 本身写盘（F1 已直接证明 reload 0 写）。drain 0ms 即通过，说明只需让微任务落地；30ms 只是余量。**判据本意未变，drain 不是遮羞布。**

### F3. 坏 state.json（补充 2）

构造 43 字节截断文件 `{"enabled":true,"sessions":{"sess-bad":true`，真核启动：

```
state: read failed, keeping defaults: Expected ',' or '}' after property value in JSON at position 43
apply: v0.15.0, enabled=false, ...
```
- 启动后文件**字节完全不变**（AFTER_BYTES=43，内容逐字节相同）——「绝不清空」成立。
- 插件正常加载、无崩溃；**但开关回到默认 `enabled=false`，该回合不路由**（只有 pre-step/request 观察行）。
- **口径纠正**：t9 报告里「坏 JSON 原样保留、且路由仍能工作（fail-safe）」前半句真，后半句不准确。实际是 **fail-closed on the switch**（安全但非「照常路由」）。如果产品语义要求「坏文件时仍按默认开启路由」，需要另做（不建议：坏文件本身不可信）。无数据丢失，不阻塞发布；但请不要在 CHANGELOG 里写「坏文件仍可路由」。

### F4. 跨窗口收敛（补充 3）

`scripts/t10-cross-window.mjs`（两个独立 store 实例 = 两个进程的等价物）：

- 20 轮并发 `setEnabled` + `setSessionEnabled(x)` + `setSessionEnabled(y)`：**x/y 均不丢**，revision 单调（≥60），文件始终是合法 v2；
- 「A 改开关、B 同时改会话 z」：`enabled=false` 与 `z=true` **同时存活**（原丢数据 bug 的本体）；
- 1s 轮询（`watchStateFiles`）：B 实例在 **297–379ms** 内看到 A 的写（< 1.5s 门槛）。
- 客户端 3s 轮询：**静态核对** `src/client/40-settings.js:769` `setInterval(…, 3000)`、`visibilitychange` 暂停/恢复、`focus` 立即拉、脏草稿不静默采纳、`configRevision` 去重。**未做 GUI 双窗口端到端**（见 §H）。

---

## G. 命令与退出码（任务 11）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `npm test` | **0** | 16 个 suite 全绿（含 4 个 t10 无关的实现套件） |
| `npm run verify` | **0** | verify.mjs + 全部 suite + fuzz |
| `node scripts/verify.mjs` | **0** | 文案/契约/产物新鲜/版本一致/顶层文件集/宿主兼容 全绿；`版本: v0.15.0`、`CHANGELOG 最新条目与 package.json 一致 (0.15.0)` |
| `node scripts/host-compat.test.mjs` | **0** | 0.2.2-rc.1 接受 + 邻线拒绝 + 反控 |
| `node scripts/t10-seam-checks.mjs` | **0** | 14/14 |
| `node scripts/t10-cross-window.mjs` | **0** | 4/4 |
| `node scripts/t10-state-io.mjs` | **0** | 1 写/消息；reload 0 写 |
| `node scripts/t10-v015-diff.mjs` | **0** | 6/6 时刻相等 |
| `node scripts/t10-calibration.mjs` | **1** | 门禁 FAIL（预期内，如实报） |

真核 headless 回合均为 `EXIT=1`（假 key AUTH），接缝四段日志齐全；**没有一次真 key 的成功回合**。

---

## H. 发现与交回（不改实现者文件）

> 状态更新（t15）：下表 D1/D2/D3/D4 已在 t13 修复并由 §C2 复验（两组门禁 PASS）。保留原始描述作为修复前证据；当前唯一未闭环项是 **D8（留出集相邻档退化）**，见 §C2.3/§C2.9。

| ID | 严重度 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| **D1** | **高（成本反向）** | 中文执行请求「跑一遍全部测试」「安装 eslint」被判 **high**（score 0.075），会被送去最贵的档 | §C 反档表 | 扩展 `COMMAND_PATTERN`（跑一遍/运行/执行/安装）或加中文祈使特征；**不要**降阈值 |
| **D2** | 中（精度） | `test`/`run` 出现在**文件名/标识符**里就触发 command，叠加 `short-command` 把 scoped edit 推到 low（0.88）；栈帧 `at run(...)` 把「为什么」抬到 mid（0.43） | §C 相邻错分 | command 只在命令位匹配，或先剔除路径/标识符再匹配 |
| **D3** | 中（召回） | `重构`/`补` 不在 `VERB_PATTERN`；`README` 无扩展名不算 path → 两个 scoped edit 落到 high | §C | 补动词/phrase；mid 召回 0.706 只是刚过线 |
| **D4** | 低（信息） | `short-command +0.37` 本身没误伤「短抽象」（`为什么不生效？`→high），但会放大 D2 | §C 末尾 | 与 D2 一起修；修 D2 后重跑本样例集 |
| **D5** | 低（信息/CHANGELOG） | 0.16 新增「每条被路由消息一次 state.json 原子写」（含 no-op），609B/3 条；旧版无此写放大 | §F1 | 写入 CHANGELOG 已知边界；高频会话可考虑只对变化字段写 |
| **D6** | 低（口径） | 坏 state.json 时文件不丢，但开关回默认 OFF、**不路由**；t9「路由仍能工作」表述过强 | §F3 | 修报告口径，不必改代码 |
| **D7** | 低（首回合） | 目标带显式 `reasoningEffort` 时，适配器晚注册导致首回合 `effort-cold`→`unverified`→不 select（flaky first message）。真核日志已见（legacy 用例） | §B1/§E2 | 已 fail-open+可见告警，可接受；若要首回合必中，可在 adapters-updated 后清 effort 缓存失败项（当前 5 分钟 TTL 可能让冷失败滞留） |

> 以上 D1–D3 属实现者/Lead 的修复范围；t10 只补测试与报告（`scripts/t10-*.mjs` 为验证脚本，可保留或由 t11 决定是否提交）。

---

## I. 无法验证（不要当成通过）

1. **真 key 的完整成功回合（EXIT=0）**：本机没有 DeepSeek key；只能验证到 provider 鉴权前。接缝正确性已由四段日志 + 反向证伪覆盖，但「真实 assistant 输出」未验。
2. **GUI 双窗口 3 秒内看到对方改动**：无 GUI 运行环境；已验证 store 级 297–379ms 收敛 + 客户端 3s 轮询代码（静态）。真窗口验收需 t11 在桌面端做。
3. **告警自动恢复的独立复现**：只跑了实现者 `catalog-warning.test.mjs`（EXIT=0），独立只验到「触发 + 回退 low」。
4. **max 轴在真核上的行为**：只有单元测试（`tier-routing.test.mjs`）与代码复核，未在 headless 构造 `reasoningEffort=max` 的会话。
5. **0.2.0-rc.2 / 0.2.1-rc.2 宿主回归**：本轮只在 0.2.2-rc.1 真核跑；旧线仅由 host-compat 的区间断言覆盖，没有旧核启动。

---

## J. 复跑清单

```powershell
cd C:\Users\29805\Documents\deepseek-harness\default-workspace\dsh-bifenggang
npm test                                  # EXIT=0
npm run verify                            # EXIT=0
node scripts/t10-calibration.mjs          # EXIT=1（分类器门禁 FAIL，见 §C）
node scripts/t10-seam-checks.mjs          # EXIT=0
node scripts/t10-cross-window.mjs         # EXIT=0
node scripts/t10-state-io.mjs             # EXIT=0
node scripts/t10-v015-diff.mjs            # 需 %TEMP%\pv-v015；EXIT=0
```

真核复跑：见 `docs/HEADLESS_VERIFY.md` §3–§5；本报告用的包装脚本会延迟写 stdin 直到 `model catalog refreshed (adapters-updated): N ok`（`%TEMP%\t10-run-headless.ps1`），隔离 home 为 `%LOCALAPPDATA%\dsh-t10-{home,v015,bad,legacy,legacy1,tier}`。桌面端 `harness\plugins` 未被本通道写入。
