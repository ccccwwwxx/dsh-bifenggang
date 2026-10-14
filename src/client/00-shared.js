// 共享常量与 RPC 封装。所有 client 端模块共用。

const NS = 'settings.peakValley'

const inject = ['slots', 'connection', 'locale']

// 统一解包 { ok, value } 信封；失败时抛出服务端消息。
function rpc(connection) {
  const call = async (method, payload) => {
    const res = await connection.rpc.call('/api', method, payload)
    if (res && res.ok === true) return res.value
    const msg = res?.error?.message ?? res?.error ?? 'RPC failed'
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return {
    get: () => call('dsh-peak-valley-router.get', {}),
    set: (config) => call('dsh-peak-valley-router.set', { config }),
    providers: () => call('dsh-peak-valley-router.providers', {}),
    models: (provider) => call('dsh-peak-valley-router.models', { provider }),
    toggle: (payload) => call('dsh-peak-valley-router.toggle', typeof payload === 'boolean' ? { enabled: payload } : (payload || {})),
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
  const out = {}
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

// 单个会话的有效状态，供会话列表小灯使用。订阅同一份 store，不额外发 RPC。
function usePeakSession(store, sessionId) {
  const [on, setOn] = useState(() => (store ? store.sessionState(sessionId) : false))
  useEffect(() => {
    if (!store) return undefined
    const sync = (view) => setOn(Boolean(view && peakSessionEffective(view.enabled, view.sessions, sessionId)))
    sync(store.get())
    const off = store.subscribe(sync)
    store.ensureLoaded()
    return off
  }, [store, sessionId])
  return on
}
