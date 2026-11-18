# Headless CLI 验证通道（dsh 0.2.2-rc.1，不重启桌面端）

给 t10（实现验证）与 t11（独立验收）用的**无 GUI**通道：用 npm 上的 `@deepseek-ai/dsh@0.2.2-rc.1`（= 桌面端内置核心版本）在**隔离的 DSH_HOME** 里启动 headless profile，用 `--patch` 挂工作区里的插件源码，路由决策写到隔离目录的 `debug.log`。**不碰 desktop profile，不重启当前 DSH 会话。**

## 0. 结论先行（本次实测，2026-11-18）

- CLI 可用：`0.2.2-rc.1`（`npx --yes @deepseek-ai/dsh@0.2.2-rc.1 --version` → `0.2.2-rc.1`，退出码 0）。
- 独立 profile + `--patch` 可加载工作区插件：`--dump-config` 中出现 `id: dsh-peak-valley-router`；实际启动日志出现
  `apply: v0.15.0, enabled=…, 1 strategies, advancedSupport -> deepseek-official/deepseek-flash`。
- **路由改写目前会被 0.2.2-rc.1 的 agent-loop 硬校验拒绝**（这正是 t10 要修的 bug）：
  `dsh: UNKNOWN: agent "…": agent/request proposed reasoning effort "low" after step preparation fixed "adapter default"; use agent.model.select() before step preparation`
- 本机**没有**可用的 `DEEPSEEK_API_KEY`（桌面凭据文件里没有 DeepSeek key，只有浏览器会话/其它服务的 refs）。因此真实回合目前以 `MISSING_CREDENTIAL` 退出码 1 结束；这是预期内的「没有 key」失败，不是通道不可用。有 key 时把 key 放进环境变量即可（见 §5），但**修好路由改写前，enabled=true 的回合仍会因上面的硬校验退出 1**。

## 1. 固定版本与 Node（必须）

桌面端是 DSH desktop 0.14.0，内置核心 `0.2.2-rc.1`。**不要用 `next` / rc.5**。

CLI 要求 Node `>=24.9.0`。本机 `C:\Program Files\nodejs` 的 Node 是 20.x，直接跑 `npx` 会出
`npm warn EBADENGINE … current: { node: 'v20.20.2' }`；必须用 Harness 自带的 Node 24 跑 npm 的 npx：

```powershell
$Node = "C:\Users\29805\AppData\Roaming\dsh-desktop\harness\.desktop-bin\node.cmd"
& $Node --version    # v24.21.0

# 首次会下载（已缓存则秒回）；记录实际版本
& $Node "C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js" --yes @deepseek-ai/dsh@0.2.2-rc.1 --version
# 期望输出：0.2.2-rc.1
```

已下载的缓存（可直接调用，hash 目录可能随缓存清理变化）：

```
%LOCALAPPDATA%\npm-cache\_npx\72500ffcd8799faa\node_modules\@deepseek-ai\dsh\lib\bin.js
```

兜底（npx 网络/权限失败时）：把 asar 里的 `@deepseek-ai/dsh` 解出来跑，或直接用上面的缓存 bin：

```powershell
$Dsh = "$env:LOCALAPPDATA\npm-cache\_npx\72500ffcd8799faa\node_modules\@deepseek-ai\dsh\lib\bin.js"
& $Node $Dsh --version    # 0.2.2-rc.1
```

## 2. 隔离目录（唯一允许写的地方）

| 用途 | 路径 |
|---|---|
| 隔离 DSH_HOME | `%LOCALAPPDATA%\dsh-bifenggang-headless-home` |
| profile（首次运行自动从 shipped 模板创建） | `…\profiles\headless` |
| **插件数据**（唯一的 debug.log / state.json / policy.json） | `…\plugins\dsh-peak-valley-router` |
| 额外 patch | `…\peak-valley-router.patch.yml` |
| npx 缓存（只读） | `%LOCALAPPDATA%\npm-cache\_npx\…` |
| **禁止写**（桌面端） | `C:\Users\29805\AppData\Roaming\dsh-desktop\harness`（除 `harness\plugins` 是桌面正在用的插件数据目录，别碰） |

原则：**每条命令都临时把 `DSH_HOME` 指到隔离目录**，不要改系统/用户环境变量，不要改 desktop profile 的 `package.json` / `cordis.patch.yml`。

## 3. 首次准备：profile + patch + 配置可见性

