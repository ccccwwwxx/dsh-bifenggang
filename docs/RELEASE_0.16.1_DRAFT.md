# 0.16.1 发版草稿（仅草稿，未发版）

> 状态：**暂停发版**。Lead 指令：t21（core `get.firstRun`）未通过前，不升版本号、不 commit、不 tag、
> 不安装、不 push。当前 `package.json` 仍是 0.16.0，README/SKILL 仍是 v0.16.0，verify 保持绿。
> 本文件只放「不依赖版本号、可直接照抄」的产物；等 t21 通过后的发版任务执行 §6 清单。

---

## 1. CHANGELOG 条目草稿（发版时插到 `## [0.16.0]` 之前）

```markdown
## [0.16.1] - 2026-11-19

**子智能体路由修复 + 节日校验/UTC 钳制 + 首启引导**。

### 修复

- **子智能体路由（本次最实质的行为修复）**：普通 subagent 的用户消息一直按 `user` source 参与路由；
  AgentTeams 成员投递的消息此前用 `agent-teams` source，被 inbox 的「仅 user」筛选跳过，表现为成员会话
  完全不走避峰岗。0.16.1 把 `agent-teams` 纳入用户意图，**成员会话现在也会产生
  `inbox: decision → inbox: select → pre-step match` 并按策略路由**。
  - 用户意图 source：`user`、`agent-teams`。
  - 明确排除的注入类：`system-prompt`、`runtime-context`、`model-selection`、`subagent-settled`、`plugin`。
  - 未知 source：跳过路由，并记一行 `source-kind:<kind>` 限流日志，便于以后扩展。
- **AgentTeams 消息前缀剥离**：分类前去掉首行的 `AgentTeams message from …:` /
  `Agent <id> sent a message:` 投递前缀，避免前缀里的词污染分类特征（只做展示层预处理，阈值/权重未动）。
- **节日日期合法性校验**：`holidays` 中的非法日期（如 2026-02-30、2027-02-29）不再让整份配置报错，
  而是逐条丢弃并计 `dropped`；`get.warnings` 出现 info 级 `invalid-holidays`（`extraCount=N`，同 key 限流），
  保存合法列表后自动清除。合法年份范围 1970–2100，用 `Date.UTC` 回读校验真实日历日。
- **UTC 偏移钳制**：`utcOffsetMinutes` 非数字/缺失回默认 480；其余四舍五入后夹到 `[-720, 840]`。

### 新增

- **设置页首启引导（first-run guide）**：非弹窗、可关闭、不阻塞保存的引导条，说明「默认关闭需手动开启 /
  三档含义与默认共用低档 / 每档峰谷表与节假日在哪里」；首次保存后不再出现。
- `get.firstRun`（布尔）：true = 从未保存过 policy.json；设置页优先读取它，缺失时回退到
  `configRevision <= 1` 推断，并用 `legacy` 排除 v1 老用户（升级用户不会被误判为首次使用）。

### 兼容 / 已知边界

- `schemaVersion` 仍为 2；v1 `strategies` 自动迁移逻辑未变；`peerDependencies` 未变。
- `plugin` source 仍视为「已知非意图」：released-format 宿主上的 AgentTeams 包装消息不会触发路由；
  本次只承诺当前桌面端的 `agent-teams` source。
- `get.firstRun` 依赖 core（t21）；core 未下发时客户端用 revision 兜底，不影响功能。
- 节日校验只校验日期是否为真实日历日，不校验「是否落在已配置的峰时星期」。
```

## 2. README 待改内容

1. 第 7 行「当前版本」：`v0.16.0` → `v0.16.1`（发版时改）。
2. 第 9 行宿主兼容段落：保持 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.2-rc.1 不变；如需补一句「0.16.1 起子智能体
   与 AgentTeams 成员会话同样参与路由」。
3. 「它做什么」新增一节（建议放在每会话状态之后）：

```markdown
- **子智能体与 AgentTeams 成员也受路由**：只要消息 source 是 `user` 或 `agent-teams`，就按用户意图分级/路由；
  `system-prompt`、`runtime-context`、`model-selection`、`subagent-settled`、`plugin` 等注入类消息明确排除。
  未知 source 跳过并记限流日志。AgentTeams 消息首行的投递前缀会被剥离后再分类。
- **首启引导**：第一次打开设置页会显示一条可关闭的引导条（默认关闭、三档含义、峰谷表/节假日在哪），
  保存一次后不再出现。
```

4. 运行时数据/已知限制补：非法节日丢弃不报错并给 `invalid-holidays` info 告警；UTC 偏移夹在
   `[-720, 840]`；`plugin` source 不路由。
