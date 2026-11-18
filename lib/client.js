window.__ModuleLoader__.load({ id: "dsh-peak-valley-router", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require("react");
const { useState, useEffect, useCallback, useMemo, useRef } = require("react");

// ---- locales: 由 lib/text.js 注入（单一维护文件，勿手工复制） ----
const zh = {
  "nav": "避峰岗",
  "title": "模型协同策略（避峰岗）",
  "subtitle": "按请求类型与峰谷时段自动选择模型：抽象请求走高、具象执行走低，峰时按各档峰谷表切换。",
  "loading": "加载中…",
  "pickProvider": "选择 Provider（API / 订阅）",
  "pickModel": "选择模型",
  "effortDefault": "默认思考档",
  "toggleLabel": "启用避峰岗",
  "toggleHint": "开启后由避峰岗自动路由；会话模型选择器失效。",
  "toggleOn": "已启用",
  "toggleOff": "未启用",
  "weekdays": "生效星期",
  "enablePeak": "启用峰时",
  "peakModel": "峰时模型",
  "advancedTitle": "高级模型支援（max）",
  "advancedHint": "仅在会话要求 max 思考时使用，不作为普通兜底。",
  "remove": "删除",
  "on": "开",
  "off": "关",
  "save": "保存",
  "saving": "保存中…",
  "retry": "重试",
  "loadFailed": "加载配置失败",
  "catalogUnavailable": "Provider / 模型目录暂时不可用，下拉可能为空，仍可保存。",
  "refreshModels": "刷新模型列表",
  "refreshingModels": "正在刷新模型列表…",
  "modelsLoading": "模型加载中…",
  "modelsLoadFailed": "模型列表加载失败",
  "pickProviderFirst": "请先选择 Provider",
  "noModels": "该 Provider 暂无可用模型",
  "saved": "已保存 {time}",
  "saveToast": "保存成功 · {time}",
  "saveFailed": "保存失败：{detail}",
  "errStrategy": "第 {index} 条策略：{issue}",
  "errNeedBoth": "缺少主模型的 Provider 和模型",
  "errNeedModel": "缺少主模型",
  "errNeedProvider": "缺少主模型的 Provider",
  "errBadStrategy": "不是合法的策略对象",
  "errBadPrimary": "主模型不合法",
  "errAdvancedSupport": "设置了策略后必须填写「高级模型支援」",
  "errSeparator": "；",
  "errMore": "（另有 {count} 条同类问题）",
  "errTargetIncomplete": "{tier}：缺少谷时模型的 Provider 和模型",
  "errThresholdOrder": "具象阈值必须大于中等阈值",
  "errThresholdRange": "阈值必须在 0 到 1 之间",
  "weekdayShort": "一,二,三,四,五,六,日",
  "strategyLabel": "策略 {index}",
  "effortLow": "低",
  "effortMedium": "中",
  "effortHigh": "高",
  "effortXhigh": "极高",
  "effortMax": "最高",
  "windowStart": "开始时间",
  "windowEnd": "结束时间",
  "versionLabel": "版本",
  "sessionLightTitle": "本会话已启用避峰岗",
  "sessionToggleHint": "只对这个会话生效；右键可恢复为跟随全局默认。",
  "sessionToggleOn": "本会话已启用",
  "sessionToggleOff": "本会话未启用",
  "decoupleLabel": "解耦",
  "decoupledLabel": "已解耦",
  "decoupleHintCoupled": "本会话跟随全局开关；点一下让它独立（之后全局切换不再影响本会话）。",
  "decoupleHintDecoupled": "本会话已独立于全局开关；点一下恢复跟随全局。",
  "decoupledCount": "· {count} 个已解耦",
  "sessionLightTitleDecoupled": "本会话已启用避峰岗（已解耦，不跟随全局）",
  "activeNowLabel": "此刻生效：",
  "reasonNone": "无可用目标",
  "advancedForMax": "；会话要求 max 思考时→{model}",
  "tierRoutingTitle": "智能程度路由",
  "tierRoutingHint": "开启后按消息的具象程度分三档：抽象→高档、中等→中档、具象执行→低档。默认关闭；关闭时恒用低档。",
  "tierThresholdConcrete": "具象阈值（≥ 此值走低档）",
  "tierThresholdMedium": "中等阈值（≥ 此值走中档）",
  "tierThresholdHint": "两个阈值都在 0–1 之间，且具象阈值必须大于中等阈值。",
  "tierProbeTitle": "样例试算",
  "tierProbePlaceholder": "粘贴一段 prompt 试算档位",
  "tierProbeRun": "试算",
  "tierProbeResult": "分数 {score} · 档位 {tier} · 目标 {model}",
  "tierProbeFeatures": "命中特征",
  "tierProbeUnavailable": "当前核心未提供试算接口（需要 0.16.0 引擎）",
  "tierProbeFailed": "试算失败：{detail}",
  "tierFallbackLow": "无文本/无法分级，已回退低档",
  "targetsTitle": "三档模型",
  "tierLow": "低档（具象执行）",
  "tierMid": "中档（中等）",
  "tierHigh": "高档（抽象）",
  "shareLow": "跟随低档配置",
  "shareLowHint": "默认与低档共用同一张峰谷表；取消勾选后独立配置。",
  "shareLowInherited": "继承自低档（只读）",
  "valleyModel": "谷时模型",
  "costRoutingLabel": "成本决策（峰时切到峰时模型）",
  "costRoutingHint": "关闭后该档永远使用谷时模型，峰时窗口保留但不生效。",
  "peakWindowsTitle": "峰时窗口",
  "peakWindowStart": "开始",
  "peakWindowEnd": "结束",
  "peakWindowAdd": "+ 添加窗口",
  "peakWindowsEmpty": "未设置窗口：即使启用峰时，该档也不会切到峰时模型。",
  "peakWindowInvalid": "窗口必须同日且结束晚于开始（暂不支持跨午夜）",
  "peakEnabledOn": "已启用峰时",
  "peakEnabledOff": "未启用峰时",
  "holidaysTitle": "法定节假日",
  "holidaysHint": "节假日全天走谷时。",
  "holidayAdd": "+ 添加日期",
  "holidayInvalid": "日期必须是 2000–2100 年之间的合法日期",
  "holidayEmpty": "未配置节假日",
  "holidayPresetLabel": "内置预设",
  "holidayPresetAdd": "导入 {year} 年",
  "holidayPresetMissing": "没有 {year} 年的内置预设，请手动添加日期",
  "utcOffsetLabel": "时区偏移（分钟）",
  "utcOffsetHint": "只影响峰谷时间的解释，不改系统时区。",
  "warningTitle": "路由告警",
  "warningUnroutable": "目标不可路由：{target}（{kind}）→ 已保持 {kept}",
  "warningUnverified": "模型目录尚未就绪，本次暂不切换：{target}",
  "warningLlmUnavailable": "模型服务不可用，本次暂不切换",
  "warningHostUnsupported": "当前核心不支持会话内路由（需要 0.2.2-rc.1 及以上）",
  "warningCleared": "已恢复：{target}",
  "warningNone": "没有路由告警",
  "warningRecent": "最近告警",
  "warningGeneric": "路由告警：{kind} · {target}",
  "warningMore": "另有 {count} 条",
  "warnKindProvider": "Provider 未注册",
  "warnKindModel": "模型不在目录",
  "warnKindEffort": "思考档不可用",
  "warnKindMissing": "目标缺失",
  "warnKindUnverified": "目录未就绪",
  "warnKindLlmUnavailable": "模型服务不可用",
  "warnKindSelectFailed": "切换失败",
  "warnKindNoCurrent": "读不到当前模型",
  "warnKindHostUnsupported": "核心不支持",
  "warnKindRequestFailed": "请求失败",
  "warnKindSyncReadFailed": "配置读取失败",
  "warnKindStateWriteFailed": "状态写入失败",
  "warnKindDefaultSeamMissing": "默认模型接缝缺失",
  "warnKindLegacyExtra": "旧策略不再生效",
  "warnKindInvalidHolidays": "节假日日期非法",
  "warningLegacyExtra": "旧策略：自第 2 条起共 {count} 条不再参与路由（已保留只读快照）；请把需要的旧策略改配到三档模型。",
  "warningInvalidHolidays": "节假日列表里有非法日期已被忽略，请检查后重新保存。",
  "warnKindOther": "未知问题",
  "tierReasonDisabled": "智能程度路由已关闭（恒低档）",
  "tierReasonLow": "具象执行",
  "tierReasonMid": "中等抽象",
  "tierReasonHigh": "抽象",
  "tierReasonOverrideSafety": "高风险操作（安全 override）→ 高档",
  "tierReasonOverrideHigh": "用户要求深入思考 → 高档",
  "tierReasonOverrideLow": "用户要求直接执行 → 低档",
  "tierReasonFallbackLow": "无法分级，已回退低档",
  "tierReasonMax": "会话要求 max 思考 → 高级模型",
  "outcomeSelected": "已切换",
  "outcomeNoop": "无需切换",
  "outcomeUnroutable": "不可路由",
  "outcomeSelectFailed": "切换失败",
  "outcomeDisabled": "未启用",
  "fallbackLow": "主目标不可用，已回退低档谷时模型",
  "recentDecisions": "最近决策",
  "decisionApplied": "已切换",
  "decisionNoop": "已是最优",
  "decisionUnroutable": "不可路由",
  "restoreTitle": "恢复原模型",
  "restoreHint": "关闭开关或点这里，把会话恢复成插件介入前的模型。",
  "restoreOne": "恢复",
  "restoreAll": "全部恢复",
  "restoreMissing": "没有可恢复的会话",
  "hostBadgeOk": "当前核心支持会话内路由",
  "hostBadgeOld": "当前核心过旧，路由不会生效",
  "conflictTitle": "配置已在其它窗口更新",
  "conflictExternalHint": "另一个窗口修改了配置；你的草稿未被覆盖。",
  "firstRunTitle": "首次使用引导",
  "firstRunPoint1": "避峰岗默认关闭：先用侧边栏或输入区的开关手动开启，开启后才会自动选择模型。",
  "firstRunPoint2": "三档模型：抽象请求→高档，中等→中档，具象执行→低档；默认三档共用低档配置，需要时再单独设置。",
  "firstRunPoint3": "每档的峰谷表在下方「三档模型」卡片里：谷时模型、成本决策开关、峰时星期/窗口与峰时模型；全局峰谷与节假日在「法定节假日」区块。",
  "firstRunPoint4": "第一次保存后这条引导不会再出现；保存前可随时点右侧关闭。",
  "firstRunDismiss": "知道了",
  "conflictReload": "重新加载",
  "conflictOverwrite": "用我的覆盖",
  "reloadConfig": "重新加载配置",
  "costReasonPeak": "峰时方案",
  "costReasonValley": "谷时方案",
  "costReasonCostOff": "该档已关闭成本决策",
  "costReasonPeakDisabled": "该档未启用峰时",
  "costReasonWeekday": "不在峰时星期",
  "costReasonHoliday": "法定节假日",
  "costReasonOutside": "不在峰时窗口",
  "axisMax": "会话要求 max 思考",
  "featureCode": "代码块",
  "featurePath": "文件路径",
  "featureCommand": "命令",
  "featureSymbol": "符号 / 报错",
  "featureVerb": "执行动词",
  "featureMulti": "多个子问题",
  "featureAbstract": "抽象表述",
  "featureLong": "长文本",
  "featureShort": "极短文本",
  "featureShortCommand": "短命令（直接执行）",
  "featureImage": "含图片",
  "featureMidTurn": "对话中途",
  "featureOverrideSafety": "安全 override",
  "featureOverrideHigh": "要求深入思考",
  "featureOverrideLow": "要求直接执行",
  "featureTarget": "具体对象",
  "featureSequence": "多步执行"
}
const en = {
  "nav": "Peak Routing",
  "title": "Model Routing Policy (Peak Avoidance)",
  "subtitle": "Type- and time-aware routing: abstract requests go up, concrete execution goes down, and each tier has its own peak table.",
  "loading": "Loading…",
  "pickProvider": "Pick provider (API / subscription)",
  "pickModel": "Pick model",
  "effortDefault": "Default effort",
  "toggleLabel": "Enable peak routing",
  "toggleHint": "When on, peak routing decides the model and the session model picker is ignored.",
  "toggleOn": "On",
  "toggleOff": "Off",
  "weekdays": "Active weekdays",
  "enablePeak": "Enable peak hours",
  "peakModel": "Peak model",
  "advancedTitle": "Advanced model support (max)",
  "advancedHint": "Used only when a session asks for max thinking; it is not a general fallback.",
  "remove": "Remove",
  "on": "on",
  "off": "off",
  "save": "Save",
  "saving": "Saving…",
  "retry": "Retry",
  "loadFailed": "Failed to load configuration",
  "catalogUnavailable": "Provider/model catalog is temporarily unavailable; dropdowns may be empty. You can still save.",
  "refreshModels": "Refresh model list",
  "refreshingModels": "Refreshing model list…",
  "modelsLoading": "Loading models…",
  "modelsLoadFailed": "Failed to load models",
  "pickProviderFirst": "Pick a provider first",
  "noModels": "No models available for this provider",
  "saved": "Saved {time}",
  "saveToast": "Saved successfully · {time}",
  "saveFailed": "Save failed: {detail}",
  "errStrategy": "Strategy #{index} {issue}",
  "errNeedBoth": "needs a primary provider and model",
  "errNeedModel": "needs a primary model",
  "errNeedProvider": "needs a primary provider",
  "errBadStrategy": "is not a valid strategy object",
  "errBadPrimary": "has an invalid primary model",
  "errAdvancedSupport": "advanced model support is required once strategies are set",
  "errSeparator": "; ",
  "errMore": " (+{count} more)",
  "errTargetIncomplete": "{tier}: the off-peak provider and model are required",
  "errThresholdOrder": "The concrete threshold must be greater than the medium threshold",
  "errThresholdRange": "Thresholds must be between 0 and 1",
  "weekdayShort": "Mon,Tue,Wed,Thu,Fri,Sat,Sun",
  "strategyLabel": "Strategy {index}",
  "effortLow": "Low",
  "effortMedium": "Medium",
  "effortHigh": "High",
  "effortXhigh": "Extra high",
  "effortMax": "Max",
  "windowStart": "Start time",
  "windowEnd": "End time",
  "versionLabel": "Version",
  "sessionLightTitle": "Peak routing is on for this session",
  "sessionToggleHint": "Applies to this session only; right-click to follow the global default again.",
  "sessionToggleOn": "On for this session",
  "sessionToggleOff": "Off for this session",
  "decoupleLabel": "Decouple",
  "decoupledLabel": "Decoupled",
  "decoupleHintCoupled": "This session follows the global switch; click to detach it (global changes will no longer affect it).",
  "decoupleHintDecoupled": "This session is detached from the global switch; click to follow it again.",
  "decoupledCount": "· {count} decoupled",
  "sessionLightTitleDecoupled": "Peak routing is on for this session (decoupled from the global switch)",
  "activeNowLabel": "In force now: ",
  "reasonNone": "no target",
  "advancedForMax": "; {model} when a session asks for max thinking",
  "tierRoutingTitle": "Complexity routing",
  "tierRoutingHint": "When on, messages are split into three tiers by concreteness: abstract → high, medium → mid, concrete execution → low. Off by default; while off everything uses the low tier.",
  "tierThresholdConcrete": "Concrete threshold (≥ this goes low)",
  "tierThresholdMedium": "Medium threshold (≥ this goes mid)",
  "tierThresholdHint": "Both thresholds sit between 0 and 1, and the concrete threshold must be greater than the medium one.",
  "tierProbeTitle": "Try a sample",
  "tierProbePlaceholder": "Paste a prompt to preview its tier",
  "tierProbeRun": "Try",
  "tierProbeResult": "Score {score} · tier {tier} · target {model}",
  "tierProbeFeatures": "Matched features",
  "tierProbeUnavailable": "The running core does not expose the probe call (0.16.0 engine required)",
  "tierProbeFailed": "Probe failed: {detail}",
  "tierFallbackLow": "No text / cannot classify, fell back to the low tier",
  "targetsTitle": "Tier models",
  "tierLow": "Low tier (concrete execution)",
  "tierMid": "Mid tier (medium)",
  "tierHigh": "High tier (abstract)",
  "shareLow": "Follow the low tier",
  "shareLowHint": "Shares the low tier peak table by default; uncheck to configure this tier separately.",
  "shareLowInherited": "Inherited from the low tier (read-only)",
  "valleyModel": "Off-peak model",
  "costRoutingLabel": "Cost routing (switch to the peak model during peak hours)",
  "costRoutingHint": "When off, this tier always uses the off-peak model; peak windows are kept but inactive.",
  "peakWindowsTitle": "Peak windows",
  "peakWindowStart": "Start",
  "peakWindowEnd": "End",
  "peakWindowAdd": "+ Add window",
  "peakWindowsEmpty": "No windows: even with peak hours enabled this tier never switches to the peak model.",
  "peakWindowInvalid": "A window must end later on the same day (overnight windows are not supported yet)",
  "peakEnabledOn": "Peak hours enabled",
  "peakEnabledOff": "Peak hours disabled",
  "holidaysTitle": "Public holidays",
  "holidaysHint": "Holidays always use the off-peak model.",
  "holidayAdd": "+ Add date",
  "holidayInvalid": "A date must be valid and between 2000 and 2100",
  "holidayEmpty": "No holidays configured",
  "holidayPresetLabel": "Built-in preset",
  "holidayPresetAdd": "Import {year}",
  "holidayPresetMissing": "No built-in preset for {year}; add dates manually",
  "utcOffsetLabel": "UTC offset (minutes)",
  "utcOffsetHint": "Only affects how peak windows are interpreted; it does not change the system time zone.",
  "warningTitle": "Routing warnings",
  "warningUnroutable": "Target is not routable: {target} ({kind}) → kept {kept}",
  "warningUnverified": "The model catalog is not warm yet; skipped this switch: {target}",
  "warningLlmUnavailable": "The model service is unavailable; skipped this switch",
  "warningHostUnsupported": "This core does not support in-session routing (0.2.2-rc.1 or newer required)",
  "warningCleared": "Recovered: {target}",
  "warningNone": "No routing warnings",
  "warningRecent": "Recent warnings",
  "warningGeneric": "Routing warning: {kind} · {target}",
  "warningMore": "+{count} more",
  "warnKindProvider": "Provider not registered",
  "warnKindModel": "Model missing from catalog",
  "warnKindEffort": "Reasoning effort unavailable",
  "warnKindMissing": "Target missing",
  "warnKindUnverified": "Catalog not warm",
  "warnKindLlmUnavailable": "Model service unavailable",
  "warnKindSelectFailed": "Switch failed",
  "warnKindNoCurrent": "Cannot read the current model",
  "warnKindHostUnsupported": "Core unsupported",
  "warnKindRequestFailed": "Request failed",
  "warnKindSyncReadFailed": "Config read failed",
  "warnKindStateWriteFailed": "State write failed",
  "warnKindDefaultSeamMissing": "Default-model seam missing",
  "warnKindLegacyExtra": "Legacy strategies inactive",
  "warnKindInvalidHolidays": "Invalid holiday dates",
  "warningLegacyExtra": "Legacy policy: {count} extra strategies from #2 on no longer route (kept read-only); migrate them to the three tiers.",
  "warningInvalidHolidays": "Some holiday dates were invalid and have been ignored; please review the list and save again.",
  "warnKindOther": "Unknown issue",
  "tierReasonDisabled": "Complexity routing is off (always low)",
  "tierReasonLow": "concrete execution",
  "tierReasonMid": "moderately abstract",
  "tierReasonHigh": "abstract",
  "tierReasonOverrideSafety": "High-risk operation (safety override) → high tier",
  "tierReasonOverrideHigh": "User asked for deeper thinking → high tier",
  "tierReasonOverrideLow": "User asked for direct execution → low tier",
  "tierReasonFallbackLow": "Could not classify, fell back to the low tier",
  "tierReasonMax": "Session asked for max thinking → advanced model",
  "outcomeSelected": "switched",
  "outcomeNoop": "no switch needed",
  "outcomeUnroutable": "not routable",
  "outcomeSelectFailed": "switch failed",
  "outcomeDisabled": "not enabled",
  "fallbackLow": "Primary target unavailable, fell back to the low off-peak model",
  "recentDecisions": "Recent decisions",
  "decisionApplied": "switched",
  "decisionNoop": "already optimal",
  "decisionUnroutable": "not routable",
  "restoreTitle": "Restore the original model",
  "restoreHint": "Turn the switch off or click here to restore the model a session had before this plugin intervened.",
  "restoreOne": "Restore",
  "restoreAll": "Restore all",
  "restoreMissing": "No sessions to restore",
  "hostBadgeOk": "This core supports in-session routing",
  "hostBadgeOld": "This core is too old; routing will not take effect",
  "conflictTitle": "The configuration was changed in another window",
  "conflictExternalHint": "Another window changed the configuration; your draft was not overwritten.",
  "firstRunTitle": "First-run guide",
  "firstRunPoint1": "Peak routing is off by default: turn it on from the sidebar or the composer switch first; routing happens only after that.",
  "firstRunPoint2": "Three tiers: abstract requests → high, medium → mid, concrete execution → low. All three share the low-tier table by default; configure them separately only if needed.",
  "firstRunPoint3": "Each tier peak table is in the \"Tier models\" cards below: off-peak model, cost-routing switch, peak weekdays/windows and peak model. Global peak and holiday settings live in the public-holidays block.",
  "firstRunPoint4": "This guide disappears after your first save; you can dismiss it at any time.",
  "firstRunDismiss": "Got it",
  "conflictReload": "Reload",
  "conflictOverwrite": "Overwrite with mine",
  "reloadConfig": "Reload configuration",
  "costReasonPeak": "peak plan",
  "costReasonValley": "off-peak plan",
  "costReasonCostOff": "cost routing is off for this tier",
  "costReasonPeakDisabled": "peak hours are not enabled for this tier",
  "costReasonWeekday": "not a peak weekday",
  "costReasonHoliday": "public holiday",
  "costReasonOutside": "outside every peak window",
  "axisMax": "the session asked for max thinking",
  "featureCode": "code block",
  "featurePath": "file path",
  "featureCommand": "command",
  "featureSymbol": "symbols / errors",
  "featureVerb": "execution verb",
  "featureMulti": "multiple sub-questions",
  "featureAbstract": "abstract wording",
  "featureLong": "long text",
  "featureShort": "very short text",
  "featureShortCommand": "Short command (direct execution)",
  "featureImage": "image attached",
  "featureMidTurn": "mid-conversation",
  "featureOverrideSafety": "safety override",
  "featureOverrideHigh": "asks for deeper thinking",
  "featureOverrideLow": "asks for direct execution",
  "featureTarget": "Concrete object",
  "featureSequence": "Multi-step"
}

// ---- src/client/00-shared.js ----
// 共享常量与 RPC 封装。所有 client 端模块共用。

const NS = 'settings.peakValley'

const inject = ['slots', 'connection', 'locale']

// 统一解包 { ok, value } 信封；失败时抛出服务端消息。
// 结构化错误码（如 set 的 stale-revision）挂到 error.code / error.details 上，
// 供 UI 区分「冲突」与普通失败——消息文本可能被本地化，code 不会。
function rpc(connection) {
  const call = async (method, payload) => {
    const res = await connection.rpc.call('/api', method, payload)
    if (res && res.ok === true) return res.value
    const raw = res && res.error
    const msg = raw?.message ?? raw ?? 'RPC failed'
    const error = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    if (raw && typeof raw === 'object') {
      if (typeof raw.code === 'string') error.code = raw.code
      if (raw.details !== undefined) error.details = raw.details
    }
    throw error
  }
  return {
    get: () => call('dsh-peak-valley-router.get', {}),
    // expectedRevision 只在服务端下发过 configRevision 时才带；旧服务端忽略未知字段。
    set: (config, expectedRevision) => call(
      'dsh-peak-valley-router.set',
      expectedRevision === undefined || expectedRevision === null ? { config } : { config, expectedRevision },
    ),
    providers: () => call('dsh-peak-valley-router.providers', { strict: true }),
    models: (provider) => call('dsh-peak-valley-router.models', { provider, strict: true }),
    toggle: (payload) => call('dsh-peak-valley-router.toggle', typeof payload === 'boolean' ? { enabled: payload } : (payload || {})),
    // 只读试算：不落盘、不 select（设计 §8）。0.16 引擎才有；缺失时 UI 降级。
    probe: (payload) => call('dsh-peak-valley-router.probe', payload || {}),
    restore: (sessionId) => call('dsh-peak-valley-router.restore', { sessionId }),
  }
}

// 星期简称：来自 lib/text.js 的 weekdayShort（单一维护文件，zh `一,二…` / en `Mon,Tue…`）。
// key 缺失时 DSH 会把 key 名原样返回，此时整体退回空数组，由调用方显示数字，
// 避免 d=1 把 "weekdayShort" 当成星期的文案渲染出来。
function weekdayLabels(t) {
  const raw = t('weekdayShort')
  if (raw === undefined || raw === null || raw === 'weekdayShort') return []
  return String(raw).split(',')
}

// 控件「自身容器」的宽度（不是窗口宽度）。设置面板常常比窗口窄（分屏、窄窗口、
// 宿主内边距），按窗口判断会把三个下拉硬挤在一行。用 ResizeObserver 实测自身宽度。
// 返回 [ref, narrow]；ref 是回调 ref，挂到被测量的根元素上。
// 用回调 ref + state 保存节点（而不是 useRef）：节点被重新挂载时 effect 会重跑，
// 不会出现「一直在观测旧节点」这种静默失效。
function useContainerWidth(threshold) {
  const [node, setNode] = useState(null)
  const [narrow, setNarrow] = useState(false)
  // ref 回调里**同步**测一次：effect 要等绘制之后才跑，本就窄的容器会先闪一帧宽布局。
  const ref = useCallback((next) => {
    setNode(next || null)
    if (next && next.clientWidth > 0) setNarrow(next.clientWidth < threshold)
  }, [threshold])
  useEffect(() => {
    if (!node) return undefined
    const read = () => {
      const width = node.clientWidth
      // clientWidth 为 0（尚未布局或被隐藏）时保持上一次判断，避免宽度闪一下。
      if (width > 0) setNarrow(width < threshold)
    }
    read()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read)
      return () => window.removeEventListener('resize', read)
    }
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, threshold])
  return [ref, narrow]
}

