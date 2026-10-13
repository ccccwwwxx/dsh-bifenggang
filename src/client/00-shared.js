// 共享常量与 RPC 封装。所有 client 端模块共用。

const NS = 'settings.peakValley'

const inject = ['slots', 'connection', 'locale']

const WEEKDAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日']

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
    toggle: (enabled) => call('dsh-peak-valley-router.toggle', { enabled }),
  }
}

// 轻量响应式：视口宽度 <= 720px 视为窄屏（移动端 / 远程连接）。
function useIsNarrow() {
  const read = () => (typeof window === 'undefined' ? false : window.innerWidth <= 720)
  const [narrow, setNarrow] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setNarrow(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}
