# 路由调研：可复用清单（智能程度路由 / 成本决策路由）

> 目的：给施工用的「可复用清单」，不是综述。每条都回答四件事：
> **来源链接 / 核心逻辑 / 能不能在本插件（零依赖 Node、只在 `ctx` 服务面工作）复刻 / 采用还是不采用、为什么**。
>
> 读者：0.16.0 的实现者与验收者。范围：只覆盖路由决策与配额信号；不覆盖 GUI 视觉。
>
> 调研时间：2026-11-18。凡标「**未核实**」的，都是没拿到一手源码/文档、只拿到二手描述的结论，施工前不要把它当契约。

---

## 0. 先决结论：本机宿主接缝已经变了（影响所有方案）

这一条不属于任何一篇论文，但它决定后面所有「能不能做」。

本机桌面端是 **DSH desktop 0.14.0**，内置核心包 `@deepseek-ai/dsh-agent` / `dsh-agent-loop` / `dsh-llm` 均为 **0.2.2-rc.1**（读自 `resources/app.asar/node_modules/@deepseek-ai/*/package.json`），不是本仓库 README 里核过的 `0.2.0-rc.2` / `0.2.1-rc.2`。

- `agent/request` 仍在，但**已弃用**。`dsh-agent/README.zh.md` 原文：「`agent/request` 已弃用，仅为现有监听器保留。不要添加新监听器。提供方、模型和可选的显式推理强度在步骤准备时固定；监听器必须保留三者，包括未指定强度的状态。」
- 更硬的是代码里的校验（`dsh-agent-loop/lib/index.js`，`prepareRequest()`）：若监听器返回的 `provider` / `model` / `reasoningEffort` 与步骤准备时固定的 `selection` 不同，**直接 throw**：
  `agent "…": agent/request proposed "x/y" after step preparation fixed "a/b"; use agent.model.select() before step preparation`
- 替代 API 是 `agent.model.select({ provider, model, reasoningEffort? })`：**从下一个尚未开始准备的步骤生效**；`agent.model.current()` 只读；每次选择会记 `model/selection` 事件（**持久**，见 0.1 B）。
- **`agent/pre-step` 不是可以改本步模型的挂点。** `dsh-agent-loop/lib/index.js` 的 `preStep()` 里，`const selection = this.model.current()` 发生在 dispatch `agent/pre-step` **之前**；之后 `step()` 用 `decision.selection`（就是这份 selection）调 `prepareRequest`。pre-step 里改模型只可能影响**下一个** step。pre-step 只能用来「观察/记录」。

**对本插件的直接影响**

1. 现在 `lib/index.js:699-746` 的 `agent/request` 处理器会改写 `provider/model/reasoningEffort`。在本机桌面上这不是「不生效」，而是**该步直接抛错**（避峰岗开启且目标与会话原模型不同时，回合失败）。0.15.0 的「装到桌面端验收」必须先处理这一点，否则验收必然撞墙。
2. 0.16.0 的「智能程度路由」「成本决策路由」都必须改成「**在步骤准备之前**调 `agent.model.select()`」，而不是在请求时改模型；正确挂点是**消息进入 inbox 时**（`agent/inbox/inserted`），详见 0.1。
3. 复杂度分类可用的第一手输入：`agent/inbox/inserted` 的 `message`（本步新消息）与 `agent/pre-step` 的 `messages`/`turn`/`step`/`modelSelection`（用于观察与记录）；工具集不在 pre-step payload 里（`preStep` 内部才 `tools.resolve`），需要另取或不用。
4. 时序不再是「待测风险」：`inbox/inserted` 在 `wakeDriver()` 之前同步发射（0.1 A），因此对**空闲** agent 的 followup、对**运行中** agent 的 steer，`select()` 都落在该步准备之前。仍需实测的是「多消息/多插件插入时的去抖与归属过滤」。

> 施工建议：保留 `agent/request` 监听器但**只读不改**（或直接删掉改写），并加回归测试断言「返回的 config 与入参逐字段相同」。这样旧宿主（0.2.0/0.2.1）与新宿主都能安全加载，路由只走 `agent.model.select()`。

### 0.1 三条施工事实（本轮补测）

#### A. `agent/inbox/inserted` 的发射时机与载荷

读 `dsh-agent-loop/lib/index.js` 的 `ReactLoopInbox` 与 `send()`：

```js
send(message, target, wakeup) {
  const wakingAfterAbort = wakeup && phase.kind !== 'idle' && phase.abort.signal.aborted
  const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
  this.inbox.splice(resolvedTarget, Infinity, 0, [message])   // ← 内部同步 emit 'agent/inbox/inserted'
  if (wakeup) this.wakeDriver(wakingAfterAbort)                // ← 之后才唤醒驱动器
}
followup(input) { this.send(input, 'next-turn', true) }
steer(input)   { this.send(input, 'next-step', true) }
inject(input)  { this.send(input, 'next-step', false) }
```

`ReactLoopInbox.splice()` 的顺序是：`session.append('agent/inbox/spliced', …)` → 对每条 inserted 消息 `dispatch.emit('agent/inbox/inserted', { message })` → 返回。所以：

- **发射是同步的，且在唤醒之前**。监听器里调 `select()` 时，驱动器还没开始下一步准备 → **对本步/下一步都安全**（空闲 followup 对应新 turn 的首步；运行中 steer 对应当前 turn 的下一个 step）。
- 载荷：事件由 agent 作用域 dispatch 发出，监听器拿到 `{ agent, message }`（签名见 api-catalog；loop 只 emit `{ message }`，`agent` 由 `@deepseek-ai/dsh-scope` 注入）。
- **会重复触发**：`followup`/`steer` 每条消息一次；`inject`（其它插件注入上下文）也走同一条 `splice → inserted`，但**不会唤醒**。所以监听器必须：
  1. 只对 `message.source.kind === 'user'`（用户真实输入）做分类，忽略 `runtime-context`、`model-selection` notice 等注入；
  2. 按目标列表去抖/合并：同一批 `next-turn` 消息应合并分类一次，而不是每来一条就 `select()` 一次；
  3. 记住「本 agent 最近一次由本插件 select 的目标」，避免与用户手动选择互相覆盖（见 B）。