// ---- 「启用避峰岗」开关的共享状态源 ----
// 侧边栏入口与 composer 备用入口必须读写同一份状态：两边各自 rpc.get 会撕裂状态，
// 所以这里放一个极简订阅源，由 registerToggle 创建一次、注入给两个入口。

function peakRoutingErrorText(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

// rpc.get() -> { config, enabled }；rpc.toggle(enabled) -> { enabled }（见 90-apply.js / lib/index.js）。
function createPeakRoutingStore(api) {
  const listeners = new Set()
  // sessions: 每会话显式覆盖（sessionId -> boolean）；缺席即跟随 enabled（全局默认）。
  // version: 由 node 端读 package.json 下发，用于确认运行时到底是哪一版。
  let state = { enabled: false, sessions: {}, version: '', ready: false, busy: false, failed: false, error: '' }
  let loading = null

  const snapshot = () => ({ ...state })
  const publish = (patch) => {
    state = { ...state, ...patch }
    const view = snapshot()
    // 订阅者（React setState）抛错不得影响其他订阅者，更不得冒泡到开关本身。
    for (const listener of Array.from(listeners)) {
      try {
        listener(view)
      } catch (err) {
        console.error('[peak-valley-router] toggle subscriber failed', err)
      }
    }
  }

  const read = async () => {
    try {
      const value = await api.get()
      const enabled = Boolean(value && value.enabled)
      publish({
        enabled,
        sessions: peakRoutingSessions(value),
        version: typeof value?.version === 'string' ? value.version : '',
        ready: true,
        busy: false,
        failed: false,
        error: '',
      })
      return enabled
    } catch (err) {
      // 读取失败：保留本地状态，只标记非致命失败（开关仍然可点）。
      publish({ ready: true, busy: false, failed: true, error: peakRoutingErrorText(err) })
      return undefined
    }
  }

  // 会话的有效状态：有显式覆盖用覆盖值，否则跟随全局默认。
  const sessionState = (sessionId) => peakSessionEffective(state.enabled, state.sessions, sessionId)
  const hasOverride = (sessionId) => typeof sessionId === 'string' && sessionId !== ''
    && Object.prototype.hasOwnProperty.call(state.sessions, sessionId)

  // 用服务端回包替换本地状态；回包缺字段时退回当前值，避免把 UI 抖成空。
  const reconcile = (value, fallbackSessions, fallbackEnabled) => ({
    enabled: value && typeof value.enabled === 'boolean' ? value.enabled : fallbackEnabled,
    sessions: value && value.sessions !== undefined ? peakRoutingSessions(value) : fallbackSessions,
  })

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: snapshot,
    sessionState,
    hasOverride,
    // 两个入口共用同一次首次读取（重复挂载不会重复发 rpc.get）。
    ensureLoaded() {
      if (loading === null) loading = read()
      return loading
    },
    /**
     * 写开关。带 sessionId 时只改该会话（inherit=true 则清除覆盖、回到跟随全局），
     * 不带时改全局默认。乐观更新 + 服务端回包校正 + 失败回滚。
     */
    async toggle(next, sessionId, inherit) {
      const before = { enabled: state.enabled, sessions: state.sessions }
      const id = typeof sessionId === 'string' && sessionId ? sessionId : ''
      if (state.busy) return id ? sessionState(id) : before.enabled

      const desired = typeof next === 'boolean' ? next : (id ? !sessionState(id) : !before.enabled)
      const optimistic = { ...before.sessions }
      if (id && inherit === true) delete optimistic[id]
      else if (id) optimistic[id] = desired
      publish({
        enabled: id ? before.enabled : desired,
        sessions: optimistic,
        busy: true,
        failed: false,
        error: '',
      })
      try {
        const value = await api.toggle(id
          ? (inherit === true ? { sessionId: id, inherit: true } : { enabled: desired, sessionId: id })
          : { enabled: desired })
        const next2 = reconcile(value, optimistic, id ? before.enabled : desired)
        publish({ ...next2, busy: false, failed: false, error: '' })
        return id ? (value && typeof value.sessionEnabled === 'boolean' ? value.sessionEnabled : sessionState(id)) : next2.enabled
      } catch (err) {
        // 失败：回滚到点击前的状态，并给出可展示的非致命错误文本。
        publish({ ...before, busy: false, failed: true, error: peakRoutingErrorText(err) })
        return id ? sessionState(id) : before.enabled
      }
    },
  }
}

// 只保留布尔值，避免脏数据（运行时下发的东西也要当外部输入处理）。
function peakRoutingSessions(value) {
  const raw = value && value.sessions
  // Null-prototype for the same reason the node side uses one: an id of
  // "__proto__" must survive as an own key instead of being swallowed by the
  // prototype setter (which would silently drop that session's state).
  const out = Object.create(null)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, flag] of Object.entries(raw)) {
      if (id && typeof flag === 'boolean') out[id] = flag
    }
  }
  return out
}

// 会话有效状态（纯函数，便于单测）：显式覆盖优先，否则跟随全局默认。
// 没有会话 id（列表外的入口）时就是全局默认。
function peakSessionEffective(enabled, sessions, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : ''
  if (!id) return enabled === true
  const map = sessions && typeof sessions === 'object' ? sessions : {}
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] === true : enabled === true
}