5. 目录段补 `scripts/agent-teams-source.test.mjs`；版本相关docs链接补 `docs/RELEASE_0.16.1_CHECKLIST.md`。

## 3. SKILL 待改内容

1. 第 8 行版本：`v0.16.0` → `v0.16.1`（发版时改）。
2. 「它能干什么」补一条：

```markdown
8. **子智能体 / AgentTeams 成员路由**：`user` 与 `agent-teams` source 都按用户意图分级/路由；
   `system-prompt`/`runtime-context`/`model-selection`/`subagent-settled`/`plugin` 等注入类排除。
   AgentTeams 消息的投递前缀会先剥离再分类。
```

3. 配置示例不必改（schema 未变）；「已知边界」补：

```markdown
6. 非法节日日期会被丢弃（不报错）并给 info `invalid-holidays` 告警；UTC 偏移四舍五入后夹在 [-720, 840]。
7. `plugin` source 视为已知非意图，旧宿主上的 AgentTeams 包装消息不触发路由；当前桌面端的 `agent-teams` 正常。
8. 首启引导在第一次打开设置页时显示，保存一次后消失；`get.firstRun` 未下发时按 revision 兜底。
```

## 4. `market/index.json` 条目草稿（放在 `versions` 数组最前）

```json
{
  "version": "0.16.1",
  "publishTimestamp": <UNIX_SECONDS>,
  "source": {
    "type": "git",
    "url": "https://github.com/ccccwwwxx/dsh-bifenggang",
    "commit": "<RELEASE_COMMIT_SHA>"
  },
  "engines": {
    "dsh": ">=0.12.0"
  }
}
```

填写方式（与 0.16.0 的 `chore(market)` 一致）：
1. 先做 release commit（版本/CHANGELOG/README/SKILL/client 重建），不带 market 条目；
2. 取该 release commit 的完整 SHA 填入上面的 `commit`，`publishTimestamp` 用发版时刻的
   `DateTimeOffset.UtcNow.ToUnixTimeSeconds()`；
3. 单独 `chore(market): publish 0.16.1 pinned to <short>` 提交（不要 amend release commit，保持 tag 指向
   release commit 与 0.16.0 的做法一致）；
4. push master 与 tag。

## 5. 发版前必须确认（t21 门禁）

- t21 已让 `get` 返回布尔 `firstRun`（true = 从未保存 policy.json）；`npm test` / `verify` 全绿。
- 首启引导在真实设置页显示一次、保存后消失（或保留为重启后逐条验收项）。
- `scripts/agent-teams-source.test.mjs` 7 条在 `npm test` 中通过。
- 无未解决的红色测试；`node scripts/verify.mjs` 版本一致性/产物新鲜度全绿。

## 6. 待发版清单（t21 通过后执行）

1. `package.json`：0.16.0 → **0.16.1**。
2. `CHANGELOG.md`：插入 §1 草稿；确认最新 `## [x.y.z]` 与 package.json 一致。
3. `README.md` / `SKILL.md`：按 §2/§3 更新版本行与内容。
4. 新增 `docs/RELEASE_0.16.1_CHECKLIST.md`（含：设置页版本 / 首启引导保存后消失 / 非法节日被拒并提示 /
   UTC 越界被夹住 / **AgentTeams 成员会话日志出现 `inbox: decision`**）。
5. `node src/build-client.mjs` 重建 `lib/client.js`；`npm test` 17/17；`node scripts/verify.mjs` 全绿。
6. release commit（信息写清子智能体路由修复与三项补齐），annotated tag **v0.16.1**。
7. `chore(market): publish 0.16.1 pinned to <release sha>` 提交（§4）。
8. `git fetch` 确认远端无新提交后 push master 与 tag；若远端有新提交，先停下报告，不强推。
9. 桌面端 remove_bundle → install_bundle，核对 dependency=0.16.1、generation 0.16.1；不重启，注明需冷启动。
10. 输出验收报告含：提交 SHA、tag、测试/verify 结果、桌面端 generation、运行态需重启说明。

## 7. 当前仓库状态（2026-11-19 06:4x）

- HEAD `14a2f43`（0.16.0 + market chore），`package.json` 0.16.0，README/SKILL v0.16.0。
- 工作区：t17/t18/t19 的 10 个已跟踪文件改动 + `scripts/agent-teams-source.test.mjs` 未跟踪；
  本文件为新增草稿。**未升版本、未 commit、未 tag、未安装、未 push。**
