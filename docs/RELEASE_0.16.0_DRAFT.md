# 0.16.0 发版草稿（仅草稿，未发版）

> 状态：**暂停发版**。按 Lead 指令：在 t10 分类器硬门禁 FAIL（D1/D2/D3）修复并通过 t15 复验之前，
> **不升版本号、不 commit、不 tag、不安装**。本文件只是把不依赖版本号的产物先写好，供后续发版任务
> 直接采用。当前 `package.json` 仍是 **0.15.0**，README/SKILL 的「当前版本」仍是 v0.15.0，verify 保持绿。
>
> 依据：`docs/VERIFICATION_routing_v2.md` §0/§H（接缝与兼容可放行；智能程度路由仅可在默认关闭下发布，
> 修 D1/D2 前不应默认开启）。

---

## 1. CHANGELOG 条目草稿（待发版时插到 `## [0.15.0]` 之前）

```markdown
## [0.16.0] - 2026-11-19

**智能程度路由（默认关闭）+ 三档峰谷表 + 可见告警 + 跨窗口状态同步**。
0.15 的单策略配置自动迁移为 v2 `targets.low`（只读旧快照保留在 `legacy`）；旧文件无需手工迁移。

- 智能程度路由（默认关闭）：`tierRouting.enabled=false` 时恒用低档，行为与 0.15 一致；开启后按消息的
  具象程度分三档——抽象→高、中等→中、具象执行→低。阈值可编辑（`concreteThreshold` 默认 0.55，
  `mediumThreshold` 默认 0.28），带 10 分钟迟滞与显式 override（safety / low-explicit / high-explicit）；
  空文本/纯图片回退低档。分类器校准门槛本轮未通过（t10 报告 D1/D2/D3），因此本版**默认关闭**，
  修复与复验由 t13/t15 跟踪。
- 成本决策路由（每档独立，默认开）：`targets.<tier>.costRouting` 为 true 时该档峰时窗口使用峰时目标，
  false 时恒用谷时；low/mid/high 默认都开。
- 每档各自的峰谷表：`targets.low` 独立；`targets.mid` / `targets.high` 默认 `{ share: 'low' }` 跟随低档，
  取消跟随后可独立配置谷时模型、峰时开关/星期/窗口/峰时模型。
- 峰谷窗口与节假日可编辑：设置页支持时区偏移、节假日增删（按年分组、内置 2025/2026/2027 整年预设）；
  峰时窗口必须 start < end 且不跨午夜，非法输入就地报错。
- 目标不可路由时可见告警：`get.warnings[]`（红/黄分级、上限 20）与 `recentWarnings[]`（含 cleared 历史，
  上限 50）；不可用目标回退低档并告警，不再静默。v1 多策略迁移产生 `legacy-extra-strategies` 提示。
- 跨窗口 / 多进程状态同步：`state.json` v2 带 `revision`、各键 `*UpdatedAt`、`tombstones`、`applied`、
  `restore`、`restorePending`；锁 + 原子写 + 逐键较新合并。`set` 支持 `expectedRevision` 乐观并发，
  冲突返回 `stale-revision`；设置页 3 秒轮询（页面可见时）。
- 新接缝：路由改写从 `agent/request` 改到 `agent/inbox/inserted` 的 `select`，满足 0.2.2-rc.1
  「step preparation 前固定 selection」的硬校验；`agent/request` 改为只读观测。
- 新增只读 `probe` RPC：按候选文本/配置试算档位与目标，不写 policy/state/debug.log。
- 兼容：`schemaVersion: 1` 的旧策略自动迁移；`advancedSupport` 仍是独立的 max 轴；
  `peerDependencies` 增加 `^0.2.2-rc.1`（已实测 0.2.2-rc.1 真核）。
- 已知边界：
  1. 每条被路由的消息会产生一次 `state.json` 原子写（含 no-op；实测 3 条消息后 revision 1→3、
     文件 30→609 字节）。高频会话需关注写入量，后续可只对变化字段写。
  2. `state.json` 损坏（非法 JSON）时文件逐字节保留、不丢已有数据，但插件按 **fail-closed** 处理：
     开关回默认 false，该回合纯透传、**不路由**——不是「路由仍能工作」。
  3. 冷启动首条消息可能因 provider 目录/effort 未热而 `unverified`（info 告警）不路由；
     `model catalog refreshed (adapters-updated)` 之后恢复。首条消息不保证命中。
- 测试：16 套 node 测试接入 `npm test` / `npm run verify`，新增 config-v2 / migrate-v1 / cost-routing /
  classifier / tier-routing / probe / catalog-warning / state-sync / restore / inbox-routing /
  request-passthrough；`scripts/roundtrip.test.mjs` 被 v2 接缝测试取代并移除。
- 文档：README/SKILL 更新 v2 配置示例与已知限制；新增 `docs/HEADLESS_VERIFY.md`、
  `docs/ROUTING_V2_DESIGN.md`、`docs/VERIFICATION_routing_v2.md`。
```