- 同一目标重复 `select()` 是 no-op（`select()` 内部 `sameModelSelection(recordedSelection(), selection)` 直接 return），但**A→B→A 的抖动会各记一条 `model/selection`**，因此需要迟滞（hysteresis）。

> **反例（最容易犯的错）**：把「分类 + `select()`」写进 `agent/pre-step` 监听器。pre-step 的 `selection` 是在 dispatch 之前取的，改模型**只对下一个 step 生效**，当前 step 仍走旧模型；表现为「第一条请求永远路由不到、第二条才开始生效」。更糟的是它看上去「偶尔有效」，很难排查。pre-step 只用于观察/记录；改模型必须发生在 inbox 插入时（或任何早于 `preStep()` 取 `current()` 的位置，但 inbox 是唯一有稳定语义的公开挂点）。

#### B. `select()` 会持久改会话选择：副作用边界

`dsh-agent/lib/types/model-selection.js`：

```js
class AgentModel {
  current() { const recorded = this.recordedSelection(); if (recorded !== null) return { ...recorded }; /* 否则回退 options */ }
  select(selection) {
    if (sameModelSelection(this.recordedSelection(), selection)) return
    this.session.append('model/selection', toSelection(...))
  }
  recordedSelection() { const s = this.readState(); return s.pending ?? s.lastUsed }
}
```

结论：

- `select()` **不是临时覆盖**，而是往会话日志追加 `model/selection`，成为该会话的**已记录选择**（`modelSelection.pending`，下一个匹配的 `request/header` 把它转为 `lastUsed`）。它会进会话持久化、跨窗口/重启可见，模型选择器也会显示为这个模型。
- 因此与旧行为有本质差别：旧插件是「选择层覆盖，会话选择器不动」；新接缝是「**插件替用户改了会话模型**」。关掉插件后，会话会**停在最后一次被路由到的模型**上，不会自动回到用户原来的选择。
- 恢复策略（必须实现）：
  1. 每个会话记住「本插件第一次介入前的 `agent.model.current()`」作为 `restoreSelection`；
  2. 关开关 / 会话解耦 / 插件卸载时，若当前 `current()` 仍等于我们最后一次 select 的目标，则 `select(restoreSelection)` 还原；若用户在此期间手动改过，则不动（用户选择优先）；
  3. 设置页提供「恢复会话原模型」按钮。
- 归因缺口：`model/selection` 事件**没有 source/author 字段**（`toSelection` 只写 provider/model/reasoningEffort），插件无法区分「用户手选」与「自己选的」。可行启发式：若 `current()` 既不是我们的目标、也不是我们的 `restoreSelection`，视为**外部（用户）选择**，本 turn 内退让不再 select，并记 `debug.log`。
- 用户可见副作用：若该 agent preset 安装了 `installModelSelection`，路线变化会向下一个 step 注入一条 `[model changed: …]` 的 user-visible notice（`model-selection.js::modelSwitchNotice`）。抖动会刷屏，因此**迟滞 + 每 turn 最多一次重选**是硬要求。

#### C. 本机实证：当前 0.12.0 在本核心上只是 no-op（不是「工作正常」）

`$DSH_HOME/plugins/dsh-peak-valley-router/debug.log`（291 KB，截至 2026-11-18T14:11Z）：

- `agent/request: routed -> deepseek-official/deepseek-flash@low (session … already resolved to it; nothing to rewrite; via primary)`：**872 条**；
- 含 `override` 的行：**0 条**；
- 含 `after step preparation fixed` 的行：**0 条**；
- `agent/request override failed`：**0 条**。

同期 `policy.json` 的主模型/高级模型都是 `deepseek-official/deepseek-flash`（`low` / `max`），`state.json` 全局 `enabled: true`。也就是说：**所有请求的目标恰好等于会话已解析的模型**，插件每次都在「相同则不动」分支返回，从未真正改写过模型——所以既没炸，也没有证明路由可用。只要目标与会话模型不同（例如把峰时切到 `codex`、或把抽象任务切到高阶模型），就会命中 0.2.2-rc.1 的 `prepareRequest` 校验并抛错。

**验收口径据此修正**：0.15.0 的桌面验收不能只看「开关打开、日志有 routed」，必须构造一个**目标 ≠ 会话模型**的用例（临时把策略主模型改成另一个已注册模型），确认是否抛 `after step preparation fixed`；0.16.0 的新接缝则要验收「`select()` 之后，下一步的 `request/header.provider/model` 真的变了」。

---

## 1. RouteLLM（lm-sys）

- 仓库：<https://github.com/lm-sys/RouteLLM>
- 论文：<https://arxiv.org/abs/2406.18665>
- 博客：<https://www.lmsys.org/blog/2024-07-01-routellm/>
- 关键源码：`routellm/routers/routers.py`、`routellm/routers/matrix_factorization/model.py`、`routellm/calibrate_threshold.py`

### 1.1 共同骨架：胜率 + 阈值

所有路由器都实现同一个方法 `calculate_strong_win_rate(prompt) -> [0,1]`，然后：

```python
if strong_win_rate >= threshold: 用强模型
else: 用弱模型
```

也就是说，**路由 = 「强模型胜率」这一个标量 + 一个阈值**，而不是「N 选 1 分类」。阈值 α 越高越偏向弱模型（省成本），越低越偏向强模型（保质量）。论文把这点写成：

```
R^α(q) = M_weak  if P(win_s | q) < α
         M_strong if P(win_s | q) >= α
```

**能否复刻：能，且这是最该照抄的形态。** 三档路由可以直接映射成「一个有序标量 + 两个阈值」：`score < τ1 → 低档`、`τ1 ≤ score < τ2 → 中档`、`score ≥ τ2 → 高档`。零依赖、纯函数、可单测。

**采用。** 理由：我们不需要训模型，只需要一个可解释的分数与两个可调阈值；这比「规则 if/else 一把梭」更容易校准、更容易在设置页展示「为什么是这一档」。

### 1.2 `mf`（matrix factorization，官方推荐）

核心逻辑（源码 `matrix_factorization/model.py`）：

