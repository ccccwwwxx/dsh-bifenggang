# 0.16.1 冷启动后验收清单

> 0.16.1 已安装到桌面端 profile，但运行中的 DSH Desktop 仍是旧版；请**冷启动 DSH Desktop**（不是重启当前会话）后逐条核对。
> 每项都写「怎么看 / 期望什么 / 不通过时贴什么」。不方便看 GUI 的项，给 `debug.log` 判断方法。
> 日志路径：`C:\Users\29805\AppData\Roaming\dsh-desktop\harness\plugins\dsh-peak-valley-router\debug.log`
> 配置/状态：同目录 `policy.json` / `state.json`。

## 0. 先确认版本真的加载了

- **怎么看**：设置 → 避峰岗标题下方版本；或 `debug.log` 最新 `apply:` 行。
- **期望**：`版本 v0.16.1`；`debug.log` 出现 `apply: v0.16.1, enabled=…, tierRouting=off, …`。
- **不通过贴**：最新 `apply:` 整行 + 设置页版本截图。若仍是 v0.16.0/v0.12.0，先回报，不要继续。

## 1. 设置页版本 + 首启引导出现、保存一次后消失

- **怎么看**：打开「设置 → 避峰岗」。
  - 若是**从未保存过**的设置页（`policy.json` 不存在或刚被移除），标题/版本行之后应出现一条
    `data-first-run="true"`、`role=note` 的引导条（可关闭、不阻塞保存，4 条要点：默认关闭需手动开启 /
    三档含义与默认共用低档 / 每档峰谷表 / 全局峰谷与节假日）。
  - 点「知道了」应只关闭本次；**保存一次配置**后，再打开/等 3 秒轮询，引导条应不再出现。
- **期望**：首启可见 → 保存成功后消失（`get.firstRun` 变 false）。
- **不通过贴**：引导条截图 + 保存前后的 `debug.log` `set:` 行；`state.json`/`policy.json` 是否存在的说明。
- 备注：判断「首次」的权威字段是 `get.firstRun`（启动时无 policy.json=true；本进程保存成功后=false；
  v1 迁移文件存在=false）。外部进程启动后才创建 policy.json 时，保存前可能仍显示引导——这是已知边界。

## 2. 非法节日被丢弃并出现 info 告警

- **怎么看**：在节假日编辑器里加入一个非法日期（例如 `2026-02-30` 或 `2027-02-29`），保存；
  或直接编辑 `policy.json` 的 `holidays` 加入 `[2026,2,30]`（等 1 秒轮询/重启插件）。再看设置页告警横幅与 `debug.log`。
- **期望**：非法日期不会让保存/配置报错；该条被丢弃，其余合法节日保留；设置页出现 **info 级**
  `invalid-holidays` 告警（`extraCount` = 丢弃条数）；保存一组合法日期后告警自动清除
  （`recentWarnings` 里能看到 cleared）。
- **不通过贴**：告警横幅截图 + `debug.log` 的 `warning: invalid-holidays …` 行；`policy.json` 的 `holidays` 当前值。
- 备注：合法年份范围 **1970–2100**（2000 年以前的合法日期现在会通过，这是行为变更）。

## 3. UTC 偏移越界被夹到 840

- **怎么看**：在设置页把时区偏移填 `9999` 并保存（或直接写 `policy.json` 的 `utcOffsetMinutes: 9999`），
  然后重新读取/`get`。
- **期望**：保存后实际值为 **840**（不是 9999，也不报错）；负数方向同理夹到 -720。GUI 重新打开应显示 840。
- **不通过贴**：保存后的 `policy.json` 中 `utcOffsetMinutes` 实际值 + `debug.log` 的 `set:` 行。

## 4. ★ 让一个 teammate 干活，`debug.log` 出现它会话的 `inbox: decision`

> 这是 0.16.1 最实质的行为变化：AgentTeams 成员的 `agent-teams` source 以前被跳过，现在参与路由。

- **怎么看**：确保避峰岗开关处于开启状态（设置页/侧边栏开关为「已启用」）；在团队里给任意 teammate
  发一条任务消息（普通任务即可，最好包含明确执行动作，如「跑一下 npm test 并汇报」）。
  然后看 `debug.log`。
- **期望**：出现该成员**会话 id** 的 `inbox: decision … tier=… target=… axis=…`，随后
  `inbox: select -> …`、`pre-step: … match=true`；不再出现旧版那种「成员会话完全没有 decision 行」。
  - 若目标恰好等于成员会话已选模型，decision 后可能是 no-op，但仍应有 `inbox: decision` 行（本项只要求这一行）。
  - 负控：`system-prompt` / `runtime-context` 等注入消息不应产生 decision（可顺带确认）。
- **不通过贴**：`debug.log` 中该成员会话相关的连续 5-10 行（含 `inbox:` / `pre-step:` / `request:`，带时间戳）；
  若完全没有 `inbox: decision`，同时贴出成员会话 id 与消息时间，便于核对 source.kind。
- 备注：旧宿主上 AgentTeams 用 `plugin` source 包装的消息仍不路由（已知边界）；当前桌面端应表现为 `agent-teams`。

---

## 附：出问题时最少带三样

1. `debug.log` 最后 50 行（含 `apply: v0.16.1` 行）。
2. `policy.json` + `state.json`（可脱敏，保留结构）。
3. 设置页截图 + 具体操作步骤（点了什么、输入了什么、期望什么）。