// 订阅共享 store；首次挂载触发一次共享 rpc.get()。
// toggle(next, sessionId?, inherit?) —— 带 sessionId 时只改该会话。
function usePeakRouting(store) {
  const [view, setView] = useState(() => (store ? store.get() : null))
  useEffect(() => {
    if (!store) return undefined
    setView(store.get())
    const off = store.subscribe(setView)
    store.ensureLoaded()
    return off
  }, [store])
  const toggle = useCallback((next, sessionId, inherit) => (store ? store.toggle(next, sessionId, inherit) : Promise.resolve(false)), [store])
  return { view, toggle }
}

// 单个会话的完整状态：on = 此刻是否生效；decoupled = 是否已「全局解耦」
// （即存在显式覆盖，不再跟随全局开关）。会话列表小灯与 composer 的两个控件都用它，
// 共用一次订阅。
function usePeakSessionState(store, sessionId) {
  const read = () => {
    const view = store ? store.get() : null
    return {
      on: Boolean(view && peakSessionEffective(view.enabled, view.sessions, sessionId)),
      decoupled: Boolean(view && store && store.hasOverride(sessionId)),
    }
  }
  const [state, setState] = useState(read)
  useEffect(() => {
    if (!store) return undefined
    const sync = () => setState(read())
    sync()
    const off = store.subscribe(sync)
    store.ensureLoaded()
    return off
  }, [store, sessionId])
  return state
}

// ---- src/client/10-toggle.js ----
// 「启用避峰岗」开关 —— 左侧侧边栏主入口 + composer 备用入口（移动端/窄屏可达）。
//
// 契约（由 90-apply.js 调用）：registerToggle(ctx, { rpc, t })
//   ctx  — 插件 ctx（ctx.slots.inject / ctx.slots.register）
//   rpc  — 见 00-shared.js：get() / toggle(enabled)
//   t    — 文案函数，key 全部来自 lib/text.js（本文件不新增 key）
// 开关状态由 node 端维持（启用后会话模型选择器功能性失效，由 W1 在 node 端实现），
// 客户端只负责呈现与写回。
//
// 入口与共享状态：
//   1) sidebar.footer.action   —— list / root（.recon/sidebar.client.js:406、:523-526），
//      渲染在侧边栏 footArea 的 footerActions 里，接收 owner props { wide }。
//   2) conversation.input.left —— list / session（.recon/conversation.client.js:18340-18343，
//      渲染于 :17543 composer 输入区），侧边栏不可达时仍随会话显示。
//   两个入口共用 registerToggle 里创建的同一个 store（00-shared.js），只发一次 rpc.get()。

const PEAK_ROUTING_ATTR = 'data-dsh-peak-routing'
const PEAK_ROUTING_STYLE_ID = 'dsh-peak-routing-style'

// 注入样式：
//   a) 开关自身的类（dsh-peak-* 前缀，非构建哈希，稳定）；
//   b) 视觉接管规则 —— 只在 html[data-dsh-peak-routing="on"] 下生效。
// 接管选择器以语义选择器为主：composer 卡片容器（.recon/conversation.client.js:17457
// 的 data-composer-card）内的菜单型触发器按钮；当前唯一占用者是会话模型选择器
// （.recon/model-selection.client.js:839-845 的 trigger button，:426 的 CSS-module 前缀
// 在本构建为 _7KE1Ra_）。哈希类名只作补充匹配，DSH 升级换哈希后本条自然失配并静默降级。
const PEAK_ROUTING_CSS = [
  '.dsh-peak-toggle{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;margin:2px 0;padding:6px 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}',
  '.dsh-peak-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
  '.dsh-peak-toggle:disabled{opacity:.6;cursor:default}',
  '.dsh-peak-toggle[data-on="true"]{color:var(--dsw-alias-state-business-primary,#4c8dff);background:var(--dsw-alias-interactive-bg-hover,rgba(76,141,255,.14));border-color:currentColor}',
  '.dsh-peak-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}',
  '.dsh-peak-label{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-peak-state{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dsh-peak-toggle[data-on="true"] .dsh-peak-state{color:currentColor;opacity:.85}',
  '.dsh-peak-hint{display:block;margin-top:1px;font-size:11px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dsh-peak-warn{margin-left:4px;font-weight:700;color:var(--dsw-alias-state-error-primary,#e5484d)}',
  '.dsh-peak-track{position:relative;flex:none;width:28px;height:16px;border-radius:8px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.45));transition:background .12s ease}',
  '.dsh-peak-toggle[data-on="true"] .dsh-peak-track{background:currentColor}',
  '.dsh-peak-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:transform .12s ease}',
  '.dsh-peak-toggle[data-on="true"] .dsh-peak-knob{transform:translateX(12px)}',
  // 收起态（56px 轨道，内容宽 36px）：32px 方形图标按钮，不撑破轨道。
  '.dsh-peak-rail{position:relative;width:32px;height:32px;margin:0 auto;padding:0;gap:0;justify-content:center}',
  '.dsh-peak-dot{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:currentColor}',
  // composer 备用入口：28px 高，与模型触发器同高，不撑破输入行。
  '.dsh-peak-chip{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;height:28px;max-width:100%;padding:0 8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
  '.dsh-peak-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
  '.dsh-peak-chip:disabled{opacity:.6;cursor:default}',
  '.dsh-peak-chip[data-on="true"]{color:var(--dsw-alias-state-business-primary,#4c8dff);border-color:currentColor}',
  '.dsh-peak-chip-label{max-width:84px;overflow:hidden;text-overflow:ellipsis}',
  '@media (max-width:420px){.dsh-peak-chip-label{display:none}}',
  // 会话列表行首小灯（sidebar.session.row.leading）。「微微亮蓝光」：小圆点 + 柔和外发光，
  // 并做极缓慢的呼吸；尊重 prefers-reduced-motion。已解耦的会话多一圈淡环做区分。
  '.dsh-peak-light{display:block;flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4c8dff);box-shadow:0 0 4px rgba(76,141,255,.75),0 0 1px rgba(76,141,255,.9);opacity:.85}',
  '.dsh-peak-light[data-decoupled="true"]{box-shadow:0 0 4px rgba(76,141,255,.75),0 0 1px rgba(76,141,255,.9),0 0 0 2px rgba(76,141,255,.2)}',
  '@keyframes dsh-peak-breathe{0%,100%{opacity:.5}50%{opacity:1}}',
  '@media (prefers-reduced-motion:no-preference){.dsh-peak-light{animation:dsh-peak-breathe 2.6s ease-in-out infinite}}',
  // 「全局解耦」小开关：两个圆环相接 = 跟随全局；分开 = 已解耦。纯 CSS 画，不引图标依赖。
  '.dsh-peak-link{position:relative;flex:none;width:14px;height:12px}',
  '.dsh-peak-link::before,.dsh-peak-link::after{content:"";position:absolute;top:2.5px;width:6px;height:6px;box-sizing:border-box;border:1.2px solid currentColor;border-radius:50%;transition:transform .12s ease}',
  '.dsh-peak-link::before{left:0}',
  '.dsh-peak-link::after{right:0}',
  '.dsh-peak-decouple[data-on="true"] .dsh-peak-link::before{transform:translateX(-2px)}',
  '.dsh-peak-decouple[data-on="true"] .dsh-peak-link::after{transform:translateX(2px)}',
  '.dsh-peak-decouple[data-on="true"]{color:var(--dsw-alias-state-business-primary,#4c8dff);border-color:currentColor}',
// 接管选择器（审计后收窄）：只用「composer 卡片 + 模型触发器类片段」的组合，
// 不再用 `button[aria-haspopup="menu"]` —— 那条虽然在本构建无损，但未来 composer 里
// 新增任何菜单按钮都会被一并禁用。哈希类名是构建生成的，DSH 升级换哈希后本条自然
// 失配并静默降级：视觉变灰消失，但功能性接管（node 端 agent/request 覆盖）不受影响。
  'html[' + PEAK_ROUTING_ATTR + '="on"] [data-composer-card] button[class*="_7KE1Ra_trigger"]{',
  'opacity:.45;filter:grayscale(1);pointer-events:none !important;cursor:not-allowed;',
  '}',
].join('\n')

// 注入与属性都是全局副作用：按 key 登记各入口的诉求，最后一个卸载时才清理。
// 每个入口登记 { on, sessionKnown }。会话内入口（知道当前会话）优先——模型选择器的
// 置灰要跟随「当前会话」而不是全局默认；只有全局入口挂载时才用全局默认。
// 任何 DOM 异常都吞掉（降级），绝不影响侧边栏渲染。
const peakRoutingVisual = (() => {
  let entries = []
  let styleEl = null

  const doc = () => (typeof document === 'undefined' ? null : document)

  const ensureStyle = () => {
    const d = doc()
    if (d === null || d.head === null) return
    if (styleEl !== null && styleEl.isConnected === true) return
    const existing = typeof d.getElementById === 'function' ? d.getElementById(PEAK_ROUTING_STYLE_ID) : null
    if (existing !== null && existing !== undefined) {
      styleEl = existing
      return
    }
    const el = d.createElement('style')
    el.id = PEAK_ROUTING_STYLE_ID
    el.textContent = PEAK_ROUTING_CSS
    d.head.appendChild(el)
    styleEl = el
  }

  const apply = (enabled) => {
    const d = doc()
    if (d === null || d.documentElement === null) return
    if (enabled === true) d.documentElement.setAttribute(PEAK_ROUTING_ATTR, 'on')
    else d.documentElement.removeAttribute(PEAK_ROUTING_ATTR)
  }

  const recompute = () => {
    const aware = entries.filter((entry) => entry.sessionKnown)
    const source = aware.length > 0 ? aware[aware.length - 1] : entries[0]
    apply(Boolean(source && source.on))
  }

  return {
    register(key, on, sessionKnown) {
      try {
        ensureStyle()
        entries = entries.filter((entry) => entry.key !== key)
        entries.push({ key, on: on === true, sessionKnown: sessionKnown === true })
        recompute()
      } catch (err) {
        console.error('[peak-valley-router] toggle style injection failed', err)
      }
    },
    unregister(key) {
      try {
        entries = entries.filter((entry) => entry.key !== key)
        if (entries.length === 0) {
          apply(false)
          if (styleEl !== null && styleEl.isConnected === true) styleEl.remove()
          styleEl = null
          return
        }
        recompute()
      } catch (err) {
        console.error('[peak-valley-router] toggle style cleanup failed', err)
      }
    },
  }
})()

// 挂载时注入一次样式；enabled 变化时同步 html 属性；卸载时按 key 注销。
// 两个 effect 分开是关键：如果 value 变化的 effect 也返回注销函数，每次切换都会
// 先卸载（清掉样式与属性）再重新注册，模型选择器会闪一下。
function usePeakRoutingVisual(enabled, sessionKnown) {
  const keyRef = useRef(null)
  if (keyRef.current === null) keyRef.current = 'peak-visual-' + Math.random().toString(36).slice(2)
  const key = keyRef.current
  useEffect(() => () => {
    peakRoutingVisual.unregister(key)
  }, [key])
  useEffect(() => {
    peakRoutingVisual.register(key, enabled, sessionKnown)
  }, [key, enabled, sessionKnown])
}

// 盾牌 + 对勾（非 emoji；纯装饰，语义由 aria-label / title 承担）。
function PeakRoutingIcon(props) {
  const h = React.createElement
  const size = props && props.size ? props.size : 16
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    'aria-hidden': 'true',
    focusable: 'false',
    style: { flex: 'none' },
  }, [
    h('path', { key: 'shield', d: 'M8 1.6 13.2 3.7v3.9c0 3.1-2.1 5.6-5.2 6.8-3.1-1.2-5.2-3.7-5.2-6.8V3.7L8 1.6Z' }),
    h('path', { key: 'check', d: 'M5.6 8.1 7.3 9.8l3.1-3.4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ])
}

// 开关行为（两个入口共用）：状态来自共享 store，点击写回 node 端。
// 会话内入口（composer，session 作用域，注入 sessionId）改的是「这个会话」；
// 侧边栏入口没有 sessionId，改的是「全局默认」。右键 = 恢复为跟随全局。
function usePeakToggle(deps) {
  const store = deps ? deps.store : null
  const t = deps && typeof deps.t === 'function' ? deps.t : (key) => key
  const sessionId = deps && typeof deps.sessionId === 'string' && deps.sessionId ? deps.sessionId : ''
  const { view, toggle } = usePeakRouting(store)
  const enabled = Boolean(view && peakSessionEffective(view.enabled, view.sessions, sessionId))
  usePeakRoutingVisual(enabled, sessionId !== '')

  // 首次 rpc.get 返回前不渲染：否则开关会先显示「未启用」再翻转成真实状态。
  // 失败路径同样会把 ready 置 true，所以读失败时开关照常出现（带 '!' 标记）。
  if (!view || view.ready !== true) return null

  const failed = view.failed === true
  const label = t('toggleLabel')
  const stateText = sessionId
    ? (enabled ? t('sessionToggleOn') : t('sessionToggleOff'))
    : (enabled ? t('toggleOn') : t('toggleOff'))
  // 全局入口在提示里带上「有多少会话已解耦」——否则解耦过的会话在全局侧完全不可见。
  const decoupledCount = !sessionId && view.sessions && typeof view.sessions === 'object'
    ? Object.keys(view.sessions).length
    : 0
  const baseHint = sessionId ? t('sessionToggleHint') : t('toggleHint')
  const hint = decoupledCount > 0
    ? baseHint + ' ' + t('decoupledCount', { count: decoupledCount })
    : baseHint
  const errorText = failed && view.error ? String(view.error) : ''
  const title = errorText === '' ? hint : hint + ' — ' + errorText
  const ariaLabel = label + ' · ' + stateText

  const run = (next, id, inherit) => {
    const pending = toggle(next, id, inherit)
    // store.toggle 内部已 try/catch，这里只兜底未处理的 rejection。
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  }
  const onClick = () => run(undefined, sessionId || undefined)
  const onContextMenu = sessionId
    ? (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault()
      run(undefined, sessionId, true)
    }
    : undefined

  return { enabled, failed, errorText, label, stateText, hint, title, ariaLabel, busy: view.busy === true, onClick, onContextMenu }
}

// 会话列表行首小灯（sidebar.session.row.leading，list / root，owner 传 { sessionId }）。
// 亮 = 该会话的有效状态为开（显式覆盖，或没有覆盖时跟随全局默认）。
// 复用同一个 store（不额外发 RPC）；每个会话行一个实例，成本只有一次订阅。
function PeakSessionLight(props) {
  const h = React.createElement
  const store = props ? props.store : null
  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
  const state = usePeakSessionState(store, sessionId)
  if (!sessionId || !state.on) return null
  const title = t0(props, state.decoupled ? 'sessionLightTitleDecoupled' : 'sessionLightTitle')
  return h('span', {
    className: 'dsh-peak-light',
    role: 'img',
    'aria-label': title,
    title,
    ...(state.decoupled ? { 'data-decoupled': 'true' } : {}),
  })
}

// 「全局解耦」小开关（composer 输入区，session 作用域）：
//   跟随中 -> 点一下解耦：写入「当前有效值」作为本会话的独立值，可见状态不变，
//             但此后的全局切换不再影响本会话；
//   已解耦 -> 点一下接回：清掉独立值，重新跟随全局。
// 两种情况下「此刻是否生效」都不变——它只切换连接关系，不切换开关本身。
function PeakDecoupleToggle(props) {
  const h = React.createElement
  const store = props ? props.store : null
  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
  const t = (key) => t0(props, key)
  const { view, toggle } = usePeakRouting(store)

  // 与开关一致：首个 rpc.get 返回前不渲染，避免先显示错误状态。
  if (!view || view.ready !== true || !sessionId) return null

  const decoupled = Boolean(store && store.hasOverride(sessionId))
  const effective = Boolean(peakSessionEffective(view.enabled, view.sessions, sessionId))
  const title = t(decoupled ? 'decoupleHintDecoupled' : 'decoupleHintCoupled')

  const onClick = () => {
    const pending = decoupled
      ? toggle(undefined, sessionId, true) // 接回：清除覆盖，跟随全局
      : toggle(effective, sessionId) // 解耦：把当前有效值固定为本会话独立值
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  }

  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': decoupled ? 'true' : 'false',
    'aria-label': t('decoupleLabel'),
    title,
    'data-on': decoupled ? 'true' : 'false',
    disabled: view.busy === true,
    onClick,
    className: 'dsh-peak-chip dsh-peak-decouple',
  }, [
    h('span', { key: 'icon', className: 'dsh-peak-link', 'aria-hidden': 'true' }),
    h('span', { key: 'label', className: 'dsh-peak-chip-label' }, t(decoupled ? 'decoupledLabel' : 'decoupleLabel')),
  ])
}