- prompt 先过 OpenAI `text-embedding-3-small`（1536 维）；
- `text_proj: Linear(1536 → 128, bias=False)` 把文本投到隐空间；
- `P = nn.Embedding(num_models=64, dim=128)` 是「每个模型一个 128 维向量」（推理时 L2 归一化）；
- 打分 = `classifier(model_embed * prompt_embed)`，`classifier = Linear(128 → 1, bias=False)`，即**逐元素相乘后线性打分**；
- 两个模型各得一个 logit，`P(strong wins) = sigmoid(logit_strong − logit_weak)`；
- 训练目标是 Arena 偏好对比（强/弱），用 `train_matrix_factorization.py` 拟合。

论文/博客给的数字：MT Bench 上 95% GPT-4 质量只需 26% GPT-4 调用（仅 Arena 数据），加 LLM-judge 增强后降到 14%；整体「成本降 85%、45%、35%」（MT Bench / MMLU / GSM8K）。

**能否复刻：不能照抄实现（要 embeddings + torch）；但能照抄「数学形状」。** 把 1536 维 embedding 换成**手写特征向量**（见第 6 节），`mf` 就退化成「特征 · 权重」的一次点积——零依赖、可解释、可手调。这是本插件最现实的做法。

**采用（降级形态）：线性打分 + 特征工程。不采用：OpenAI embeddings、torch 权重、离线训练的 64 个模型向量。** 理由：插件零依赖、离线、不能替用户发 embedding 请求（隐私 + 密钥 + 延迟），且我们只有「高/中/低」三档而不是 64 个模型。

### 1.3 `sw_ranking`（相似度加权 Elo）

核心逻辑（`routers.py::SWRankingRouter` + 论文 Eq.9-10）：

- 把每条历史 query 用 `text-embedding-3-small` 向量化；
- 新 query 与每条历史 query 算余弦相似度，再除以「该历史 query 与全库的最大相似度」做归一化；
- 权重 `ω' = 10 · 10^(sim / max_sim)`（源码 `get_weightings`；论文写作 `γ^{1+S}`，`γ=10`）；
- 用这些权重做**加权 Bradley-Terry / Elo MLE**（10 个模型 tier），得到强弱两 tier 的分数 `ξs, ξw`；
- `strong_win_rate = 1 − 1/(1 + 10^((ξs − ξw)/400))`；
- 阈值与 `mf` 共用同一套校准。

**能否复刻：不能。** 需要全量 Arena 历史 + embeddings + 每次推理都重解 Elo MLE（源码里是每次 query 都 `compute_elo_mle_with_tie`），延迟与依赖都不现实。

**不采用。** 只保留一个思想：**「相似的历史请求应该得到相似的档位」**。落地成零依赖版本就是「最近 N 条已路由请求的特征向量做 kNN，取多数档位」，作为可选校准/平滑（默认关）。**建议 0.16.0 先不做 kNN**，避免引入状态与不可解释性。

### 1.4 `bert` / `causal_llm`

核心逻辑：

- `bert`：`AutoModelForSequenceClassification(num_labels=3)`，标签是「tier1 赢 / 平局 / tier2 赢」。源码里 `binary_prob = sum(softmax[-2:])`（平局 + 弱方赢），`strong_win_rate = 1 − binary_prob`。也就是**平局被算进弱方**，整体偏保守地升级。
- `causal_llm`：让 LLM 打 1–5 分再二值化；输出无效时 `return 1`（**直接当强模型胜率 = 1，路由到强模型**）。

**能否复刻：不能（要 BERT/LLM 推理）。** 但 `causal_llm` 的失败模式处理值得抄：**路由器自身出错时，偏向安全的一侧（强模型），而不是静默用弱模型。**

**采用（只抄原则）：解析失败 / 特征缺失 → 走高档次或保持会话原模型，绝不因为「没算出来」而降到低档。** 理由：低档质量损失是隐性的，用户看不见；高档次多花钱是显性的，可解释。

### 1.5 阈值校准（最值得抄的一节）

`calibrate_threshold.py` 的做法非常朴素：

1. 用一批**代表性 query** 跑路由器，得到每个 query 的 `strong_win_rate`；
2. 想要「50% 请求走强模型」，就取这批分数的 **`quantile(1 − 0.5) = 0.5` 分位数**当阈值；
3. 打印出来（示例：`mf` 在 50% 强模型调用时阈值 = 0.11593）。

注意两点：

- 阈值**因路由器、因流量分布而异**，没有通用值；官方建议「用与你真实流量相近的数据校准」。
- 校准数据本身可以是**日志**：先把决策打成 shadow 记录，不真正改路由，再离线算分位数。

**能否复刻：能，完全能。** 甚至不需要历史数据才能上线：先给一组默认权重与默认阈值（经验值），同时把每次决策的 `{features, score, tier, 实际目标}` 写进 `debug.log` 或独立 `decisions.jsonl`；跑一周后按目标分布（例如 70% 低 / 20% 中 / 10% 高）取分位数，回填设置页。

**采用。** 这是「智能程度路由」能否从「拍脑袋权重」变成「可校准系统」的关键。建议在设置页显示「最近 N 次决策的档位分布」，并允许一键按目标分布重算阈值。

---

## 2. aurelio-labs/semantic-router

- 仓库：<https://github.com/aurelio-labs/semantic-router>
- 文档（0.x）：<https://docs.aurelio.ai/docs/semantic-router/v0/user-guide/guides/semantic-router>
- 组件：<https://docs.aurelio.ai/docs/semantic-router/v0/user-guide/components/routers>
- 阈值优化：<https://docs.aurelio.ai/docs/semantic-router/v0/user-guide/features/threshold-optimization>

### 2.1 核心逻辑（utterances → route）

一个 `SemanticRouter` = `encoder` + `index` + `routes`：

