# CC-HAHA 避峰岗集成

本目录把 CC-HAHA v0.7.8 的原生避峰岗适配作为可审计补丁发布。DSH 插件与
CC-HAHA patch 是两个运行端；CC-HAHA 不使用 DSH 的插件注入机制。

## 覆盖范围

- 服务端：北京时间峰谷窗口、法定节假日、高抽象粘性、每轮 provider/model/effort 路由。
- 桌面端：`设置 → 避峰岗`，provider 与模型联动、策略编辑。
- 手机 `/m`：状态卡和只修改 `enabled` 的总开关。
- 远程访问：仅放行 peak-routing `status` 与 `PATCH enabled`，完整配置仍限本机。
- 并发安全：PATCH 的读取、revision 校验、归一化和写入在同一把写锁内。

## 安装

补丁基线是上游 `v0.7.8`。先在独立源码树验证：

```bash
git checkout v0.7.8
git apply --check integrations/cc-haha/peak-routing-v0.7.8.patch
git apply integrations/cc-haha/peak-routing-v0.7.8.patch
```

运行 CC-HAHA 的目标主机应先在 staging 构建并验证：

```bash
bun test src/shared/peakRouting.test.ts \
  src/server/services/peakRoutingService.test.ts \
  src/server/__tests__/peakRoutingHandler.test.ts \
  src/server/__tests__/peakRoutingApi.test.ts \
  src/server/publicAccess.test.ts
```

生产切换使用 CC-HAHA 的热修复 overlay，并等待 GATE-IDLE。切换后保持
`APP_VERSION=078`；补丁进入下一上游 release 后再走正常升级合并。

## 回滚

停止热修复服务，切回原始 `v0.7.8` 目录并恢复原 systemd 服务。保留
`~/.claude/cc-haha/peak-routing.json` 供审计；停用只需关闭开关或删除配置，
不要删除路由日志和历史补丁包。

## 已知边界

- 路由不处理 provider 429 或配额耗尽；这些状态由控制面和飞书额度上报处理。
- 高抽象判定每轮多一次分类器调用，超时回落到时段路由。
- 法定节假日需按年度更新；周末自动按谷时处理。
- 2027 年节假日若未更新，会被误判为峰时。