// 侧边栏入口：wide=true 展开态显示标签+开关+状态（开启时加一行提示），
// wide=false 是 56px 轨道，只显示 32px 图标按钮 + 状态点。
function PeakSidebarToggle(props) {
  const h = React.createElement
  const wide = props.wide !== false
  const state = usePeakToggle(props)
  if (state === null) return null

  const switchProps = {
    type: 'button',
    role: 'switch',
    'aria-checked': state.enabled ? 'true' : 'false',
    'aria-label': state.ariaLabel,
    title: state.title,
    'data-on': state.enabled ? 'true' : 'false',
    disabled: state.busy,
    onClick: state.onClick,
    ...(state.onContextMenu ? { onContextMenu: state.onContextMenu } : {}),
  }

  if (!wide) {
    return h('button', { ...switchProps, className: 'dsh-peak-toggle dsh-peak-rail' }, [
      h(PeakRoutingIcon, { key: 'icon', size: 18 }),
      state.enabled ? h('span', { key: 'dot', className: 'dsh-peak-dot', 'aria-hidden': 'true' }) : null,
    ])
  }

  const labelRow = h('span', { key: 'label-row', className: 'dsh-peak-label' }, [
    state.label,
    state.failed ? h('span', { key: 'warn', className: 'dsh-peak-warn', title: state.errorText }, '!') : null,
  ])

  return h('button', { ...switchProps, className: 'dsh-peak-toggle dsh-peak-toggle-wide' }, [
    h('span', { key: 'text', className: 'dsh-peak-text' }, [
      labelRow,
      h('span', { key: 'state', className: 'dsh-peak-state' }, state.stateText),
      state.enabled ? h('span', { key: 'hint', className: 'dsh-peak-hint', title: state.hint }, state.hint) : null,
    ]),
    h('span', { key: 'track', className: 'dsh-peak-track', 'aria-hidden': 'true' }, h('span', { className: 'dsh-peak-knob' })),
  ])
}

// composer 备用入口（conversation.input.left，会话内恒在）：紧凑 chip，28px 高。
function PeakComposerToggle(props) {
  const h = React.createElement
  const state = usePeakToggle(props)
  if (state === null) return null

  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': state.enabled ? 'true' : 'false',
    'aria-label': state.ariaLabel,
    title: state.title,
    'data-on': state.enabled ? 'true' : 'false',
    disabled: state.busy,
    onClick: state.onClick,
    ...(state.onContextMenu ? { onContextMenu: state.onContextMenu } : {}),
    className: 'dsh-peak-chip',
  }, [
    h(PeakRoutingIcon, { key: 'icon', size: 14 }),
    h('span', { key: 'label', className: 'dsh-peak-chip-label' }, t0(props, 'nav')),
    state.failed ? h('span', { key: 'warn', className: 'dsh-peak-warn' }, '!') : null,
  ])
}

// 文案取值兜底：t 缺失或抛错时退回 key，绝不因文案问题中断渲染。
function t0(props, key) {
  try {
    const value = props && typeof props.t === 'function' ? props.t(key) : key
    return typeof value === 'string' && value !== '' ? value : key
  } catch (err) {
    return key
  }
}

function registerToggle(ctx, deps) {
  const api = deps ? deps.rpc : null
  const t = deps && typeof deps.t === 'function' ? deps.t : null
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return
  if (!api || typeof api.get !== 'function' || typeof api.toggle !== 'function' || t === null) return

  // 两个入口共享的唯一状态源（一次 rpc.get()）。
  const store = createPeakRoutingStore(api)
  const inject = () => ({ rpc: api, t, store })

  // 主入口：侧边栏底部（list / root），owner 传入 { wide }。
  // 注：ctx.slots.register 内部已用 ctx.effect 包裹（.recon/renderer.client.js:1788-1791），
  // 这里不再包一层；list 槽必须有唯一 id（.recon/slots.index.js:181-186）。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'peak-valley-router-toggle',
    order: 50,
    inject,
  }, PeakSidebarToggle))

  // 备用入口：composer 输入区左侧（list / session）。窄屏（<1024px，layout.client.js:13/:236）
  // 或 Windows 收起态（collapsedWidth=0，layout.client.js:241；footArea display:none，
  // sidebar.client.js:91）时侧边栏入口不可达，此入口仍在。
  // 它是 session 作用域：inject 回调会收到当前会话 id（同官方 model-selection 的写法，
  // .recon/model-selection.client.js:1248-1263），因此这里读写的是「这个会话」。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'peak-valley-router-toggle',
    order: 40,
    inject: (sessionId) => ({ rpc: api, t, store, sessionId: typeof sessionId === 'string' ? sessionId : '' }),
  }, PeakComposerToggle))

  // 「全局解耦」小开关：同一个 session 作用域插槽的第二项（list 槽每项需唯一 id）。
  // 它只切换「这个会话与全局开关的连接关系」，不切换开关本身。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'peak-valley-router-decouple',
    order: 41,
    inject: (sessionId) => ({ rpc: api, t, store, sessionId: typeof sessionId === 'string' ? sessionId : '' }),
  }, PeakDecoupleToggle))

  // 会话列表行首小灯：sidebar.session.row.leading（list / root）。
  // owner 每次渲染传入 { sessionId }（.recon/workspace.client.js:1755），
  // 声明见 :4490-4493。注意该位置只在「非归档、非空白、无状态点、无未读」时渲染
  // （:1755 的条件链）—— 因此小灯在会话运行中/有未读时不显示，这是宿主行为，不改动。
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'peak-valley-router-light',
    order: 60,
    inject: () => ({ store, t }),
  }, PeakSessionLight))
}

// ---- src/client/20-modelpicker.js ----
// Provider + 模型 + 思考档 三档选择器。
// 约定：provider 下拉把全部已注册 provider（API 与订阅套餐）并列展示；
// 模型一律「下拉选择」，选项由 40-settings.js 通过 models RPC 拉取后传入（models[providerId]）。
// 降级：providers / 模型拉取失败时下拉仍然可用（可能为空），不阻塞保存。
//
// 布局：宽容器三列（Provider / 模型 各占一份，思考档固定窄列，避免被等分拉长）；
// 窄容器竖直堆叠。narrow 由 40-settings.js 按「控件自身容器宽度」实测后传入，
// 不用窗口宽度（设置面板常比窗口窄）。
//
// props:
//   label          — 选择器标题（如「主模型」）
//   value          — { provider, model, reasoningEffort }
//   providers      — [{ id, name }]，可为空数组
//   models         — { [providerId]: [{ id, name }] }
//   modelsLoading  — 当前 provider 的模型是否正在拉取
//   modelsError    — 当前 provider 的模型拉取失败信息（无失败时为空串）
//   onChange       — (nextValue) => void
//   onNeedModels   — (providerId) => void，切换 provider 时懒加载该 provider 的模型
//   t / narrow     — 文案函数 / 是否窄容器

function ModelPicker(props) {
  const h = React.createElement
  const { label, value, providers, models, modelsLoading, modelsError, onChange, onNeedModels, t, narrow, disabled } = props
  // disabled：用于「跟随低档」时的只读展示（继承值不允许在这里改），以及成本决策
  // 关闭后置灰的峰时子区。置灰但仍显示当前值，绝不隐藏——用户要能看见继承到什么。
  const locked = disabled === true
  const v = value || {}
  const providerList = Array.isArray(providers) ? providers : []

  // provider 选项：显示 name || id，按 id 去重（防止目录重复导致 React key 冲突）。
  const seenProviders = Object.create(null)
  const providerOptions = []
  for (const p of providerList) {
    const id = p && (p.id || p.name) ? String(p.id || p.name) : ''
    if (!id || seenProviders[id]) continue
    seenProviders[id] = true
    providerOptions.push(h('option', { key: 'p:' + id, value: id }, String((p && p.name) || id)))
  }
  // 配置里已选的 provider 不在目录中（目录失败 / 未列出）时保留一项，避免选择器显示为空。
  const providerMissing = Boolean(v.provider) && !seenProviders[String(v.provider)]

  // 模型选项：当前 provider 的目录；目录里没有当前值时额外保留一项。
  const modelList = models && Array.isArray(models[v.provider]) ? models[v.provider] : []
  const modelOptions = []
  const seenModels = Object.create(null)
  for (const m of modelList) {
    const id = m && (m.id || m.name) ? String(m.id || m.name) : ''
    if (!id || seenModels[id]) continue
    seenModels[id] = true
    modelOptions.push(h('option', { key: 'm:' + id, value: id }, String((m && m.name) || id)))
  }
  const modelMissing = Boolean(v.model) && !seenModels[String(v.model)]

  const busy = modelsLoading === true
  const failed = modelsError ? String(modelsError) : ''

  // 模型下拉的第一项：未选 provider / 拉取中 / 失败 / 无模型时给出对应占位，避免空下拉。
  let modelPlaceholder
  if (!v.provider) modelPlaceholder = t('pickProviderFirst')
  else if (failed) modelPlaceholder = t('modelsLoadFailed')
  else if (busy) modelPlaceholder = t('modelsLoading')
  else if (modelOptions.length === 0) modelPlaceholder = t('noModels')
  else modelPlaceholder = t('pickModel')

  const modelChildren = []
  modelChildren.push(h('option', { key: '__placeholder', value: '' }, modelPlaceholder))
  if (modelMissing) {
    modelChildren.push(h('option', { key: '__current', value: String(v.model) }, String(v.model)))
  }
  for (const opt of modelOptions) modelChildren.push(opt)

  // 思考档：value 保持 DSH 的枚举值，标签走文案表（此前直接显示 low/max 这类原始值）。
  const effortChoices = [
    ['', t('effortDefault')],
    ['low', t('effortLow')],
    ['medium', t('effortMedium')],
    ['high', t('effortHigh')],
    ['xhigh', t('effortXhigh')],
    ['max', t('effortMax')],
  ]

  const ctrlStyle = {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
  }
  // 思考档只需要窄栏；等分会让它被拉得很长、值靠左显得空旷。给足最小宽度，
  // 避免「默认思考档」/「Extra high」这类较长标签在原生 select 里被裁切。
  const rowStyle = narrow
    ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }
    : { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(116px, 140px)', gap: 8 }

  const status = failed ? t('modelsLoadFailed') : (busy ? t('modelsLoading') : '')

  return h('div', { style: { minWidth: 0, opacity: locked ? 0.7 : 1 } },
    label
      ? h('div', {
        style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 },
      }, label)
      : null,
    h('div', { style: rowStyle },
      h('select', {
        'aria-label': t('pickProvider'),
        title: v.provider || '',
        value: v.provider || '',
        style: ctrlStyle,
        disabled: locked,
        onChange: (e) => {
          const next = e.target.value
          // 切换 provider 必须清空 model，避免 provider/model 不匹配。
          onChange({ ...v, provider: next, model: '' })
          if (next && onNeedModels) onNeedModels(next)
        },
      },
        h('option', { key: '__pick', value: '' }, t('pickProvider')),
        providerMissing ? h('option', { key: '__current', value: String(v.provider) }, String(v.provider)) : null,
        ...providerOptions,
      ),
      h('select', {
        'aria-label': label ? label + ' · ' + t('pickModel') : t('pickModel'),
        title: v.model || '',
        value: v.model || '',
        style: ctrlStyle,
        disabled: locked,
        onChange: (e) => onChange({ ...v, model: e.target.value }),
      }, ...modelChildren),
      h('select', {
        'aria-label': label ? label + ' · ' + t('effortDefault') : t('effortDefault'),
        value: v.reasoningEffort || '',
        style: ctrlStyle,
        disabled: locked,
        onChange: (e) => onChange({ ...v, reasoningEffort: e.target.value }),
      }, effortChoices.map(([val, text]) => h('option', { key: val || '__default', value: val }, text))),
    ),
    // 目录状态单独一行小字：放在 select 的 title 里在触屏上根本看不到。
    status
      ? h('div', {
        style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: 3 },
      }, status)
      : null,
  )
}

// ---- src/client/30-strategy.js ----
// 三档模型卡片之一（低 / 中 / 高）+ 该档的峰谷表编辑器。
//
// 组件名沿用 `StrategyEditor`：scripts/catalog-refresh.test.mjs 只加载 40-settings.js
// 并把这个名字注册成 stub 组件，它断言「刷新目录不会重载草稿」时依赖该名字被渲染。
// 改名会让那条断言失配（该测试不在本任务的写域内），所以这里保留名字、按设计文档
// §7.1 重做成「档位卡片」（语义仍是「一条策略」：谷时目标 + 峰时子表）。
//
// 布局：
//   档位标题
//   中/高档：[x] 跟随低档（勾选时只读展示继承值）
//   谷时模型  [provider][model][effort]
//   [x] 成本决策（关闭时峰时子区置灰但保留数据）
//   [x] 启用峰时  星期[一..日]  窗口[09:00–12:00][+]
//   峰时模型  [provider][model][effort]
//
// props:
//   tier        — 'low' | 'mid' | 'high'
//   target      — canonical 档位对象 { valley, costRouting, peak } 或 { share: 'low' }
//   effective   — 解析后的档位对象（共享时 = low；只读展示用）
//   shared      — 是否为「跟随低档」
//   providers / models / modelsLoading / modelsError / onNeedModels
//   onChange(next)      — 提交整个档位对象（父级负责写回 config.targets[tier]）
//   onShareChange(bool) — 勾选/取消「跟随低档」
//   t / narrow

// 星期多选（1=周一 … 7=周日）。标签来自 lib/text.js 的 weekdayShort。
function WeekdayPicker(props) {
  const h = React.createElement
  const { value, onChange, t, disabled } = props
  const names = weekdayLabels(t)
  const picked = Array.isArray(value) ? value : []
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 10, opacity: disabled ? 0.6 : 1 } },
    [1, 2, 3, 4, 5, 6, 7].map((d) => h('label', {
      key: d,
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, lineHeight: '20px', whiteSpace: 'nowrap' },
    },
      h('input', {
        type: 'checkbox',
        checked: picked.includes(d),
        disabled: disabled === true,
        onChange: (e) => {
          const set = new Set(picked)
          if (e.target.checked) set.add(d)
          else set.delete(d)
          onChange([...set].sort((a, b) => a - b))
        },
      }),
      h('span', null, names[d - 1] || String(d)),
    )),
  )
}