- 每条 `Route` 有 `name`、`utterances`（若干「应该命中这条路」的示例句）、可选 `score_threshold`；
- 建索引时把所有 utterances 编码成向量存进 index；
- 查询时：encode(query) → 在 index 里找 **top_k 个最近的 utterance**（文档明写 `top_k` 默认 5）→ 把命中的 utterance 分数**按 route 聚合**（库内提供 mean/max/min 聚合；默认值以源码/版本为准，**本处未核实**）→ 与 route 的 `score_threshold` 比较 → 命中最高分；都不中返回 `name=None`；
- `limit` 控制返回几条（`limit=None` 返回全部过阈值的），`limit` 与 `top_k` 是两件事，`limit>1` 时要手动加大 `top_k`；
- `HybridRouter` = 稠密 + 稀疏（BM25/TF-IDF 类），`alpha` 控制权重（0 = 全稠密，1 = 全稀疏），文档建议「查询里有必须精确匹配的术语（产品码、人名、行话）时用 hybrid」；
- 校准：`fit(X, y)` / `evaluate(X, y)`，用带标签的 (utterance, 目标 route) 例子自动找阈值；文档特意提醒测试集要包含 `None` 例子，「否则阈值会塌到 0」。

**能否复刻：不能照抄（要 encoder + 向量索引）；但形态可以 100% 复刻，且不需要向量。**

- 把「utterances」换成**正则 / 关键词组 / 示例片段**；
- 把「余弦相似度」换成**加权命中计数**（等价于稀疏编码的极简版）；
- 把「top_k 近邻」换成「直接对每个 tier 的 pattern 集合打分」；
- 「fit 阈值」换成「在带标签样本上网格搜索阈值」。

**采用（形态层面）：命名路由 + 示例/模式集合 + 每路由阈值 + 用带标签样本校准。**
**不采用：embedding、向量库、`auto_sync`、动态路由（function calling）。** 理由：零依赖环境没有 encoder；而且我们的三档是**有序**的，不是互斥意图分类，直接照搬 argmax 会丢掉「介于中/高之间」的信息——必须用第 1 节的「标量 + 两个阈值」，不要用 semantic-router 的「多路 argmax」。

### 2.2 一个值得抄的细节

`Route.score_threshold` 是**每条路由各自可调**的。对应到我们：三个档位的进入阈值应各自可配（低/中/高的边界独立），而不是一个全局阈值切三份。这直接支撑「每档各自的峰谷表 / 每档可关」的配置形态。

---

## 3. FrugalGPT（cascade 与成本-质量取舍）

- 论文：<https://arxiv.org/abs/2305.05176>
- 关键内容：第 3 节 Strategy 3（LLM cascade）、第 4 节 case study / cost savings

### 3.1 核心逻辑

FrugalGPT 把「省钱」拆成三类策略：prompt adaptation、LLM approximation（缓存/蒸馏）、**LLM cascade**。cascade 的两个组件：

1. **generation scoring function** `g(q, a) → [0,1]`：给「query + 某个模型生成的答案」打可靠性分；
2. **LLM router**：选一个有序模型列表 `L = [L1..Lm]` 和每级阈值 `τ`。

运行方式：依次调 `L1, L2, …`；每次用 `g` 打分，`g(q, f_Li(q)) ≥ τ_i` 就返回该答案，否则调下一个。优化目标是「在平均成本 ≤ 预算 b 的约束下最大化质量」，同时学 `L` 和 `τ`（混合整数规划，作者做了剪枝与插值近似）。

实验细节（可直接引用的数字/结构）：

- 12 个商业 API、5 家厂商；cascade 长度固定 3；
- case study 用 **DistilBERT 回归**当 `g`；学到的策略是 `GPT-J → J1-L → GPT-4`，阈值 `0.96`、`0.37`；
- HEADLINES 上成本降 98%（匹配 GPT-4 精度），case study 里降 80% 且精度 +1.5%；
- 「便宜模型有时能在贵模型错的地方答对」（MPI，最大性能提升）是 cascade 有效的根本原因。

### 3.2 能否在本插件复刻

**不能。** 三个硬约束：

1. cascade 需要**在拿到第一个答案后再次发起请求**。本机核心的 `agent/request` 已弃用且不允许改模型；`llm/stream` 是「深冻结的完整请求」waterfall，监听器可以读、可以 yield 自己的 chunk，但**没有受支持的「用另一个模型重跑一次」的入口**。
2. 即使能重跑，agent loop 的一个 step 只允许一个 assistant 结果；cascade 会重复计费、拉长延迟，还会让「这一步到底用了哪个模型」在会话日志里不可解释。
3. 没有 `g`：本插件零依赖、不训练模型、不能调外部评分服务。

**不采用自动 cascade。** 采用它的**决策思想**，落到配置层：

- 每档声明「成本预算/价格上限」，在候选模型里选**满足该档质量下限的最便宜者**（见 4.1 / 4.2）；
- 提供「升级」的显式开关（用户/会话可以手动把本档临时提到上一档），而不是自动二次调用；
- 把「便宜模型互补」当成**候选池设计原则**：同一档里放 2–3 个不同厂商的模型，按成本排序，而不是只放一个。

> 若未来核心暴露「带升级的重试」语义（`agent/request-error` 现在只处理**失败**重试，不处理**质量**重试），再考虑 cascade；当前不要为它预留复杂状态机。

---

## 4. 工业界做法里可离线复刻的部分

### 4.1 NotDiamond（托管路由器）

- API 参考：<https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post>

核心逻辑（请求参数即产品设计）：

- 输入 `messages` + `llm_providers`（候选模型列表），输出**一个**推荐模型 + `session_id`；
- `metric`（默认 `accuracy`）选优化目标；
- `tradeoff`：`cost` 或 `latency`；与 `cost_quality_tradeoff` 互斥；
- `cost_quality_tradeoff`：**0–10 的整数**，0 = 纯质量（默认），10 = 最便宜，中间值混合两个信号；只对预训练路由器有效，自定义路由器传它会 422；
- `max_model_depth`：最多考虑几个候选（剪枝）；
- `preference_id` / `previous_session`：个性化与同会话粘性；`session_id` 用于回传反馈继续训练。

**可离线复刻的部分（采用）：**

- **一个 0–10 的单一旋钮**，而不是让用户理解一堆权重。配置里每档暴露 `costQuality: 0..10`，默认值就是「三档共用低档配置」的那份；
- **候选深度**：每档只考虑成本排序后的前 N 个候选（默认 3），避免长尾候选把延迟拖垮；
- **会话粘性**：同一会话内已选过的目标，除非分数跨档，否则不来回跳（实现成 5 分钟/同 turn 的 hysteresis）。
- **反馈**：不需要服务端，落成 `decisions.jsonl` + 设置页「这档最近选了什么」。

