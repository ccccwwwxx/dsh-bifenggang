# 避峰岗（dsh-peak-valley-router）

> 峰时站岗换班：谷时让 DeepSeek 干苦力，峰时换 ChatGPT Plus 顶班，你的 API 账单从此不再被高峰期收割。

DeepSeek Harness 的跨 provider 峰谷路由插件 + 公开 SKILL。详见 [SKILL.md](./SKILL.md)。

## 目录

- `SKILL.md` — 「避峰岗」技能说明
- `lib/index.js` — Node 端：策略引擎 + `agentDefaultModel` 拦截 + RPC
- `lib/client.js` — 客户端：设置页 GUI（策略列表/编辑 + 互斥策略）
- `cordis.patch.yml` — 自激活 patch（bundle 安装用）
- `package.json` — 插件清单（含 `dsh.client` 声明）

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

装完重启 DSH，打开「设置 → 避峰岗」即可在 GUI 里配置多模型协同策略。

## 峰谷规则

- 高峰：北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00
- 谷时：其余时间（含周末、节假日全天），价格为峰时 1/2