## 2. README 待改内容

1. 第 7 行「当前版本」：`v0.15.0` → `v0.16.0`（发版时改，现在不动）。
2. 第 9-11 行宿主兼容段：补 **0.2.2-rc.1**（桌面端 0.14.0 内置核心，已实测），说明 peer 范围已显式包含它。
3. 「它做什么」新增一节（建议插在现有多策略描述前）：

```markdown
- **智能程度路由（默认关闭）**：开启后按消息的具象程度分三档——抽象→高档、中等→中档、具象执行→低档。
  默认关闭时恒用低档，行为与 0.15 一致；阈值、迟滞与显式 override 详见 SKILL。分类器校准仍在修
  （见 docs/VERIFICATION_routing_v2.md），因此本版不默认开启。
- **成本决策路由（每档独立，默认开）**：每一档都有自己的峰谷表与 `costRouting` 开关；关闭某档的成本决策，
  该档就恒用谷时目标。低/中/高三档默认都跟随低档配置（`{ share: 'low' }`），可取消跟随改为独立表。
- **峰谷窗口与节假日可编辑**：设置页直接增删峰时窗口和节假日，窗口必须 start < end 且不跨午夜。
- **目标不可路由时可见告警**：不可用目标会回退并显示红/黄告警（`get.warnings`），历史在
  `recentWarnings` 中保留 cleared 记录；不再只在 debug.log 里静默回退。
- **跨窗口/多进程状态同步**：`state.json` v2（revision + 每键时间戳 + tombstones + applied/restore）
  用锁 + 原子写 + 逐键较新合并；设置页可见时 3 秒轮询，多窗口不一致时给「重新加载/用我的覆盖」冲突条。
```

4. 「目录」：`scripts/roundtrip.test.mjs` 一行删除；新增 `lib/routing.js`、`lib/classifier.js`、`lib/state.js`
   以及 0.16 新增测试脚本清单。
5. 「开发」里的 `npm run verify` 说明：把「六套检查」改为「全套测试」，并补 `docs/HEADLESS_VERIFY.md`
   的无 GUI 验证入口。

## 3. SKILL 待改内容

1. 第 8 行「当前版本」：`v0.15.0` → `v0.16.0`（发版时改）。
2. 第 10 行宿主兼容段：补 **0.2.2-rc.1**。
3. 「它能干什么」补三条：智能程度路由（默认关）、每档成本决策、可见告警/跨窗口同步。
4. 配置示例整段替换为 v2（旧 `strategies` 示例删除，并注明 v1 兼容只读迁移）：

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

5. 「路由规则」段补：v1 `strategies` 自动迁移到 `targets.low`，第 2 条及以后不再参与路由并给出
   `legacy-extra-strategies` 提示；默认关闭智能程度路由时行为与 0.15 等价。
6. 新增「已知边界」小节：逐字采用 CHANGELOG 草稿中的 3 条（state 写入量 / 坏 state fail-closed /
   冷启动首条 unverified）。

## 4. `state.json` v2 新字段清单（供发版说明/迁移核对）