```powershell
$Node   = "C:\Users\29805\AppData\Roaming\dsh-desktop\harness\.desktop-bin\node.cmd"
$Dsh    = "$env:LOCALAPPDATA\npm-cache\_npx\72500ffcd8799faa\node_modules\@deepseek-ai\dsh\lib\bin.js"
$IsoHome = "$env:LOCALAPPDATA\dsh-bifenggang-headless-home"
$Repo    = "C:\Users\29805\Documents\deepseek-harness\default-workspace\dsh-bifenggang"
New-Item -ItemType Directory -Force -Path $IsoHome | Out-Null

# 额外 patch 层：把工作区插件以 file:// URL 挂进 headless profile
$Url   = 'file:///' + ($Repo -replace '\\','/') + '/lib/index.js'
$patch = Join-Path $IsoHome 'peak-valley-router.patch.yml'
$yaml  = @"
- insert:
    - id: dsh-peak-valley-router
      name: '$Url'
"@
[System.IO.File]::WriteAllText($patch, $yaml)

$env:DSH_HOME = $IsoHome
& $Node $Dsh --profile headless --patch $patch --dump-config > "$IsoHome\dump-config.txt"
echo "EXIT=$LASTEXITCODE"    # 期望 0
Select-String -Path "$IsoHome\dump-config.txt" -Pattern 'dsh-peak-valley-router','lib/index.js'
# 应看到：
# - id: dsh-peak-valley-router
#   name: file:///C:/Users/.../dsh-bifenggang/lib/index.js
```

不加 `--patch` 时 `id: dsh-peak-valley-router` 不应出现；这能证明 patch 真的被叠加上去了。
profile 首次运行会自动创建 `profiles\headless`（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`），不需要手工装依赖；profile 模板损坏时可加 `--from-default-profile headless` 重建。

## 4. 启用路由（关键：JSON 不能带 BOM）

插件默认是「关闭 = 纯透传」。headless 没有 GUI，直接写状态文件；**必须无 BOM**，否则插件 `JSON.parse` 失败并静默退回关闭（这是本仓库 0.13 已经踩过的坑）：

```powershell
$IsoHome = "$env:LOCALAPPDATA\dsh-bifenggang-headless-home"
$pd = Join-Path $IsoHome 'plugins\dsh-peak-valley-router'
New-Item -ItemType Directory -Force -Path $pd | Out-Null
[System.IO.File]::WriteAllText((Join-Path $pd 'state.json'), '{"enabled":true,"sessions":{}}')
```

不写 `policy.json` 时使用 `lib/text.js` 的 `DEFAULTS`（0.15.0：全周 `deepseek-official/deepseek-flash`@low、`peak.enabled=false`、`advancedSupport` = flash@max）。要验证自定义策略（t10 的三档/峰谷表），写同样**无 BOM** 的 `policy.json`，例如：

```powershell
$policy = @'
{
  "utcOffsetMinutes": 480,
  "holidays": [],
  "strategies": [
    {
      "name": "probe",
      "weekdays": [1,2,3,4,5,6,7],
      "primary": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low" },
      "peak": { "enabled": false, "windows": [], "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low" }
    }
  ],
  "advancedSupport": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "max" }
}
'@
[System.IO.File]::WriteAllText((Join-Path $pd 'policy.json'), $policy)
```

## 5. 跑最小回合

```powershell
$Node   = "C:\Users\29805\AppData\Roaming\dsh-desktop\harness\.desktop-bin\node.cmd"
$IsoHome = "$env:LOCALAPPDATA\dsh-bifenggang-headless-home"
$Dsh    = "$env:LOCALAPPDATA\npm-cache\_npx\72500ffcd8799faa\node_modules\@deepseek-ai\dsh\lib\bin.js"
$patch  = Join-Path $IsoHome 'peak-valley-router.patch.yml'
$env:DSH_HOME = $IsoHome

# 有 key 时（不要把 key 写进文件/仓库）；没有 key 就跳过这行，按下面「预期失败」记录
$env:DEEPSEEK_API_KEY = '<real key>'