**不采用：** 托管路由器、在线学习、`preference_id` 个性化、延迟信号（我们没有历史延迟数据）。

### 4.2 OpenRouter（provider routing / model fallbacks）

- 默认路由：<https://openrouter.ai/docs/guides/routing/provider-selection>
- 模型 fallback：<https://openrouter.ai/docs/guides/routing/model-fallbacks>

核心逻辑：

- 默认路由按**近 5 分钟生产流量**的 effective price、吞吐、TTFT、429 率、可靠性、工具调用质量加权随机选 provider；表现接近的 provider 分摊流量，差的保留小份额以便恢复；429 风暴会临时降权；
- 可用 `sort: price|throughput|latency`、`max_price`、`order`、`only`/`ignore`、`partition: model|none` 覆盖默认；
- `models: [...]` 是按优先级排列的 fallback 列表：**第一个模型报错就自动试下一个**（错误包括上下文超长、审核拒绝、限流、宕机）；计费按**最终使用的模型**；
- `:floor` = 价格优先，`:nitro` = 吞吐优先（都绕过默认路由）。

**可离线复刻的部分（采用）：**

- **有序候选 + 显式 fallback**：每档配置是 `[首选, 次选, …]`，只在「目标不可路由 / provider 明确失败」时按顺序降级，且**降级要可见**（写进告警与 `debug.log` 的原因里）；
- **`max_price` 语义**：每档一个 `maxCost` 上限，超限的候选直接不进候选池（而不是选中后再失败）；
- **`partition: model`**：先按模型分组、再按成本排序，保证「首选模型永远先试」，不让便宜的次选把首选挤掉；
- **按最终模型计费/记账**：我们的 `decisions.jsonl` 也必须记「最终生效的 provider/model」，而不是「计划中的」。

**不采用：** 加权随机、实时遥测、429 容量学习（插件没有流量数据，也不该偷偷改变用户预期）；`:floor`/`:nitro` 这类 URL 级快捷方式不适用于本插件。

### 4.3 Martian（以及其他「学习型路由器」）

- 官方文档首页（现状）：<https://docs.withmartian.com/> —— 现在只列 Gateway / ARES / K-Steering，**路由器产品页 `/router` 已 404**；
- 第三方对比：RouteLLM 博客把 Martian 当作商业路由器对比（「同等性能、便宜 40%+」）。

**核心逻辑（据公开描述，未核实到实现）：** 训练一个「prompt → 哪个模型更好」的分类器，对分布外/低置信度请求回退到默认（通常是更强的）模型；支持按域定制。

**能否复刻：不能复刻其模型；可复刻其「不确定性回退」原则。**
**采用：低置信度 → 回退强模型/会话原模型。** 这条与 1.4 的 fail-open 是同一条原则，不重复实现。
**不采用：** 不复刻分类器训练；不引用其专利细节当契约。市场宣传里的「便宜 40%」不进入我们的默认值论证。

---

## 5. 本机已装插件里的成本/配额逻辑（重点：`dsh-usage-state`）

### 5.1 位置与版本

```
$DSH_HOME/profiles/.generations/live/dsh-usage-state+0.4.17+d3919246b172/node_modules/dsh-usage-state
```

`package.json`：版本 **0.4.17**，`engines.dsh: ^0.2.0-rc.2 || ^0.2.1-rc.1 || 0.2.2-rc.3`，`exports` 含 `.`（`lib/index.js`）、`./client`、`./typert`。
文档：`README.md`、`README.en.md`、`docs/adapters.md`（后者写清了每个数据源的字段语义与错误归类）。

### 5.2 它到底暴露了什么

**宿主侧服务（可被其它插件读到）：**

- `lib/index.js:1975` `const USAGE_STATE_SERVICE = "usageState"`；
- `lib/index.js:2201-2214` `provideUsageState()`：给 service 挂 `typertRemote = { service, serviceKey: "usageState", namespace: "usageState" }`，然后 `ctx.provide("usageState", service)`；
- `UsageStateService`（`lib/index.js:1983-2012`）只有两个方法：
  - `getState(force?) → { sources, snapshots, endpointHints?, checkedAt }`；
  - `describeCredentials() → { credentials: { [targetKey]: … } }`（只返回状态，不返回密钥）。

**数据形状（快照）：**

- `snapshots` 是 `{ [targetKey]: snapshot }`，`targetKey = "${sourceId}:${mode}"`，例如 `deepseek:account`、`deepseek:api`、`zai:coding-plan`、`kimi:coding-plan`、`openai:admin`、`sub2api:api`；
- `snapshot` 字段：`sourceId`、`mode`、`balances[]`、`windows[]`、可选 `currentMonthSpend`、`fetchedAt`、可选 `stale: true`、可选 `error: { kind, detail }`；
- `windows[]` 元素：`{ id, usedPercent, resetsAt? }`，`usedPercent` 是 0–100 的**已用**百分比，`id` 有 `5h` / `7d` / `month` / `month-code` / `1d` / `30d` 等；
- `balances[]`：法币余额（CNY/USD，充值与赠送拆分）；
- `currentMonthSpend`：仅 OpenAI `admin` 模式，**整个组织当前 UTC 月已报告的 USD 消费，不是余额**。

**失败语义（很重要，直接决定我们能不能用）：**

- 同一身份读取失败时**保留上次成功值并标 `stale: true`** + `error`（`lib/index.js:1912-1927`）；从未成功过则返回空 `balances/windows` + `error`；
- 刷新由宿主定时器 + turn 结束驱动（默认 turn 结束后延迟 2 秒、5 分钟兜底、成功请求最小间隔 60 秒），**没有「刚花完钱」的实时事件**；
- `README.md` 明确写：「只显示账户当前读数，**不做成本归因、价格目录、预算或历史账单**」。

### 5.3 能不能「引用而不重复实现」

**能读，但不能当主信号。** 具体判断：