// 峰时窗口编辑：一行一个 [start, end]，开始含、结束不含；不支持跨午夜。
// 合法性与服务端一致（start < end），非法行就地提示，不静默丢数据。
function WindowEditor(props) {
  const h = React.createElement
  const { windows, onChange, t, disabled } = props
  const list = Array.isArray(windows) ? windows : []
  const timeStyle = { width: 104, boxSizing: 'border-box' }
  const invalid = windowsInvalid(list)
  return h('div', { style: { minWidth: 0 } },
    h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 } }, t('peakWindowsTitle')),
    list.length === 0
      ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #999)', marginBottom: 6 } }, t('peakWindowsEmpty'))
      : null,
    list.map((w, i) => h('div', {
      key: i,
      style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6, opacity: disabled ? 0.6 : 1 },
    },
      h('input', {
        type: 'time',
        step: 60,
        value: w && w[0] ? String(w[0]) : '',
        'aria-label': t('peakWindowStart'),
        disabled: disabled === true,
        onChange: (e) => onChange(list.map((x, j) => (j === i ? [e.target.value, x[1]] : x))),
        style: timeStyle,
      }),
      h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } }, '-'),
      h('input', {
        type: 'time',
        step: 60,
        value: w && w[1] ? String(w[1]) : '',
        'aria-label': t('peakWindowEnd'),
        disabled: disabled === true,
        onChange: (e) => onChange(list.map((x, j) => (j === i ? [x[0], e.target.value] : x))),
        style: timeStyle,
      }),
      h('button', {
        onClick: () => onChange(list.filter((_, j) => j !== i)),
        disabled: disabled === true,
        title: t('remove'),
        style: { padding: '2px 8px' },
      }, t('remove')),
    )),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('button', {
        onClick: () => onChange([...list, ['09:00', '12:00']]),
        disabled: disabled === true,
        style: { padding: '2px 8px' },
      }, t('peakWindowAdd')),
      invalid
        ? h('span', { role: 'alert', style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary, #c00)' } }, t('peakWindowInvalid'))
        : null,
    ),
  )
}

// 窗口是否全部合法（HH:MM 且 start < end）。供卡片与保存前校验共用。
function windowsInvalid(windows) {
  const list = Array.isArray(windows) ? windows : []
  return list.some((w) => {
    if (!Array.isArray(w) || w.length < 2) return true
    const start = String(w[0] || '')
    const end = String(w[1] || '')
    if (!timeValid(start) || !timeValid(end)) return true
    return minutesOfTime(start) >= minutesOfTime(end)
  })
}

function timeValid(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))
}

function minutesOfTime(value) {
  const [h, m] = String(value).split(':').map((n) => Number(n))
  return h * 60 + m
}

// 只读摘要：共享档位时把继承到的峰谷表说清楚（不让用户以为「跟随」= 没配置）。
function InheritedPeakSummary({ t, effective }) {
  const h = React.createElement
  const peak = effective && effective.peak ? effective.peak : {}
  const windows = Array.isArray(peak.windows) ? peak.windows : []
  const windowsText = windows.length === 0
    ? t('peakWindowsEmpty')
    : windows.map((w) => `${w[0]}-${w[1]}`).join(', ')
  return h('div', {
    style: {
      borderLeft: '2px solid var(--dsw-alias-border-l3, #d8d8d8)',
      paddingLeft: 10,
      marginTop: 8,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, #666)',
      minWidth: 0,
    },
  },
    h('div', null, t('valleyModel') + ': ' + tripleText(effective && effective.valley)),
    h('div', null, t('costRoutingLabel') + ': ' + (effective && effective.costRouting === false ? t('off') : t('on'))),
    h('div', null, (peak.enabled === true ? t('peakEnabledOn') : t('peakEnabledOff')) + ': ' + (peak.provider || peak.model ? tripleText(peak) : t('reasonNone'))),
    h('div', { style: { wordBreak: 'break-word' } }, t('peakWindowsTitle') + ': ' + windowsText),
  )
}

function tripleText(triple) {
  const value = triple && typeof triple === 'object' ? triple : {}
  const provider = value.provider ? String(value.provider) : ''
  const model = value.model ? String(value.model) : ''
  if (!provider && !model) return '-'
  return `${provider}/${model}${value.reasoningEffort ? '@' + value.reasoningEffort : ''}`
}

function StrategyEditor(props) {
  const h = React.createElement
  const {
    tier, target, effective, shared, providers, models, modelsLoading, modelsError,
    onNeedModels, onChange, onShareChange, t, narrow,
  } = props
  const current = target && typeof target === 'object' ? target : {}
  const shown = shared ? (effective || {}) : current
  const valley = shown.valley || {}
  const peak = shown.peak || {}
  const costRouting = shown.costRouting !== false
  const peakEnabled = peak.enabled === true

  const labelStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 }
  const cardStyle = {
    border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
  }
  const setValley = (next) => onChange({ ...current, valley: next })
  const setPeak = (patch) => onChange({ ...current, peak: { ...peak, ...patch } })

  return h('div', { style: cardStyle, 'data-tier': tier },
    h('div', { style: { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 8 } }, t(tierLabelKey(tier))),

    tier !== 'low'
      ? h('div', { style: { marginBottom: 10 } },
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: shared === true,
            onChange: (e) => onShareChange(e.target.checked),
          }),
          h('span', null, t('shareLow')),
        ),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: 2 } }, t('shareLowHint')),
        shared ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: 2 } }, t('shareLowInherited')) : null,
      )
      : null,

    shared
      ? h(InheritedPeakSummary, { effective, t })
      : h('div', { style: { minWidth: 0 } },
        h(ModelPicker, {
          label: t('valleyModel'),
          value: valley,
          providers,
          models,
          modelsLoading: modelsLoading && modelsLoading[valley.provider],
          modelsError: modelsError && modelsError[valley.provider],
          onNeedModels,
          onChange: setValley,
          t,
          narrow,
        }),

        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', marginTop: 10, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: costRouting,
            onChange: (e) => onChange({ ...current, costRouting: e.target.checked }),
          }),
          h('span', null, t('costRoutingLabel')),
        ),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', margin: '2px 0 0' } }, t('costRoutingHint')),

        // 峰时子区：成本决策关闭时整体置灰但保留数据（设计 §7.2），不删窗口。
        h('div', {
          style: {
            borderLeft: '2px solid var(--dsw-alias-border-l3, #d8d8d8)',
            paddingLeft: 10,
            marginTop: 10,
            opacity: costRouting ? 1 : 0.55,
            minWidth: 0,
          },
        },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', cursor: costRouting ? 'pointer' : 'default' } },
            h('input', {
              type: 'checkbox',
              checked: peakEnabled,
              disabled: !costRouting,
              onChange: (e) => setPeak({ enabled: e.target.checked }),
            }),
            h('span', null, t('enablePeak')),
          ),
          h('div', { style: { ...labelStyle, marginTop: 8 } }, t('weekdays')),
          h(WeekdayPicker, {
            value: peak.weekdays,
            disabled: !costRouting,
            onChange: (next) => setPeak({ weekdays: next }),
            t,
          }),
          h(WindowEditor, {
            windows: peak.windows,
            disabled: !costRouting,
            onChange: (next) => setPeak({ windows: next }),
            t,
          }),
          h('div', { style: { marginTop: 10 } },
            h(ModelPicker, {
              label: t('peakModel'),
              value: { provider: peak.provider, model: peak.model, reasoningEffort: peak.reasoningEffort },
              providers,
              models,
              modelsLoading: modelsLoading && modelsLoading[peak.provider],
              modelsError: modelsError && modelsError[peak.provider],
              onNeedModels,
              onChange: (next) => setPeak({ provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort }),
              t,
              narrow,
              disabled: !costRouting,
            }),
          ),
        ),
      ),
  )
}

function tierLabelKey(tier) {
  if (tier === 'mid') return 'tierMid'
  if (tier === 'high') return 'tierHigh'
  return 'tierLow'
}

// ---- src/client/40-settings.js ----
// 设置页「避峰岗」区块（0.16 三档版）。
// 布局与文案见 docs/ROUTING_V2_DESIGN.md §7.1 与附录 B：
//   [状态区] 此刻生效 / 告警 / 冲突
//   [A] 智能程度路由（默认关）+ 阈值 + 样例试算
//   [B] 三档模型（低/中/高；中高默认「跟随低档」）
//   [C] 峰谷与节假日（时区偏移 + 节假日增删 + 整年导入）
//   [D] 高级模型支援（max）
//   [E] 诊断（刷新模型列表 / 恢复原模型 / 最近决策）
//   [保存] [重新加载]
//
// 三条硬约束：
// 1) 所有界面文案走 lib/text.js（copy.test.mjs 会扫硬编码中文）。
// 2) 目录（providers/models）刷新失败不阻塞保存；刷新也**绝不**重载正在编辑的草稿。
// 3) 保存是唯一写入口，且不做任何会阻塞保存的隐式刷新（设计 §7.2）。

function pvErrorText(e) {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    try { return JSON.stringify(e) } catch (err) { return String(e) }
  }
  return e == null ? '' : String(e)
}

// 0.15 的英文技术文案 → 当前语言（v1 迁移期与服务端旧校验仍可能出现）。
// 认不出来的一律原文照显，绝不把信息吞掉或误译。
function pvStrategyIssueText(issue, t) {
  if (/needs a primary provider and a primary model/i.test(issue)) return t('errNeedBoth')
  if (/needs a primary model/i.test(issue)) return t('errNeedModel')
  if (/needs a primary provider/i.test(issue)) return t('errNeedProvider')
  if (/is not a strategy object/i.test(issue)) return t('errBadStrategy')
  if (/invalid primary model/i.test(issue)) return t('errBadPrimary')
  return issue
}

function pvSaveErrorText(raw, t) {
  const text = pvErrorText(raw)
  if (!text) return ''
  if (/advanced model support/i.test(text)) return t('errAdvancedSupport')
  const parts = []
  const re = /strategy #(\d+)\s+([^;]+?)(?=\s+—|;|$)/g
  let match
  while ((match = re.exec(text)) !== null) {
    // 先从措辞里剥掉「(+N more)」，否则未知措辞会把它并进原文再追加一次计数。
    const issue = match[2].replace(/\s*\(\+\d+ more\)\s*$/, '').trim()
    parts.push(t('errStrategy', { index: match[1], issue: pvStrategyIssueText(issue, t) }))
  }
  if (parts.length === 0) return text
  const more = /\(\+(\d+) more\)/.exec(text)
  return parts.join(t('errSeparator')) + (more ? t('errMore', { count: more[1] }) : '')
}

// ---------- 纯数据整形（全部放在本文件，便于 scripts/catalog-refresh.test.mjs
// 单独加载本文件时也能完整渲染） ----------

const PV_TIERS = ['low', 'mid', 'high']
const PV_TIER_LABEL_KEY = { low: 'tierLow', mid: 'tierMid', high: 'tierHigh' }
const PV_FALLBACK_WINDOWS = [['09:00', '12:00'], ['14:00', '18:00']]
const PV_FALLBACK_WEEKDAYS = [1, 2, 3, 4, 5]
const PV_DEFAULT_CONCRETE = 0.55
const PV_DEFAULT_MEDIUM = 0.28

function pvStr(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function pvNum(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pvTriple(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = { provider: pvStr(src.provider), model: pvStr(src.model) }
  const effort = pvStr(src.reasoningEffort)
  if (effort) out.reasoningEffort = effort
  return out
}

function pvTripleText(triple) {
  const value = triple && typeof triple === 'object' ? triple : {}
  const provider = pvStr(value.provider)
  const model = pvStr(value.model)
  if (!provider && !model) return '-'
  return `${provider}/${model}${value.reasoningEffort ? '@' + value.reasoningEffort : ''}`
}

function pvWeekdays(raw, fallback) {
  const base = Array.isArray(fallback) ? fallback : PV_FALLBACK_WEEKDAYS
  if (!Array.isArray(raw)) return base.slice()
  const out = []
  for (const item of raw) {
    const n = Math.trunc(Number(item))
    if (n >= 1 && n <= 7 && out.indexOf(n) < 0) out.push(n)
  }
  return out.sort((a, b) => a - b)
}

function pvWindows(raw, fallback) {
  const base = Array.isArray(fallback) ? fallback : []
  if (!Array.isArray(raw)) return base.slice()
  const out = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue
    out.push([pvStr(item[0]), pvStr(item[1])])
  }
  return out
}

function pvTimeValid(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(pvStr(value))
}

function pvMinutesOf(value) {
  const [h, m] = pvStr(value).split(':').map((n) => Number(n))
  return h * 60 + m
}

// start < end（含 start、不含 end；不跨午夜）——与服务端一致。
function pvWindowsInvalid(windows) {
  const list = Array.isArray(windows) ? windows : []
  return list.some((w) => {
    if (!Array.isArray(w) || w.length < 2) return true
    if (!pvTimeValid(w[0]) || !pvTimeValid(w[1])) return true
    return pvMinutesOf(w[0]) >= pvMinutesOf(w[1])
  })
}

function pvHolidayValid(year, month, day) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (!Number.isInteger(day) || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function pvHolidayKey(item) {
  return item[0] * 10000 + item[1] * 100 + item[2]
}

function pvNormalizeHolidays(raw) {
  if (!Array.isArray(raw)) return []
  const seen = Object.create(null)
  const out = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) continue
    const year = Math.trunc(Number(item[0]))
    const month = Math.trunc(Number(item[1]))
    const day = Math.trunc(Number(item[2]))
    if (!pvHolidayValid(year, month, day)) continue
    const key = pvHolidayKey([year, month, day])
    if (seen[key]) continue
    seen[key] = true
    out.push([year, month, day])
  }
  return out.sort((a, b) => pvHolidayKey(a) - pvHolidayKey(b))
}

function pvDateRange(year, month, fromDay, toDay) {
  const out = []
  for (let day = fromDay; day <= toDay; day += 1) out.push([year, month, day])
  return out
}

// 内置节假日预设：2026/2027 与 lib/text.js 的 DEFAULTS.holidays 一致（单一事实来源
// 是 text.js，改默认值时要同步这里）；2025 为公开的放假安排，仅作示例。
// 目的只有一个：让「整年导入」可用，用户仍可逐条改。
const PV_HOLIDAY_PRESETS = {
  2025: [].concat(
    [[2025, 1, 1]],
    pvDateRange(2025, 1, 28, 31),
    pvDateRange(2025, 2, 1, 4),
    pvDateRange(2025, 4, 4, 6),
    pvDateRange(2025, 5, 1, 5),
    pvDateRange(2025, 5, 31, 31),
    pvDateRange(2025, 6, 1, 2),
    pvDateRange(2025, 10, 1, 8),
  ),
  2026: pvDateRange(2026, 10, 1, 8),
  2027: pvDateRange(2027, 1, 1, 3),
}

function pvNormalizeTier(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const peakSrc = src.peak && typeof src.peak === 'object' ? src.peak : {}
  return {
    valley: pvTriple(src.valley !== undefined ? src.valley : src.primary),
    costRouting: src.costRouting !== false,
    peak: {
      enabled: peakSrc.enabled === true,
      weekdays: pvWeekdays(peakSrc.weekdays, pvWeekdays(src.weekdays, PV_FALLBACK_WEEKDAYS)),
      windows: pvWindows(peakSrc.windows, []),
      ...pvTriple(peakSrc),
    },
  }
}

function pvTierRouting(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: src.enabled === true,
    concreteThreshold: pvNum(src.concreteThreshold, PV_DEFAULT_CONCRETE),
    mediumThreshold: pvNum(src.mediumThreshold, PV_DEFAULT_MEDIUM),
  }
}