& $Node $Dsh --profile headless --patch $patch "只说 ok" > "$IsoHome\turn.out" 2> "$IsoHome\turn.err"
echo "EXIT=$LASTEXITCODE"
Get-Content "$IsoHome\turn.err" -Tail 20
```

- **没有 key（本机现状）**：`EXIT=1`，stderr 含
  `dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; …`。
  这是 key 缺失，不是通道失败；`--dump-config` 与插件 apply 日志仍然正常。
- **用假 key 探针**（`DEEPSEEK_API_KEY=sk-…invalid`）：回合仍会失败，但在失败前能在 `debug.log` 看到路由决策。注意：**不要把这个回合当成功**，它只用于验证 selection/日志通路。
- **enabled=true + 0.2.2-rc.1 的已知阻断**（本次实测）：
  ```
  [dsh-peak-valley-router] agent/request: overriding -> deepseek-official/deepseek-flash@low (session … model was deepseek-official/deepseek-flash; via primary)
  dsh: UNKNOWN: agent "…": agent/request proposed reasoning effort "low" after step preparation fixed "adapter default";
       use agent.model.select() before step preparation
  ```
  退出码 1。这是 t10 要修的行为；在修好之前，**即使有真 key，enabled=true 的回合也无法以 0 退出**。
- **期望的通过形态**（修好后）：`EXIT=0`，stdout 是 JSON 数组（如 `[]` 或含 assistant 消息），stderr 无 `UNKNOWN`；`debug.log` 里有 `apply: v0.15.0` 和 `agent/request` 决策行。

> 想把「通道本身」验到退出码 0 而不依赖路由改写：把 §4 的 `state.json` 写成 `{"enabled":false,"sessions":{}}`，并提供一个真实可用的 `DEEPSEEK_API_KEY`；此时插件纯透传，回合应正常完成。

## 6. 怎么看路由是否生效、看哪份日志

唯一日志：`%LOCALAPPDATA%\dsh-bifenggang-headless-home\plugins\dsh-peak-valley-router\debug.log`

```powershell
Get-Content "$env:LOCALAPPDATA\dsh-bifenggang-headless-home\plugins\dsh-peak-valley-router\debug.log" -Tail 40
```

关键行：

| 行 | 含义 |
|---|---|
| `apply: v0.15.0, enabled=true, N strategies, advancedSupport -> provider/model, llm -> true` | 实际加载的插件版本/开关/默认策略数。**版本以这行为准**，不是 package.json |
| `agent/request: overriding -> provider/model@effort (session … model was …; via primary\|peak\|fallback-first-primary)` | 插件真的改写了目标，并给出原因分支 |
| `agent/request: routed -> … (… already resolved to it; nothing to rewrite; via …)` | 目标等于会话已选模型，纯 no-op |
| `model catalog refreshed (…)` | provider 目录刷新，与路由正确性无关 |

headless 里**没有 `get` RPC**（没有 HTTP connection），所以 active 决策只能从 `debug.log`（或带假 key 的探针回合）里看；`get` RPC/版本展示只存在于 desktop/web。

## 7. 验收清单（t11 可直接照抄）

1. `--version` 输出 `0.2.2-rc.1`，退出码 0。
2. `--dump-config` 退出码 0，输出含 `id: dsh-peak-valley-router` 且 `name` 指向工作区 `lib/index.js`。
3. 一次 boot（任何回合/`--dump-config` 外）后，隔离 `debug.log` 出现 `apply: v0.15.0`。
4. 写 enabled=true 的 `state.json`（无 BOM）后跑回合：`debug.log` 出现预期的 `agent/request: overriding/routed` 行；修好后不再出现 `UNKNOWN … after step preparation fixed`。
5. 全程 `C:\Users\29805\AppData\Roaming\dsh-desktop\harness\plugins\dsh-peak-valley-router\debug.log` 的 mtime/内容不被本通道修改（隔离 home 的日志时间戳应是唯一新增）。
6. 不重启桌面端、不改 desktop profile、不 push。

## 8. 清理 / 重来

```powershell
# 只删隔离目录；桌面端不受影响
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\dsh-bifenggang-headless-home"
# 重新按 §3/§4 准备即可
```

## 9. 本次实测证据（2026-11-18）

- `& $Node "C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js" --yes @deepseek-ai/dsh@0.2.2-rc.1 --version` → `0.2.2-rc.1`，EXIT=0。
- `--dump-config`（隔离 home）EXIT=0，`dump-config.txt` line 392-395：
  ```
  # == …\peak-valley-router.patch.yml
  - id: dsh-peak-valley-router
    name: >-
      file:///C:/Users/29805/Documents/deepseek-harness/default-workspace/dsh-bifenggang/lib/index.js
  ```
- 隔离 `debug.log` line 9：`2026-11-18T14:28:13.845Z apply: v0.15.0, enabled=true, 1 strategies, advancedSupport -> deepseek-official/deepseek-flash, llm -> true`。
- 真实回合（无 key）：EXIT=1，`dsh: MISSING_CREDENTIAL: llm-deepseek: no API key …`。
- 假 key 探针（enabled=true）：EXIT=1，先出现
  `agent/request: overriding -> deepseek-official/deepseek-flash@low (… model was deepseek-official/deepseek-flash; via primary)`，
  随后 `dsh: UNKNOWN: … proposed reasoning effort "low" after step preparation fixed "adapter default"`。
- 桌面端日志未被写：`C:\Users\29805\AppData\Roaming\dsh-desktop\harness\plugins\dsh-peak-valley-router\debug.log` 中没有本通道的 `apply: v0.15.0`（它的 apply 仍是 v0.12.0，等桌面端重启），也没有 14:27/14:28 的隔离回合行。