| 问题 | 结论 |
|---|---|
| 有没有可用配额/余额信号？ | 有。`ctx.get('usageState').getState()` 的 `snapshots[*].windows[*].usedPercent` / `balances` 就是。 |
| 能不能不重复实现 HTTP/凭据？ | 能。它已经处理了 DeepSeek 账号/API Key、z.ai、Kimi、Moonshot、OpenCode、OpenAI(admin)、Sub2API 的端点、凭据与错误分类。我们**绝对不要**再写一遍余额查询。 |
| 能不能把「provider/model」可靠映射到 `targetKey`？ | **不能（公开面没有）。** 映射逻辑在 `lib/index.js:395-457`（`PROVIDER_HINTS` 正则 + endpoint host 推断 + `suggestSourceId`），是内部函数，未导出；同一 `sourceId+mode` 只保留「首个有效 provider」。我们只能按 provider id 前缀猜（`deepseek-official` → `deepseek:api`，`deepseek-account` → `deepseek:account`，`zai`/`glm` → `zai:coding-plan`…），猜错就会把 A 的配额当成 B 的。 |
| 有没有事件/订阅？ | 没有。只能轮询 `getState()`；且 `getState()` 会顺带 `refresh(key, {onlyIfMissing})`，调用有成本。 |
| 是不是稳定公开契约？ | **不是。** `README.md` 从头到尾没把 `usageState` 服务写成 API；只有源码注释说明它给 RPC gateway 用。跨版本可能改名/改形状。 |
| 能不能算「每次请求花了多少钱」？ | **不能。** 没有价格目录、没有 token 记账、没有历史；`currentMonthSpend` 是组织月消费总数。 |

**结论：**

1. **不要重复实现**余额/配额 HTTP 读取；如果将来要用，就通过 `ctx.get('usageState')`（宿主侧，**存在性探测 + try/catch + 超时**）读取，绝不在客户端直接打 `usageState` RPC（namespace 未文档化）。
2. **不要把它当成本决策路由的主信号。** 理由：缺 provider→target 映射、可能 `stale`、无事件、无价格、版本不稳。它只能做**降级/降权提示**：例如「该 provider 的 5h 窗口已用 ≥ 95% → 本档优先选另一个候选」，且**失败必须 fail-open**（读不到就不影响路由）。
3. 成本决策的主信号应该是**用户可编辑的每档价格/成本等级**（因为核心 `llm.listModels()` 只给 id/name/badge，**没有价格字段**；`dsh-llm` 只提供「按图的计价」给 token meter，不是通用价格目录）。这不是偷懒，是当前宿主能力决定的。

**另外检查过：** 本机 `live` 代际里除 `dsh-usage-state` 外没有其它插件提供成本/配额逻辑（`dsh-cost-meter` 未安装，`dsh-usage-state` 的 README 只是致谢它提供过数据源行为参考）。所以「引用现有逻辑」的上限就是它。

---

## 6. 「请求复杂度三档」用什么特征最稳

目标：把一次请求分到 **抽象（→高档模型）/ 中等抽象（→中档）/ 具象执行（→低档）**。三档有序，用**一个标量 `concreteness ∈ [0,1]` + 两个阈值**（见 1.1）。

### 6.1 可用输入（按可靠性排序）

| 输入 | 来源 | 可靠性 | 备注 |
|---|---|---|---|
| 本步新消息文本 | `agent/inbox/inserted` 的 `message`（**首选**，见 0.1 A）；`agent/pre-step` 的 `messages`（观察用） | 高 | 分类主输入。要处理 content 块（text / image 等），不要假设是字符串；只取 `message.source.kind === 'user'` |
| 轮次/步骤位置 | `agent/pre-step` payload `turn` / `step` | 高 | `step > 1` 基本意味着「工具后续步」，几乎总是具象执行 |
| 当前模型选择 | `agent.model.current()`（inbox 时）/ payload `modelSelection`（pre-step 时） | 高 | 用于 hysteresis（避免来回跳）、外部选择检测与「本会话已在高档」判断 |
| 会话历史 | `agent.session`（现有代码已用 `session.header.id`） | 中 | 完整消息读取 API 需按 `dsh-session` 投影核对；不要假设能同步拿到全部历史 |
| 工具集 | **不在 pre-step payload**（`preStep` 内部 `tools.resolve`） | 低 | 要么从 `agent.session` 的 `request/header.tools` 拿，要么不用 |
| 用户显式档位 | 文本里的「认真想 / 快点 / 直接改」等 | 中 | 作为 override，而不是特征 |
| 附件/图片 | 消息 content 块 | 中 | 有图通常偏「具象」，但不要过度加权 |

### 6.2 建议权重（`concreteness`，高 = 具象执行）

先把每条特征归一化到 `[0,1]`，再加权求和，最后 clamp 到 `[0,1]`：