| 字段 | 类型 | 语义 |
|---|---|---|
| `schemaVersion` | number | 固定 2；v1 文件（只有 enabled/sessions）按默认读入 |
| `revision` | number | 全局乐观并发版本；每次落盘 `max+1`；`set` 的 `expectedRevision` 与它比较 |
| `updatedAt` | number(ms) | 整个状态最近写入时间 |
| `enabled` / `enabledUpdatedAt` | bool / number | 全局开关及该键的写入时间 |
| `sessions` / `sessionsUpdatedAt` | `{id:bool}` / `{id:ts}` | 每会话覆盖及时间戳 |
| `tombstones` | `{id:ts}` | 已清除的覆盖；防止旧进程快照在合并时复活 |
| `applied` / `appliedUpdatedAt` | `{id:selection\|null}` / `{id:ts}` | 插件实际应用的模型（用于关开关/恢复） |
| `restore` / `restoreUpdatedAt` | `{id:selection}` / `{id:ts}` | 记住的原模型 |
| `restorePending` / `restorePendingUpdatedAt` | `{id:true}` / `{id:ts}` | 无活 agent 时挂起、下次见面还原；清除也按时间戳版本化 |

写入协议：`state.json.lock`（`openSync('wx')`，20ms×25 重试，>5s 陈旧锁清理）→ 重读磁盘 →
逐键按 `*UpdatedAt` 取较新（相等取磁盘）→ 只应用本次变更 → 原子写 → revision+1。
锁超时/读失败/写失败：保留内存变更并返回 `{ok:false,reason}`，绝不把读失败当空表写回。

## 5. 已知边界（发版时必须原样写进 CHANGELOG/README）

1. **每条被路由消息一次 `state.json` 原子写**（含 no-op）：实测 3 条消息后 revision 1→3、文件 30→609B；
   高频会话需关注写入量。
2. **坏 `state.json` 时 fail-closed**：文件逐字节保留、不丢数据，但开关回默认 `false`，该回合不路由；
   不要表述为「路由仍能工作」。
3. **冷启动首条消息可能 `unverified` 不路由**：目录/effort 未热时 info 告警，`adapters-updated` 后恢复；
   首条消息不保证命中。
4. 分类器校准门槛本轮 47 条样例 accuracy 0.809（high 0.950 / mid 0.706 / low 0.700），3 条反档 +
   D2/D3；**在 t13 修复、t15 复验通过前，智能程度路由保持默认关闭且不得改为默认开启**。

## 6. 待发版清单（等 t15 通过后执行）

1. `package.json`：`0.15.0` → `0.16.0`。
2. `CHANGELOG.md`：插入 §1 草稿（日期按发版当日），确认最新 `## [x.y.z]` 与 package.json 一致。
3. `README.md` / `SKILL.md`：按 §2/§3 改「当前版本」与内容；确认 `当前版本` 行均为 v0.16.0。
4. `node src/build-client.mjs` 重建 `lib/client.js`；`node --check` 全部入口。
5. `npm test`、`npm run verify` 全绿；`scripts/t10-*.mjs` 复跑（校准门禁应已由 t13/t15 转绿）。
6. `git add` 明确文件（不要 `git add -A`；`*.tgz` 不入库）；commit；`git tag -a v0.16.0`；**不 push**。
7. 安装桌面端（0.15.0 的合规路径）：`plugin_manager install_bundle` 会因 `already-installed` 被拒，
   按 nextStep `remove_bundle` → `install_bundle` 本地仓库路径；核对 profiles/desktop/package.json、
   `dsh.profile.bundles`、generation、junction；**需用户重启 DSH Desktop** 才会出现 `apply: v0.16.0`。
8. 重启后端到端验收：设置页三档/每档峰谷表可见可配；打开智能程度路由后 `debug.log` 出现
   `inbox: decision … tier=…`；把目标临时改成不存在的 model → `get.warnings` 红/黄横幅可见，验完改回；
   再用 `get` 核对 active 决策与 `version`。
9. 验收报告：安装版本/`apply: v0.16.0`/`get` active/三档 GUI/告警证据；重启前不得宣称运行态生效。

## 7. 当前仓库状态（2026-11-19 00:0x）

- `package.json` 未改（仍 `0.15.0`），README/SKILL 未改（仍 v0.15.0）。
- `git status` 只有实现者的未提交改动与 `docs/`、`dsh-peak-valley-router-0.12.0.tgz`；本文件是新增草稿。
- 未 commit、未 tag、未安装、未推送。