// 把服务端（或旧草稿）下发的任意形状收敛成「可渲染的 canonical v2 草稿」。
// 幂等：对已经是 v2 的输入不做任何语义改动。v1 形状只是兼容显示（0.15 服务端、
// 旧 policy.json 的 in-memory 视图），一旦保存就按 v2 提交。
function pvDraftFrom(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const draft = {
    schemaVersion: 2,
    utcOffsetMinutes: pvNum(src.utcOffsetMinutes, 480),
    holidays: pvNormalizeHolidays(src.holidays),
    tierRouting: pvTierRouting(src.tierRouting),
    targets: {},
    advancedSupport: pvTriple(src.advancedSupport !== undefined ? src.advancedSupport : src.exclusive),
  }
  if (src.targets && typeof src.targets === 'object') {
    draft.targets.low = pvNormalizeTier(src.targets.low)
    for (const tier of ['mid', 'high']) {
      const item = src.targets[tier]
      draft.targets[tier] = item && item.share === 'low' ? { share: 'low' } : pvNormalizeTier(item)
    }
    // v1 迁移快照（只读、不参与路由）。节点只在首次保存时写入，GUI 必须原样带回，
    // 否则一次保存就把迁移前的 strategies 快照永久丢了。
    if (src.legacy && typeof src.legacy === 'object') draft.legacy = JSON.parse(JSON.stringify(src.legacy))
    return draft
  }
  const strategies = Array.isArray(src.strategies) ? src.strategies : []
  const first = strategies[0] && typeof strategies[0] === 'object' ? strategies[0] : {}
  const firstPeak = first.peak && typeof first.peak === 'object' ? first.peak : {}
  const peakSource = firstPeak.provider || firstPeak.model ? firstPeak : first.primary
  draft.targets.low = {
    valley: pvTriple(first.primary),
    costRouting: true,
    peak: {
      enabled: firstPeak.enabled === true,
      weekdays: pvWeekdays(firstPeak.weekdays, pvWeekdays(first.weekdays, PV_FALLBACK_WEEKDAYS)),
      windows: pvWindows(firstPeak.windows, PV_FALLBACK_WINDOWS),
      ...pvTriple(peakSource),
    },
  }
  draft.targets.mid = { share: 'low' }
  draft.targets.high = {
    valley: pvTriple(draft.advancedSupport),
    costRouting: true,
    peak: {
      enabled: false,
      weekdays: draft.targets.low.peak.weekdays.slice(),
      windows: draft.targets.low.peak.windows.slice(),
      provider: draft.advancedSupport.provider || '',
      model: draft.advancedSupport.model || '',
    },
  }
  return draft
}

function pvIsShared(draft, tier) {
  const item = draft && draft.targets ? draft.targets[tier] : null
  return Boolean(item && item.share === 'low')
}

function pvResolveTarget(draft, tier) {
  const targets = draft && draft.targets ? draft.targets : {}
  const item = targets[tier]
  if (item && item.share === 'low') return targets.low
  return item || pvNormalizeTier(null)
}

// 取消「跟随低档」时，把当前继承值复制成独立配置（用户可继续改）。
function pvCopyTarget(target) {
  return JSON.parse(JSON.stringify(target || pvNormalizeTier(null)))
}

// 配置里被引用到的 provider id，用于优先拉取模型（失败不影响保存）。
function pvUsedProviderIds(draft) {
  const used = new Set()
  const add = (holder) => {
    const id = holder && holder.provider ? String(holder.provider) : ''
    if (id) used.add(id)
  }
  const targets = draft && draft.targets ? draft.targets : {}
  add(draft && draft.advancedSupport)
  for (const tier of PV_TIERS) {
    const item = targets[tier]
    if (!item || item.share === 'low') continue
    add(item.valley)
    add(item.peak)
  }
  return used
}

// 提交给 set 的 canonical payload：共享档只提交 { share: 'low' }，不夹带继承值。
function pvSavePayload(draft) {
  const targets = {}
  for (const tier of PV_TIERS) {
    const item = draft && draft.targets ? draft.targets[tier] : null
    targets[tier] = item && item.share === 'low' ? { share: 'low' } : pvNormalizeTier(item)
  }
  const payload = {
    schemaVersion: 2,
    utcOffsetMinutes: pvNum(draft && draft.utcOffsetMinutes, 480),
    holidays: pvNormalizeHolidays(draft && draft.holidays),
    tierRouting: pvTierRouting(draft && draft.tierRouting),
    targets,
    advancedSupport: pvTriple(draft && draft.advancedSupport),
  }
  if (draft && draft.legacy && typeof draft.legacy === 'object') payload.legacy = draft.legacy
  return payload
}

// 保存前的本地校验：只拦「一定能看出错」的情况，其余交给服务端（服务端是权威）。
function pvValidationError(draft, t) {
  const tr = pvTierRouting(draft && draft.tierRouting)
  const inRange = (n) => Number.isFinite(n) && n >= 0 && n <= 1
  if (!inRange(tr.concreteThreshold) || !inRange(tr.mediumThreshold)) return t('errThresholdRange')
  if (!(tr.concreteThreshold > tr.mediumThreshold)) return t('errThresholdOrder')
  const targets = draft && draft.targets ? draft.targets : {}
  for (const tier of PV_TIERS) {
    const item = targets[tier]
    if (!item || item.share === 'low') continue
    const label = t(PV_TIER_LABEL_KEY[tier])
    const valley = item.valley || {}
    if (!valley.provider || !valley.model) return t('errTargetIncomplete', { tier: label })
    if (pvWindowsInvalid(item.peak && item.peak.windows)) return t('peakWindowInvalid')
    const peak = item.peak || {}
    if (item.costRouting !== false && peak.enabled === true && (!peak.provider || !peak.model)) {
      return t('errTargetIncomplete', { tier: label })
    }
  }
  const advanced = pvTriple(draft && draft.advancedSupport)
  if (!advanced.provider || !advanced.model) return t('errAdvancedSupport')
  return ''
}

// ---------- 原因 / 告警文案映射（未知值一律降级，不崩） ----------

function pvTierReasonText(reason, t) {
  switch (reason) {
    case 'tier-disabled': return t('tierReasonDisabled')
    case 'tier-low': return t('tierReasonLow')
    case 'tier-mid': return t('tierReasonMid')
    case 'tier-high': return t('tierReasonHigh')
    case 'override-high-safety': return t('tierReasonOverrideSafety')
    case 'override-high-explicit': return t('tierReasonOverrideHigh')
    case 'override-low-explicit': return t('tierReasonOverrideLow')
    case 'tier-fallback-low': return t('tierReasonFallbackLow')
    case 'max-advanced': return t('tierReasonMax')
    default: return ''
  }
}

function pvCostReasonText(reason, t) {
  switch (reason) {
    case 'peak': return t('costReasonPeak')
    case 'valley': return t('costReasonValley')
    case 'cost-off': return t('costReasonCostOff')
    case 'peak-disabled': return t('costReasonPeakDisabled')
    case 'peak-weekday': return t('costReasonWeekday')
    case 'peak-holiday': return t('costReasonHoliday')
    case 'peak-outside': return t('costReasonOutside')
    default: return ''
  }
}

function pvOutcomeText(outcome, t) {
  switch (outcome) {
    case 'selected': return t('outcomeSelected')
    case 'noop-same': return t('outcomeNoop')
    case 'unroutable': return t('outcomeUnroutable')
    case 'select-failed': return t('outcomeSelectFailed')
    case 'host-unsupported': return t('outcomeDisabled')
    case 'disabled': return t('outcomeDisabled')
    default: return ''
  }
}

function pvWarningKindText(kind, t) {
  switch (kind) {
    case 'provider': return t('warnKindProvider')
    case 'model': return t('warnKindModel')
    case 'effort': return t('warnKindEffort')
    case 'missing': return t('warnKindMissing')
    case 'unverified': return t('warnKindUnverified')
    case 'llm-unavailable': return t('warnKindLlmUnavailable')
    case 'select-failed': return t('warnKindSelectFailed')
    case 'no-current': return t('warnKindNoCurrent')
    case 'host-unsupported': return t('warnKindHostUnsupported')
    case 'request-failed': return t('warnKindRequestFailed')
    case 'sync-read-failed': return t('warnKindSyncReadFailed')
    case 'state-write-failed': return t('warnKindStateWriteFailed')
    case 'default-seam-missing': return t('warnKindDefaultSeamMissing')
    case 'legacy-extra-strategies': return t('warnKindLegacyExtra')
    case 'invalid-holidays': return t('warnKindInvalidHolidays')
    default: return t('warnKindOther')
  }
}

function pvWarningText(warning, t) {
  if (!warning || typeof warning !== 'object') return ''
  const kind = pvStr(warning.kind)
  const target = pvTripleText(warning.target)
  const kept = pvTripleText(warning.kept)
  if (kind === 'unverified') return t('warningUnverified', { target })
  if (kind === 'llm-unavailable') return t('warningLlmUnavailable')
  if (kind === 'host-unsupported') return t('warningHostUnsupported')
  // v1 迁移：strategies[1..] 不再参与路由（只读 legacy 快照），必须让用户看见。
  if (kind === 'legacy-extra-strategies') return t('warningLegacyExtra', { count: pvNum(warning.extraCount, 0) })
  // 服务端过滤掉非法节假日（t18）：走既有横幅，不新增专用 UI。
  if (kind === 'invalid-holidays') return t('warningInvalidHolidays')
  if (kind === 'select-failed' || kind === 'no-current' || kind === 'request-failed'
    || kind === 'provider' || kind === 'model' || kind === 'effort' || kind === 'missing') {
    return t('warningUnroutable', { target, kind: pvWarningKindText(kind, t), kept: kept === '-' ? '-' : kept })
  }
  return t('warningGeneric', { kind: pvWarningKindText(kind, t), target })
}

// 「此刻生效」：目标 + 档位来源 + costRouting 原因，一段话解释清楚。
// 同时兼容 0.16 的 Decision 形状与 0.15 的扁平 active。
function pvActiveParts(active, t) {
  if (!active || typeof active !== 'object') return []
  const target = active.target && typeof active.target === 'object' ? active.target : active
  const parts = [pvTripleText(target)]
  if (active.axis === 'max') parts.push(t('axisMax'))
  const tier = active.tier === 'low' || active.tier === 'mid' || active.tier === 'high' ? active.tier : ''
  if (tier) parts.push(t(PV_TIER_LABEL_KEY[tier]))
  const tierReason = pvTierReasonText(active.tierReason, t)
  // tier-low/mid/high 与档位标签本身重复，不再重复一遍。
  const redundant = active.tierReason === 'tier-low' || active.tierReason === 'tier-mid' || active.tierReason === 'tier-high'
  if (tierReason && !redundant) parts.push(tierReason)
  else if (active.reason === 'advanced-max') parts.push(t('tierReasonMax'))
  else if (active.reason === 'primary') parts.push(t('tierReasonDisabled'))
  const cost = pvCostReasonText(active.costReason, t)
  if (cost) parts.push(cost)
  else if (active.reason === 'peak') parts.push(t('costReasonPeak'))
  if (active.fallback === 'low') parts.push(t('fallbackLow'))
  return parts
}

const PV_FEATURE_KEYS = {
  code: 'featureCode',
  path: 'featurePath',
  command: 'featureCommand',
  symbol: 'featureSymbol',
  verb: 'featureVerb',
  'multi-question': 'featureMulti',
  abstract: 'featureAbstract',
  long: 'featureLong',
  short: 'featureShort',
  'short-command': 'featureShortCommand',
  image: 'featureImage',
  'mid-turn': 'featureMidTurn',
  'override-safety': 'featureOverrideSafety',
  'override-high': 'featureOverrideHigh',
  'override-low': 'featureOverrideLow',
  target: 'featureTarget',
  sequence: 'featureSequence',
}

function pvFeatureId(feature) {
  if (typeof feature === 'string') return feature
  if (feature && typeof feature === 'object') return pvStr(feature.id || feature.key || feature.label)
  return ''
}

function pvFeatureText(feature, t) {
  const id = pvFeatureId(feature)
  const key = PV_FEATURE_KEYS[id]
  return key ? t(key) : id
}

function pvTierLabel(tier, t) {
  return t(PV_TIER_LABEL_KEY[tier] || 'tierLow')
}

// 首次使用判定：node 端下发 get.firstRun 时以它为准；尚未下发时按 revision 兜底
// 推断——新装/从未保存过 policy.json 时 revision 仍是 DEFAULTS 的 1，首次保存后
// node 端会 +1。兜底只是过渡（t18/core 落地 firstRun 后自动优先用字段），
// 未知形状一律 false（不误导已有用户）。
function pvFirstRunState(res) {
  if (!res || typeof res !== 'object') return false
  if (typeof res.firstRun === 'boolean') return res.firstRun
  // v1 policy.json 被内存迁移后一定带 legacy 快照（lib/routing.js#migrateV1），
  // 说明是老用户升级上来而不是新装：不要用 revision=1 误判成首次使用。
  if (res.config && typeof res.config === 'object' && res.config.legacy && typeof res.config.legacy === 'object') return false
  const revision = typeof res.configRevision === 'number'
    ? res.configRevision
    : (res.config && typeof res.config.revision === 'number' ? res.config.revision : undefined)
  if (typeof revision !== 'number') return false
  return revision <= 1
}

// 节假日编辑器（无内部状态：日期输入与年份选择由父级持有）。
function PvHolidayEditor(props) {
  const h = React.createElement
  const { holidays, input, year, onInput, onYear, onAdd, onRemove, onImport, t } = props
  const list = Array.isArray(holidays) ? holidays : []
  const years = Object.keys(PV_HOLIDAY_PRESETS).map((y) => Number(y)).sort()
  const chosen = Number(year) || years[years.length - 1] || new Date().getFullYear()
  const hasPreset = Object.prototype.hasOwnProperty.call(PV_HOLIDAY_PRESETS, chosen)
  const groups = []
  for (const item of list) {
    const last = groups[groups.length - 1]
    if (last && last.year === item[0]) last.days.push(item)
    else groups.push({ year: item[0], days: [item] })
  }
  return h('div', { style: { minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
      h('input', {
        type: 'date',
        min: '2000-01-01',
        max: '2100-12-31',
        value: input || '',
        'aria-label': t('holidayAdd'),
        onChange: (e) => onInput(e.target.value),
        style: { width: 160, boxSizing: 'border-box' },
      }),
      h('button', { onClick: onAdd, style: { padding: '2px 8px' } }, t('holidayAdd')),
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('holidayPresetLabel')),
      h('select', {
        value: String(chosen),
        'aria-label': t('holidayPresetLabel'),
        onChange: (e) => onYear(e.target.value),
      }, years.map((y) => h('option', { key: y, value: String(y) }, String(y)))),
      h('button', {
        onClick: () => onImport(chosen),
        disabled: !hasPreset,
        style: { padding: '2px 8px' },
      }, t('holidayPresetAdd', { year: chosen })),
    ),
    hasPreset
      ? null
      : h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-warn-label, #8a6100)', marginBottom: 6 } }, t('holidayPresetMissing', { year: chosen })),
    list.length === 0
      ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('holidayEmpty'))
      : h('div', null, groups.map((group) => h('div', { key: group.year, style: { marginBottom: 4 } },
        h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginRight: 6 } }, String(group.year)),
        group.days.map((item) => h('span', {
          key: pvHolidayKey(item),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            margin: '0 6px 4px 0',
            padding: '0 6px',
            borderRadius: 999,
            fontSize: 12,
            lineHeight: '20px',
            background: 'var(--dsw-alias-interactive-bg-hover, #f0f0f0)',
          },
        },
          h('span', null, `${item[0]}-${String(item[1]).padStart(2, '0')}-${String(item[2]).padStart(2, '0')}`),
          h('button', {
            onClick: () => onRemove(item[0], item[1], item[2]),
            title: t('remove'),
            style: { padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' },
          }, 'x'),
        )),
      ))),
  )
}