| 特征 | 判定 | 权重 | 理由 |
|---|---|---|---|
| 代码块 | 出现 ``` 围栏或 ≥3 行缩进代码 | **+0.22** | 贴代码通常意味着「改/查这段」；但**贴日志里的代码块**会误判，见反例 |
| 文件路径/扩展名 | `[\w./\\-]+\.(ts|tsx|js|mjs|py|json|md|ya?ml|toml|ps1|sh|go|rs|java)` | **+0.18** | 明确指向仓库里的对象 |
| 命令/CLI | 行首 `$ ` / `> `，或 `npm|pnpm|node|git|dsh|pytest|cargo|go test` | **+0.18** | 「跑一下」是最典型的具象执行 |
| 具体符号/行号/错误 | 反引号包住的标识符、`Foo.bar(`、`:123`、`ENOENT|EADDRINUSE|TS\d{4}`、堆栈 | **+0.12** | 指向具体 bug |
| 祈使执行动词（近距） | 改/加/删/跑/装/提交/修/重命名/迁移；fix/run/add/remove/rename/install/commit | **+0.15** | 动词比名词可靠；要求与「对象」（路径/命令/代码）同时出现才加权，单独出现只给一半 |
| 多子问题 | ≥2 个问号，或编号列表（`1)`、`- [ ]`、「第一/第二」） | **−0.12** | 多任务更像「规划/编排」，偏抽象；但也可能是「批量执行」，见反例 |
| 抽象问题词 | 为什么/原理/设计/方案/评估/取舍/tradeoff/架构/对比/该不该；why/design/architecture/evaluate | **−0.20** | 典型「要判断，不要动手」 |
| 长文（>1500 字符） | 纯长度 | **−0.08**（弱） | 长 ≠ 抽象；长往往是粘上下文，权重必须小 |
| 极短（<80 字符）且无上述具象特征 | 纯长度 | **−0.05** | 短问题常是概念提问；但有命令/路径时已被正权重覆盖 |
| 工具后续步 | `step > 1` 或 payload 含工具结果上下文 | **+0.25** | 同一 turn 的后续步几乎总是执行；这条应能压过其他特征 |
| 附件/图片 | content 含 image 块 | **+0.08** | 偏具象，但证据弱 |

档位映射（默认）：

```
concreteness ≥ 0.55  → 具象执行（低档）
0.28 ≤ c < 0.55      → 中等抽象（中档）
c < 0.28             → 抽象（高档）
```

**为什么用「具象度」而不是「复杂度」**：复杂度是主观的（「解释一下 TCP」可能很难），但「要不要动手」是客观可判的；而团队要的三档本质是「抽象思考 / 半抽象 / 动手执行」。用可判的特征去拟合可判的目标，比拟合「难度」稳。

### 6.3 反例（必须写进测试）

1. **长文 + 「总结一下」**：长度与代码块都高，但这是抽象任务 → 长度权重必须小，且「总结/解释/评估」类动词要能抵消。
2. **贴一段报错日志 + 「为什么」**：代码块/路径 +0.4，抽象词 −0.2，仍可能落到中档；如果用户其实要「查这个 bug」，应该低档。→ 用「祈使动词 + 具体对象」组合提高权重，而不是单看代码块。
3. **极短命令「跑一下测试」**：长度极短会给负分，但命令特征 +0.18、执行动词 +0.15 → 仍应低档。→ 长度特征**不能**压过命令特征，阈值要留余量。
4. **「帮我重构整个项目」**：几乎没有具象特征（没路径/命令），会落到抽象档——但这是**高风险大范围变更**，也应该高档。→ 需要一条**安全 override**：出现「全项目/所有/批量/发布/回滚/删库」等词，直接强制高档（不是靠 concreteness）。
5. **同一 turn 的第 3 步**：历史里全是代码和工具输出，若把整段历史喂进分类器会一直判「具象」。→ 只用 `payload.messages`（本步新消息）+ `turn/step`，不要把历史全文当特征。
6. **中英混写 / 纯英文**：关键词表必须双语；中文没有空格，`\b` 词边界不可靠，用子串匹配 + 长度约束。
7. **代码块出现在「引用别人的代码让我解释」**：与 1 同类，靠抽象动词抵消。
8. **流式/分块消息**：`messages` 的 content 可能是块数组、甚至图片；分类器必须对「没有文本」安全降级（走中档或保持原模型），不能抛错。

### 6.4 校准与验收

- **先影子模式**：`intelligence.enabled=false` 时也计算并记录 `{score, tier, features}`（不改变路由），跑一周；
- 按目标分布取分位数回填阈值（RouteLLM 1.5 的做法）；
- 验收指标不是「分类准确率」（没有标注），而是**代理指标**：低档请求的失败率/重试率、用户在同一会话里手动升级的比例、工具报错率。若低档失败率显著高于中档，阈值调高。
- 设置页提供一个「样例试算」输入框：粘贴一段 prompt，显示分数、命中特征、档位。这比调权重滑块更能建立信任。

### 6.5 「默认三档共用低档配置」怎么落

配置上只存一份 `concrete` 配置，另两档 `share: 'concrete'`；GUI 显示继承值（只读），用户点「解除共用」才复制一份独立配置。这样默认行为 = 全部走低档（与现在的默认 DeepSeek Flash 一致），不会因为引入三档而悄悄把用户账单推高。

---

## 7. 施工清单（可直接照抄的部分）

### 7.1 决策顺序（建议）

```
1. 在 agent/inbox/inserted 里过滤：只处理 message.source.kind === 'user'，忽略 runtime-context / notice / 其它插件注入
2. 同一目标列表去抖/合并成一次分类，读 agent.model.current()（现选择）与该批消息
3. 计算 concreteness → tier（intelligence.enabled=false 时 tier 固定为 concrete）
4. 取该 tier 的「峰谷表 / 峰谷窗口 / 节假日」→ 时间策略（复用 resolveSelectionDetailed 的时间判定，lib/index.js:272-310）
5. 成本决策：在该 tier 的候选池里按 costRank / maxCost 选一个（cost.enabled=false 时直接用第 4 步结果）
6. isRoutable 检查（复用 lib/index.js:664-690 的 provider/model 目录判定）
7. 不可路由 → 记录可见告警 + 保持原模型（fail-open）
8. 若目标 ≠ current() → agent.model.select(selection)（同目标不重复 select；每 turn 最多一次重选，防 notice 刷屏）
9. 记录 restoreSelection（首次介入前）与 decisions.jsonl
```

> `agent/pre-step` 只做**观察/记录**（`turn/step/modelSelection` 与最终 `request/header` 对照），**不要在里面改模型**——它改不到本步。

### 7.2 复用点（不要重写）

- 时间/节假日/窗口：`minutesOf`、`timeInWindows`、`isHoliday`、`resolveSelectionDetailed`（`lib/index.js:249-310`）；
- 目录与可路由判定：`catalogProviderIds`、`isRoutable`、`logUnroutable`、`logUnroutableModel`（`lib/index.js:584-690`）；
- 原子写盘：`writeJsonAtomic`（`lib/index.js:322-350`）；
- 每会话覆盖与容量淘汰：`state.json` 现有 `sessions` 语义（README「运行时数据」）；
- 文案单一来源：`lib/text.js`（新增 key 必须双语）。

### 7.3 跨窗口/多进程状态同步（结合现有实现）

现状（README 已知限制）：`state.json` 只在加载时读一次，客户端不轮询；两个进程各持快照，后写覆盖整张 `sessions` 表。

建议（零依赖可做）：

- `state.json` 增加单调 `revision` 与 `updatedAt`；写入前重读，按 `sessionId` 做**键级合并**（不是整表覆盖），再以 `revision + 1` 原子写回；
- 写锁用 `state.json.lock`（`open(path, 'wx')`，内容 `{pid, ts}`），失败重试 3 次、超过 5 秒视为陈旧锁并清理；
- 订阅 `fs.watch(pluginDir)`（Node 内置）去抖 200ms 后重读，**只更新内存快照，不回写**；
- 客户端通过现有 `get` RPC 每 15–30 秒拉一次（或订阅一个轻量 `watch` RPC），避免「A 窗口改了 B 看不到」；
- 冲突时以 `updatedAt` 较新者为准，并在 `debug.log` 记一行合并结果。

### 7.4 可见告警

`isRoutable` 失败现在只有 `debug.log`。建议把它提升为状态：`lastUnroutable = { at, provider, model, reason }`，放进 `get` RPC 的 `value`，设置页顶部横幅显示「目标不可路由：xxx → 已保持会话原模型」。会话内也可用 composer 侧小灯变红（现有 `sidebar.session.row.leading` 插槽）。这是团队目标里「目标不可路由时可见告警」的最小实现。

### 7.5 测试（对齐现有脚本风格）

- `scripts/routing-tier.test.mjs`：纯函数分类器表驱动（含 6.3 全部反例）；
- `scripts/routing-calibrate.test.mjs`：分位数阈值回填；
- `scripts/state-merge.test.mjs`：模拟两进程并发写，断言不丢 session 键；
- `scripts/inbox-routing.test.mjs`（新接缝）：
  - 假 agent + 假 session，驱动 `agent/inbox/inserted`，断言 `model/selection` 事件在**步骤准备前**被 append（用事件序列断言顺序，不测墙钟）；
  - 非 user 注入（`runtime-context`、`model-selection` notice）不触发 select；
  - 同一目标重复插入只 append 一次；A→B→A 抖动时按迟滞规则不 append；
  - `current()` 被外部改成第三值时，本 turn 退让不再 select（外部选择优先）；
  - 关闭开关 / 解耦时 `select(restoreSelection)` 被调用一次，且用户已手改时不覆盖。
- 回归：断言 `agent/request` 监听器返回的 config 与入参**逐字段相同**（防再次踩 0.2.2 的 throw）；
- 回归：`agent.model.select` 在 `enabled=false` 时**一次都不调用**（纯透传）。

---

## 8. 未决问题（施工前必须实测/确认）

1. **`agent.model` 的可达性**：插件拿到的 `agent` 句柄是否稳定暴露 `model.current()/select()`（0.2.2-rc.1 的 `Agent` 接口）；若宿主降级到 0.2.0/0.2.1，是否要回退到旧的 `agent/request` 路径（双路径 + 版本探测）。
2. **外部选择的归因**：`model/selection` 无 source 字段，如何可靠区分「用户手选」与「本插件选的」（0.1 B 的启发式是否够用）；是否需要把 `restoreSelection` 落到 `state.json` 以便重启后仍能还原。
3. **`select()` 的持久副作用验收**：跨窗口/重启后，会话是否停在最后路由的目标；「恢复原模型」在会话已归档/未挂载时怎么处理。
4. **会话历史读取**：分类是否需要历史？建议不要；若需要，先核 `dsh-session` 投影 API，不要读日志文件。
5. **`usageState` 契约**：是否值得依赖、如何做存在性探测（`typeof ctx.get('usageState')?.getState === 'function'`）与超时；跨版本改名时的降级。
6. **价格数据**：核心无价格目录，成本决策必须靠用户配置的成本等级/单价；是否要在设置页提供「常见模型价格预设」（注意时效性与免责声明）。
7. **每档峰谷表与节假日**：现有 `holidays` 是全局的；改成每档后，旧 `policy.json` 要能迁移（追加字段 + 默认继承全局表）。
8. **合规**：不替用户发 embedding、不把 prompt 发到第三方评分服务；所有分类在本地完成。

---

## 9. 参考链接汇总

- RouteLLM：<https://github.com/lm-sys/RouteLLM>｜<https://arxiv.org/abs/2406.18665>｜<https://www.lmsys.org/blog/2024-07-01-routellm/>
- RouteLLM 源码：<https://github.com/lm-sys/RouteLLM/blob/main/routellm/routers/routers.py>｜<https://github.com/lm-sys/RouteLLM/blob/main/routellm/routers/matrix_factorization/model.py>｜<https://github.com/lm-sys/RouteLLM/blob/main/routellm/calibrate_threshold.py>
- semantic-router：<https://github.com/aurelio-labs/semantic-router>｜<https://docs.aurelio.ai/docs/semantic-router/v0/user-guide/guides/semantic-router>｜<https://docs.aurelio.ai/docs/semantic-router/v0/user-guide/features/threshold-optimization>
- FrugalGPT：<https://arxiv.org/abs/2305.05176>
- NotDiamond `/modelSelect`：<https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post>
- OpenRouter provider routing：<https://openrouter.ai/docs/guides/routing/provider-selection>｜model fallbacks：<https://openrouter.ai/docs/guides/routing/model-fallbacks>
- Martian 文档首页：<https://docs.withmartian.com/>
- 本机 `dsh-usage-state@0.4.17`：`README.md`、`docs/adapters.md`、`lib/index.js`（`usageState` 服务、`snapshots`、`stale`、`suggestSourceId`）
- 本机 DSH 0.14.0 / core 0.2.2-rc.1：`resources/app.asar/node_modules/@deepseek-ai/dsh-agent/README.zh.md`、`dsh-agent/lib/types/model-selection.js`（`AgentModel.select/current`）、`dsh-agent-loop/lib/index.js`（`send()` / `ReactLoopInbox.splice()` / `prepareRequest` 校验）、`dsh-llm/lib/types/index.js`（无通用价格目录）
- 本机实证：`$DSH_HOME/plugins/dsh-peak-valley-router/debug.log`（872 条 `nothing to rewrite`、0 条 override/throw）、同目录 `policy.json` / `state.json`