function PolicySettingsSection({ rpc, t }) {
  const h = React.createElement
  // 第一个 useState 必须是 config：scripts/catalog-refresh.test.mjs 直接替换 cells[0]
  // 来注入草稿，其余钩子顺序必须稳定。
  const [config, setConfig] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [providers, setProviders] = useState([])
  const [providersError, setProvidersError] = useState('')
  const [models, setModels] = useState({})
  const [modelsLoading, setModelsLoading] = useState({})
  const [modelsError, setModelsError] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [version, setVersion] = useState('')
  const [active, setActive] = useState(null)
  const [host, setHost] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [recentWarnings, setRecentWarnings] = useState([])
  // 首次使用引导：firstRun 来自 get（true = 用户还没保存过 policy.json）；
  // guideDismissed 只存会话内存（不落盘），保存成功后引导也必须消失。
  const [firstRun, setFirstRun] = useState(null)
  const [guideDismissed, setGuideDismissed] = useState(false)
  const [recentDecisions, setRecentDecisions] = useState([])
  const [sessionDetails, setSessionDetails] = useState({})
  const [restoring, setRestoring] = useState('')
  const [savedAt, setSavedAt] = useState('')
  const [toast, setToast] = useState('')
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [conflict, setConflict] = useState(null)
  const [probeText, setProbeText] = useState('')
  const [probeResult, setProbeResult] = useState(null)
  const [probeError, setProbeError] = useState('')
  const [probeBusy, setProbeBusy] = useState(false)
  const [baseRevision, setBaseRevision] = useState(undefined)
  const [holidayInput, setHolidayInput] = useState('')
  const [holidayYear, setHolidayYear] = useState('')
  const [sectionRef, narrow] = useContainerWidth(640)
  const catalogRefresh = useRef(false)
  const requested = useRef({})
  // ---- 跨窗口同步（设计 §6.3）：3 秒整份 get 轮询 + 草稿保护 ----
  // busyRef：保存进行中不做 adopt，避免「刚保存的成功回包」和轮询互相覆盖。
  // seenRevisionRef：已经处理过的 configRevision，避免同一个外部变更每 3 秒重设状态。
  // baseConfigJson：最近一次「已采纳」的 canonical 配置（脏检查基线）。
  // draftJsonRef：当前草稿的 canonical 序列化（每次渲染后同步，供轮询回调读取）。
  const busyRef = useRef(false)
  const pollingRef = useRef(false)
  const seenRevisionRef = useRef(undefined)
  const baseConfigJson = useRef('')
  const draftJsonRef = useRef('')

  // 拉取单个 provider 的模型：requested 去重；失败后清除标记以便重试。
  const fetchModels = useCallback(async (providerId) => {
    const id = providerId ? String(providerId) : ''
    if (!id || requested.current[id]) return
    requested.current[id] = true
    setModelsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const list = await rpc.models(id)
      setModels((prev) => ({ ...prev, [id]: Array.isArray(list) ? list : [] }))
      setModelsError((prev) => {
        if (!prev[id]) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (e) {
      requested.current[id] = false
      setModels((prev) => (Array.isArray(prev[id]) ? prev : { ...prev, [id]: [] }))
      setModelsError((prev) => ({ ...prev, [id]: pvErrorText(e) }))
    } finally {
      setModelsLoading((prev) => {
        if (!prev[id]) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }, [rpc])

  const loadProviders = useCallback(async () => {
    try {
      const res = await rpc.providers()
      const list = pvNormalizeProviders(res)
      setProviders(list)
      setProvidersError('')
      return list
    } catch (e) {
      // Keep the last usable catalog when a refresh fails.
      setProvidersError(pvErrorText(e))
      return []
    }
  }, [rpc])

  const load = useCallback(async () => {
    setLoadError('')
    setSaveError('')
    setSavedAt('')
    setToast('')
    setConflict(null)
    setProvidersError('')
    setModelsError({})
    setModelsLoading({})
    requested.current = {}
    let res
    try {
      res = await rpc.get()
    } catch (e) {
      // get 失败：给出错误 + 重试，而不是白屏。
      setConfig(null)
      setLoadError(pvErrorText(e))
      return
    }
    setVersion(res && typeof res.version === 'string' ? res.version : '')
    setActive(res && res.active && typeof res.active === 'object' ? res.active : null)
    setHost(res && res.host && typeof res.host === 'object' ? res.host : null)
    setWarnings(res && Array.isArray(res.warnings) ? res.warnings : [])
    setRecentWarnings(res && Array.isArray(res.recentWarnings) ? res.recentWarnings : [])
    setRecentDecisions(res && Array.isArray(res.recentDecisions) ? res.recentDecisions : [])
    setSessionDetails(res && res.sessionDetails && typeof res.sessionDetails === 'object' ? res.sessionDetails : {})
    setBaseRevision(res && typeof res.configRevision === 'number' ? res.configRevision : undefined)
    setFirstRun(pvFirstRunState(res))
    const raw = res && res.config !== undefined ? res.config : res
    const draft = pvDraftFrom(raw)
    setConfig(draft)
    // 采纳新配置：重置脏检查基线与「已见 revision」。
    baseConfigJson.current = JSON.stringify(pvSavePayload(draft))
    draftJsonRef.current = baseConfigJson.current
    seenRevisionRef.current = res && typeof res.configRevision === 'number' ? res.configRevision : undefined
    const used = [...pvUsedProviderIds(draft)]
    const list = await loadProviders()
    // 1) 配置里用到的 provider 先并行拉模型；2) 其余 provider 随后并行补齐。
    await Promise.all(used.map((id) => fetchModels(id)))
    for (const p of list) {
      if (used.indexOf(p.id) < 0) fetchModels(p.id)
    }
  }, [rpc, loadProviders, fetchModels])

  useEffect(() => { load() }, [load])

  // 目录（providers / models）刷新：只动目录，不动正在编辑的配置（草稿保护）。
  const reloadCatalog = useCallback(async () => {
    if (catalogRefresh.current) return
    catalogRefresh.current = true
    setRefreshingCatalog(true)
    setProvidersError('')
    setModelsError({})
    try {
      const list = await loadProviders()
      const used = [...pvUsedProviderIds(pvDraftFrom(config))]
      const ids = used.concat(list.map((p) => p.id).filter((id) => used.indexOf(id) < 0))
      await Promise.all(ids.map((id) => {
        requested.current[id] = false
        return fetchModels(id)
      }))
    } finally {
      catalogRefresh.current = false
      setRefreshingCatalog(false)
    }
  }, [loadProviders, fetchModels, config])

  // 草稿序列化基线：渲染期同步（不等 effect）。轮询每 3 秒读一次，必须看到
  // 当前草稿；放在 effect 里会有一个渲染间隙，可能把脏草稿误判成干净而覆盖。
  if (config) {
    try {
      draftJsonRef.current = JSON.stringify(pvSavePayload(pvDraftFrom(config)))
    } catch (err) {
      draftJsonRef.current = ''
    }
  }

  // 3 秒整份 get 轮询（设计 §6.3）：只同步展示态；配置变更按「草稿是否脏」决定
  // 采纳还是亮冲突条。失败静默，绝不弹错、绝不阻塞保存。
  const poll = useCallback(async () => {
    if (pollingRef.current) return
    pollingRef.current = true
    try {
      const res = await rpc.get()
      if (!res || typeof res !== 'object') return
      if (typeof res.version === 'string') setVersion(res.version)
      setActive(res.active && typeof res.active === 'object' ? res.active : null)
      setHost(res.host && typeof res.host === 'object' ? res.host : null)
      setWarnings(Array.isArray(res.warnings) ? res.warnings : [])
      setRecentWarnings(Array.isArray(res.recentWarnings) ? res.recentWarnings : [])
      setSessionDetails(res.sessionDetails && typeof res.sessionDetails === 'object' ? res.sessionDetails : {})
      // 另一窗口保存后（revision 变化/firstRun=false）引导也应消失。
      setFirstRun(pvFirstRunState(res))
      // get 也带 enabled/sessions；本区块不展示它们（开关属于侧边栏 store），
      // 但会话覆盖变化仍通过 sessionDetails 的 enabled 字段在「恢复原模型」里体现。

      const revision = typeof res.configRevision === 'number' ? res.configRevision : undefined
      if (revision === undefined || revision === seenRevisionRef.current) return
      if (busyRef.current) return // 保存进行中：交给保存回包，避免互相覆盖
      const raw = res.config !== undefined ? res.config : res
      const next = pvDraftFrom(raw)
      const nextJson = JSON.stringify(pvSavePayload(next))
      const dirty = draftJsonRef.current !== '' && draftJsonRef.current !== baseConfigJson.current
      if (!dirty) {
        // 草稿干净：直接采纳外部变更（等价于「另一窗口保存后这边自动跟上」）。
        setConfig(next)
        setBaseRevision(revision)
        seenRevisionRef.current = revision
        baseConfigJson.current = nextJson
        draftJsonRef.current = nextJson
        setSavedAt('')
        setSaveError('')
        setToast('')
        setConflict(null)
        // 新配置可能引用还没拉过目录的 provider：后台补齐，不阻塞任何保存。
        for (const id of pvUsedProviderIds(next)) fetchModels(id)
        return
      }
      // 草稿是脏的：绝不静默覆盖。保留 base revision，普通保存仍会拿到
      // stale-revision（用户必须显式选「用我的覆盖」）。
      seenRevisionRef.current = revision
      setConflict({ message: '', config: next, revision, external: true })
    } catch (err) {
      // 轮询失败静默：下一次再试。
    } finally {
      pollingRef.current = false
    }
  }, [rpc, fetchModels])

  useEffect(() => {
    // 只在真实运行时轮询：测试/无 DOM 环境下（vm harness）没有定时器与 document。
    if (typeof setInterval !== 'function' || typeof document === 'undefined') return undefined
    let timer = null
    const visible = () => document.visibilityState === undefined || document.visibilityState === 'visible'
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const start = () => {
      if (timer === null && visible()) timer = setInterval(() => { poll() }, 3000)
    }
    const onVisibility = () => {
      if (visible()) {
        poll()
        start()
      } else {
        stop()
      }
    }
    const onFocus = () => {
      if (visible()) {
        poll()
        start()
      }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('focus', onFocus)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('focus', onFocus)
    }
  }, [poll])

  const updateConfig = (next) => {
    setSavedAt('')
    setSaveError('')
    setToast('')
    setConfig(next)
  }

  // 样例试算：只读（不落盘、不 select）。0.16 之前没有 probe handler → 明确降级。
  const runProbe = async () => {
    setProbeError('')
    setProbeResult(null)
    if (typeof rpc.probe !== 'function') {
      setProbeError(t('tierProbeUnavailable'))
      return
    }
    setProbeBusy(true)
    try {
      const result = await rpc.probe({ text: probeText })
      setProbeResult(result && typeof result === 'object' ? result : null)
    } catch (e) {
      const message = pvErrorText(e)
      if (/not found|unknown|unsupported|no handler/i.test(message)) setProbeError(t('tierProbeUnavailable'))
      else setProbeError(t('tierProbeFailed', { detail: message }))
    } finally {
      setProbeBusy(false)
    }
  }

  const restoreSession = async (sessionId) => {
    setRestoring(sessionId || '')
    try {
      await rpc.restore(sessionId)
      setSessionDetails((prev) => {
        const next = { ...prev }
        if (next[sessionId] && typeof next[sessionId] === 'object') {
          next[sessionId] = { ...next[sessionId], restore: null, restorePending: false }
        }
        return next
      })
    } catch (e) {
      setSaveError(pvErrorText(e))
    } finally {
      setRestoring('')
    }
  }

  // 批量恢复：串行调用（同一会话只有一个写句柄），成功后才清本地行。
  const restoreAll = async (ids) => {
    const list = Array.isArray(ids) ? ids.slice() : []
    if (list.length === 0) return
    setRestoring('all')
    try {
      for (const id of list) await rpc.restore(id)
      setSessionDetails((prev) => {
        const next = { ...prev }
        for (const id of list) {
          if (next[id] && typeof next[id] === 'object') next[id] = { ...next[id], restore: null, restorePending: false }
        }
        return next
      })
    } catch (e) {
      setSaveError(pvErrorText(e))
    } finally {
      setRestoring('')
    }
  }

  if (!config) {
    return h('div', { ref: sectionRef, style: { maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },
      h('div', { style: { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 8 } }, t('title')),
      loadError
        ? h('div', null,
          h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: 13, marginBottom: 4 } }, t('loadFailed')),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 8, wordBreak: 'break-word' } }, loadError),
          h('button', { onClick: () => { load() }, style: { fontWeight: 600 } }, t('retry')),
        )
        : h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #888)' } }, t('loading')),
    )
  }

  // 渲染前收敛一次：外部下发的东西一律当外部输入（v1 旧服务端 / 旧草稿也能显示）。
  const draft = pvDraftFrom(config)
  const targets = draft.targets
  const resolved = {
    low: targets.low,
    mid: pvResolveTarget(draft, 'mid'),
    high: pvResolveTarget(draft, 'high'),
  }

  const setTier = (tier, nextValue) => updateConfig({
    ...draft,
    targets: { ...draft.targets, [tier]: nextValue },
  })
  const setShare = (tier, shared) => {
    if (shared) {
      setTier(tier, { share: 'low' })
      return
    }
    setTier(tier, pvCopyTarget(pvResolveTarget(draft, tier)))
  }
  const setTierRouting = (patch) => updateConfig({ ...draft, tierRouting: { ...draft.tierRouting, ...patch } })
  const setAdvanced = (triple) => updateConfig({ ...draft, advancedSupport: triple })
  const setHolidays = (list) => updateConfig({ ...draft, holidays: pvNormalizeHolidays(list) })

  const addHoliday = () => {
    const raw = pvStr(holidayInput)
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
    if (!match) {
      setSaveError(t('holidayInvalid'))
      return
    }
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (!pvHolidayValid(year, month, day)) {
      setSaveError(t('holidayInvalid'))
      return
    }
    setSaveError('')
    setHolidayInput('')
    setHolidays(draft.holidays.concat([[year, month, day]]))
  }

  const importHolidayYear = (year) => {
    const preset = PV_HOLIDAY_PRESETS[year]
    if (!Array.isArray(preset)) {
      setSaveError(t('holidayPresetMissing', { year }))
      return
    }
    setSaveError('')
    setHolidays(draft.holidays.concat(preset))
  }

  const save = async (overwrite) => {
    const invalid = pvValidationError(draft, t)
    if (invalid) {
      setSaveError(invalid)
      setToast('')
      return
    }
    setSaving(true)
    busyRef.current = true
    setSaveError('')
    setSavedAt('')
    setToast('')
    try {
      const payload = pvSavePayload(draft)
      const next = await rpc.set(payload, overwrite === true ? undefined : baseRevision)
      const raw = next && next.config !== undefined ? next.config : next
      const applied = pvDraftFrom(raw)
      setConfig(applied)
      const appliedJson = JSON.stringify(pvSavePayload(applied))
      baseConfigJson.current = appliedJson
      draftJsonRef.current = appliedJson
      if (next && typeof next.configRevision === 'number') {
        setBaseRevision(next.configRevision)
        seenRevisionRef.current = next.configRevision
      }
      // 保存即视为「已用过」：引导永久消失（即使服务端这一版还没下发 firstRun）。
      setFirstRun(false)
      setConflict(null)
      // 明确的成功反馈：保存成功后界面必须有变化，用户才能区分「存上了」和「点了没反应」。
      const time = new Date().toLocaleTimeString()
      setSavedAt(time)
      setToast(t('saveToast', { time }))
    } catch (e) {
      setToast('')
      if (e && e.code === 'stale-revision') {
        // 另一窗口已改：不静默覆盖，给「重新加载 / 用我的覆盖」。
        setConflict({
          message: pvErrorText(e),
          config: e.details && e.details.config ? e.details.config : null,
          revision: e.details && typeof e.details.revision === 'number' ? e.details.revision : undefined,
          external: false,
        })
      } else {
        setSaveError(pvErrorText(e))
      }
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  // 「重新加载」冲突：优先用服务端随错误/轮询下发的 config，省一次往返；
  // 没有可用配置时退回整份 get。
  const reloadConflict = async () => {
    const current = conflict
    const external = current && current.config && typeof current.config === 'object' ? pvDraftFrom(current.config) : null
    if (!external) {
      await load()
      return
    }
    setConfig(external)
    baseConfigJson.current = JSON.stringify(pvSavePayload(external))
    draftJsonRef.current = baseConfigJson.current
    if (current.revision !== undefined) {
      setBaseRevision(current.revision)
      seenRevisionRef.current = current.revision
    }
    setConflict(null)
    setSavedAt('')
    setSaveError('')
    setToast('')
  }

  // 目录降级提示：providers / 任一 provider 的 models 失败都只提示，不影响保存。
  const modelErrorIds = Object.keys(modelsError)
  const catalogDegraded = Boolean(providersError) || modelErrorIds.length > 0
  const catalogDetail = providersError || (modelErrorIds.length > 0 ? modelsError[modelErrorIds[0]] : '')
  const hostOk = host && typeof host === 'object' ? host.modelSelect : undefined
  const activeParts = pvActiveParts(active, t)
  const warningList = Array.isArray(warnings) ? warnings : []
  // 最近 50 条 raise/clear 历史：告警自动消失后，用户仍能看到「刚才发生了什么」。
  const clearedWarnings = (Array.isArray(recentWarnings) ? recentWarnings : [])
    .filter((entry) => entry && entry.event === 'cleared')
    .slice(0, 5)
  const warningSeverity = warningList.some((w) => w && w.severity === 'error') ? 'error' : 'info'
  const recentList = Array.isArray(recentDecisions) ? recentDecisions : []
  const restorable = Object.keys(sessionDetails || {})
    .filter((id) => sessionDetails[id] && typeof sessionDetails[id] === 'object' && sessionDetails[id].restore)
    .slice(0, 20)
  const presetYears = Object.keys(PV_HOLIDAY_PRESETS).map((y) => Number(y)).sort()
  const selectedHolidayYear = Number(holidayYear) || presetYears[presetYears.length - 1] || new Date().getFullYear()

  const labelStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 }
  const sectionTitleStyle = { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 4 }
  const hintStyle = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)', marginBottom: 8 }

  return h('div', { ref: sectionRef, style: { maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },

    // ---- 标题 / 版本 / 宿主能力 ----
    h('div', { style: { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 4 } }, t('title')),
    h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 8 } }, t('subtitle')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
      version
        ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)' } }, `${t('versionLabel')} v${version}`)
        : null,
      hostOk === true
        ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-success-primary, #16794c)' } }, t('hostBadgeOk'))
        : hostOk === false
          ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('hostBadgeOld'))
          : null,
    ),

    // ---- 首次使用引导（可关闭、不阻塞保存；保存后永久消失） ----
    firstRun === true && guideDismissed !== true
      ? h('div', {
        role: 'note',
        'data-first-run': 'true',
        style: {
          border: '1px solid var(--dsw-alias-state-business-primary, #4c8dff)',
          background: 'var(--dsw-alias-bg-layer-1, #f2f7ff)',
          borderRadius: 10,
          padding: 12,
          marginBottom: 12,
          maxWidth: '100%',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } }, t('firstRunTitle')),
          h('button', {
            onClick: () => setGuideDismissed(true),
            style: { marginLeft: 'auto', padding: '2px 8px' },
          }, t('firstRunDismiss')),
        ),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)' } },
          ['firstRunPoint1', 'firstRunPoint2', 'firstRunPoint3', 'firstRunPoint4'].map((key) => h('li', { key }, t(key))),
        ),
      )
      : null,

    // ---- 状态区：此刻生效 ----
    active && typeof active === 'object'
      ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)', marginBottom: 8, wordBreak: 'break-word' } },
        t('activeNowLabel') + activeParts.join(' · '),
        active.advancedForMax ? t('advancedForMax', { model: active.advancedForMax }) : null)
      : null,

    // ---- 告警（error=红 / info=黄；数据来自 get.warnings） ----
    warningList.length > 0
      ? h('div', {
        role: 'alert',
        style: {
          border: `1px solid ${warningSeverity === 'error' ? 'var(--dsw-alias-state-error-primary, #e5484d)' : 'var(--dsw-alias-state-warn-primary, #e6c473)'}`,
          background: warningSeverity === 'error' ? 'var(--dsw-alias-bg-layer-1, #fff1f1)' : 'var(--dsw-alias-bg-layer-1, #fff9e8)',
          borderRadius: 10,
          padding: 10,
          marginBottom: 10,
          maxWidth: '100%',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { fontSize: 12, lineHeight: '18px', fontWeight: 600, color: warningSeverity === 'error' ? 'var(--dsw-alias-state-error-primary, #c00)' : 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('warningTitle')),
        h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)', marginTop: 2, wordBreak: 'break-word' } }, pvWarningText(warningList[0], t)),
        warningList.length > 1 || clearedWarnings.length > 0
          ? h('details', { style: { marginTop: 4 } },
            h('summary', { style: { fontSize: 11, lineHeight: '16px', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary, #777)' } },
              warningList.length > 1 ? t('warningMore', { count: warningList.length - 1 }) : t('warningRecent')),
            warningList.slice(1, 5).map((w, i) => h('div', { key: 'w' + i, style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #777)', wordBreak: 'break-word' } }, pvWarningText(w, t))),
            clearedWarnings.map((w, i) => h('div', { key: 'c' + i, style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #777)', wordBreak: 'break-word' } },
              t('warningCleared', { target: pvTripleText(w.target) }))),
          )
          : null,
      )
      : null,

    // ---- 冲突：另一窗口已改 ----
    conflict
      ? h('div', {
        role: 'alert',
        style: { border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)', background: 'var(--dsw-alias-bg-layer-1, #fff1f1)', borderRadius: 10, padding: 10, marginBottom: 10, boxSizing: 'border-box' },
      },
        h('div', { style: { fontSize: 12, lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #c00)' } }, t('conflictTitle')),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #777)', marginTop: 2, wordBreak: 'break-word' } }, conflict.message || t('conflictExternalHint')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
          h('button', { onClick: () => { reloadConflict() } }, t('conflictReload')),
          h('button', { onClick: () => { save(true) } }, t('conflictOverwrite')),
        ),
      )
      : null,

    // ---- 目录降级提示（不阻塞保存） ----
    catalogDegraded ? h('div', {
      style: { border: '1px solid var(--dsw-alias-state-warn-primary, #e6c473)', background: 'var(--dsw-alias-bg-layer-1, #fff9e8)', borderRadius: 10, padding: 10, marginBottom: 12, maxWidth: '100%', boxSizing: 'border-box' },
    },
      h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-label, #8a6100)' } }, t('catalogUnavailable')),
      catalogDetail ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #a08447)', marginTop: 2, wordBreak: 'break-word' } }, catalogDetail) : null,
      h('button', { onClick: () => { reloadCatalog() }, disabled: refreshingCatalog, style: { marginTop: 8 } }, t('retry')),
    ) : null,

    // ---- A. 智能程度路由 ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: sectionTitleStyle }, t('tierRoutingTitle')),
      h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, lineHeight: '20px', cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: draft.tierRouting.enabled === true,
          onChange: (e) => setTierRouting({ enabled: e.target.checked }),
        }),
        h('span', null, t('tierRoutingTitle')),
      ),
      h('div', { style: { ...hintStyle, marginTop: 4 } }, t('tierRoutingHint')),
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' } },
        h('div', null,
          h('div', { style: labelStyle }, t('tierThresholdConcrete')),
          h('input', {
            type: 'number',
            min: 0,
            max: 1,
            step: 0.01,
            value: String(draft.tierRouting.concreteThreshold),
            'aria-label': t('tierThresholdConcrete'),
            onChange: (e) => setTierRouting({ concreteThreshold: pvNum(e.target.value, draft.tierRouting.concreteThreshold) }),
            style: { width: 96, boxSizing: 'border-box' },
          }),
        ),
        h('div', null,
          h('div', { style: labelStyle }, t('tierThresholdMedium')),
          h('input', {
            type: 'number',
            min: 0,
            max: 1,
            step: 0.01,
            value: String(draft.tierRouting.mediumThreshold),
            'aria-label': t('tierThresholdMedium'),
            onChange: (e) => setTierRouting({ mediumThreshold: pvNum(e.target.value, draft.tierRouting.mediumThreshold) }),
            style: { width: 96, boxSizing: 'border-box' },
          }),
        ),
      ),
      h('div', { style: { ...hintStyle, marginTop: 6, marginBottom: 0 } }, t('tierThresholdHint')),

      // 样例试算
      h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, #efefef)', marginTop: 10, paddingTop: 10 } },
        h('div', { style: sectionTitleStyle }, t('tierProbeTitle')),
        h('textarea', {
          value: probeText,
          placeholder: t('tierProbePlaceholder'),
          'aria-label': t('tierProbePlaceholder'),
          onChange: (e) => setProbeText(e.target.value),
          rows: 3,
          style: { display: 'block', width: '100%', boxSizing: 'border-box', minWidth: 0, marginBottom: 6 },
        }),
        h('button', { onClick: () => { runProbe() }, disabled: probeBusy }, probeBusy ? t('loading') : t('tierProbeRun')),
        probeError
          ? h('div', { role: 'alert', style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary, #c00)', marginTop: 6, wordBreak: 'break-word' } }, probeError)
          : null,
        probeResult
          ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #555)', marginTop: 6 } },
            t('tierProbeResult', {
              score: typeof probeResult.score === 'number' ? probeResult.score.toFixed(3) : '-',
              tier: probeResult.tier ? pvTierLabel(probeResult.tier, t) : '-',
              model: pvTripleText(probeResult.target && typeof probeResult.target === 'object' ? probeResult.target : probeResult),
            }),
            pvTierReasonText(probeResult.tierReason, t) ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, pvTierReasonText(probeResult.tierReason, t)) : null,
            pvCostReasonText(probeResult.costReason, t) ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, pvCostReasonText(probeResult.costReason, t)) : null,
            Array.isArray(probeResult.features) && probeResult.features.length > 0
              ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)', wordBreak: 'break-word' } },
                t('tierProbeFeatures') + ': ' + probeResult.features.map((f) => pvFeatureText(f, t)).join(', '))
              : null,
          )
          : null,
      ),
    ),

    // ---- B. 三档模型 ----
    h('div', { style: { ...sectionTitleStyle, marginBottom: 8 } }, t('targetsTitle')),
    PV_TIERS.map((tier) => h(StrategyEditor, {
      key: tier,
      tier,
      target: targets[tier],
      effective: resolved[tier],
      shared: pvIsShared(draft, tier),
      providers,
      models,
      modelsLoading,
      modelsError,
      onNeedModels: fetchModels,
      onChange: (next) => setTier(tier, next),
      onShareChange: (shared) => setShare(tier, shared),
      t,
      narrow,
    })),

    // ---- C. 峰谷与节假日 ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: sectionTitleStyle }, t('holidaysTitle')),
      h('div', { style: hintStyle }, t('holidaysHint')),
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
        h('div', null,
          h('div', { style: labelStyle }, t('utcOffsetLabel')),
          h('input', {
            type: 'number',
            min: -840,
            max: 840,
            step: 15,
            value: String(draft.utcOffsetMinutes),
            'aria-label': t('utcOffsetLabel'),
            onChange: (e) => updateConfig({ ...draft, utcOffsetMinutes: pvNum(e.target.value, draft.utcOffsetMinutes) }),
            style: { width: 120, boxSizing: 'border-box' },
          }),
        ),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('utcOffsetHint')),
      ),
      h(PvHolidayEditor, {
        holidays: draft.holidays,
        input: holidayInput,
        year: selectedHolidayYear,
        onInput: setHolidayInput,
        onYear: (value) => setHolidayYear(String(value)),
        onAdd: addHoliday,
        onRemove: (year, month, day) => setHolidays(draft.holidays.filter((item) => !(item[0] === year && item[1] === month && item[2] === day))),
        onImport: importHolidayYear,
        t,
      }),
    ),

    // ---- D. 高级模型支援（max） ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: sectionTitleStyle }, t('advancedTitle')),
      h('div', { style: hintStyle }, t('advancedHint')),
      h(ModelPicker, {
        label: t('advancedTitle'),
        value: draft.advancedSupport,
        providers,
        models,
        modelsLoading: modelsLoading[draft.advancedSupport.provider],
        modelsError: modelsError[draft.advancedSupport.provider],
        onNeedModels: fetchModels,
        onChange: setAdvanced,
        t,
        narrow,
      }),
    ),

    // ---- E. 诊断 ----
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 12, boxSizing: 'border-box' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('button', {
          onClick: () => { reloadCatalog() },
          disabled: refreshingCatalog,
          'aria-busy': refreshingCatalog,
        }, refreshingCatalog ? t('refreshingModels') : t('refreshModels')),
      ),
      h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, #efefef)', marginTop: 10, paddingTop: 10 } },
        h('div', { style: sectionTitleStyle }, t('restoreTitle')),
        h('div', { style: hintStyle }, t('restoreHint')),
        restorable.length === 0
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('restoreMissing'))
          : h('div', null,
            restorable.map((id) => {
              const detail = sessionDetails[id] || {}
              return h('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, lineHeight: '20px', marginBottom: 4 } },
                h('span', { style: { fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary, #555)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(id)),
                h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #888)' } }, pvTripleText(detail.restore)),
                h('button', { onClick: () => { restoreSession(id) }, disabled: restoring !== '' }, t('restoreOne')),
              )
            }),
            h('button', { onClick: () => { restoreAll(restorable) }, disabled: restoring !== '' }, t('restoreAll')),
          ),
      ),
      recentList.length > 0
        ? h('details', { style: { marginTop: 10 } },
          h('summary', { style: { fontSize: 12, lineHeight: '18px', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #555)' } }, t('recentDecisions')),
          recentList.slice(0, 20).map((decision, i) => h('div', { key: i, style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)', wordBreak: 'break-word' } },
            [
              decision && decision.tier ? pvTierLabel(decision.tier, t) : '',
              decision && decision.outcome ? pvOutcomeText(decision.outcome, t) : '',
              decision && decision.target ? pvTripleText(decision.target) : '',
              decision && decision.costReason ? pvCostReasonText(decision.costReason, t) : '',
            ].filter((part) => part !== '').join(' · '))),
        )
        : null,
    ),

    // ---- 保存 / 重新加载 ----
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('button', { onClick: () => { save(false) }, disabled: saving, style: { fontWeight: 600 } }, saving ? t('saving') : t('save')),
      h('button', { onClick: () => { load() }, disabled: saving }, t('reloadConfig')),
      saveError
        ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: 12, lineHeight: '18px', minWidth: 0, wordBreak: 'break-word' } }, t('saveFailed', { detail: pvSaveErrorText(saveError, t) }))
        : toast
          ? h('div', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-state-success-primary, #16794c)', fontSize: 12, lineHeight: '18px', fontWeight: 600 } }, toast)
          : (savedAt
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 12, lineHeight: '18px' } }, t('saved', { time: savedAt }))
            : null),
    ),
  )
}

// providers RPC 的返回：接受 { providers:[...] } 或裸数组，按 id 去重。
// （放在文件末尾也可：函数声明会提升，渲染时一定可用。）
function pvNormalizeProviders(res) {
  const raw = res && Array.isArray(res.providers) ? res.providers : (Array.isArray(res) ? res : [])
  const seen = Object.create(null)
  const list = []
  for (const p of raw) {
    const id = p && (p.id || p.name) ? String(p.id || p.name) : ''
    if (!id || seen[id]) continue
    seen[id] = true
    list.push({ id, name: String((p && p.name) || id) })
  }
  return list
}

// ---- src/client/90-apply.js ----
// 插件入口：注册文案、左侧开关、设置页区块。

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-peak-valley-router: copy dictionaries')

  const connection = ctx.get('connection')
  const t = ctx.locale.bind(NS)
  const api = rpc(connection)

  // 左侧「启用避峰岗」开关（实现见 10-toggle.js）。
  registerToggle(ctx, { rpc: api, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'peak-valley-router',
    order: 95,
    label: () => t('nav'),
    inject: () => ({ rpc: api, t }),
  }, PolicySettingsSection))
}

exports.apply = apply
exports.inject = inject


return module.exports;
} });
