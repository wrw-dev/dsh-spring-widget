// dsh 客户端插件协议：脚本执行时只注册 factory，模块体副作用（含 CSS 注入）在物化时运行
window.__ModuleLoader__.load({
  id: 'dsh-spring-widget',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const PHASES = {
      stopped: { color: '#9ca3af', text: '已停止' },
      building: { color: '#f59e0b', text: '编译中' },
      starting: { color: '#f59e0b', text: '启动中' },
      running: { color: '#22c55e', text: '运行中' },
      stopping: { color: '#f59e0b', text: '停止中' },
      crashed: { color: '#ef4444', text: '异常退出' },
    }
    const phaseInfo = (p) => PHASES[p] || { color: '#9ca3af', text: String(p || '未知') }

    const IconPlay = () => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
      h('path', { d: 'M4.5 2.5v11l9-5.5z' }))
    const IconStop = () => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
      h('rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1.5 }))
    const IconLog = () => h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': 'true' },
      h('path', { d: 'M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5' }))
    const IconChevron = (props) => h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true', ...props },
      h('path', { d: 'M3.5 6l4.5 4.5L12.5 6' }))

    const RPC = 'spring-widget'

    const name = 'dsh-spring-widget'
    const inject = ['slots', 'connection', 'timer', 'workspaces']

    function apply(ctx) {
      const slots = ctx.get('slots')
      const connection = ctx.get('connection')
      const workspaces = ctx.get('workspaces')
      if (!slots || !connection) return

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.pluginCss = 'dsh-spring-widget'
        style.textContent = `
          .sw-bar{display:inline-flex;align-items:center;gap:2px;height:28px;}
          .sw-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:30px;padding:0 7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;border-radius:6px;font-size:12px;}
          .sw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));color:var(--dsw-alias-label-primary,#1f2328);}
          .sw-btn:disabled{opacity:.4;cursor:not-allowed;}
          .sw-btn.go{color:#1a8a3c;}
          .sw-btn.halt{color:#c93a31;}
          .sw-btn.on{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#1f2328);}
          .sw-pulse{animation:sw-blink 1.5s ease-in-out infinite;}
          @keyframes sw-blink{0%,100%{opacity:1}50%{opacity:.35}}
          .sw-meta{display:inline-flex;align-items:center;gap:5px;padding:0 6px 0 2px;font-size:12px;color:var(--dsw-alias-label-tertiary,#6a737d);cursor:pointer;border:none;background:transparent;height:28px;border-radius:6px;}
          .sw-meta:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));}
          .sw-metaText{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
          .sw-chevOpen{transform:rotate(180deg);}
          .sw-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9998;}
          /* 几何（left/top/width/height）由 JS 按默认布局或记忆值内联设置，可拖动/缩放 */
          .sw-console{position:fixed;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.28);z-index:9999;display:flex;flex-direction:column;overflow:hidden;font-size:13px;}
          .sw-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#eaeef2);flex-wrap:wrap;cursor:grab;touch-action:none;}
          .sw-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;z-index:5;touch-action:none;}
          .sw-resize::before,.sw-resize::after{content:'';position:absolute;width:9px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption,#6a737d);}
          .sw-resize::before{right:2px;bottom:4px;transform:rotate(-45deg);}
          .sw-resize::after{right:2px;bottom:9px;width:6px;transform:rotate(-45deg);}
          .sw-title{font-weight:600;font-size:14px;}
          .sw-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-caption,#6a737d);}
          .sw-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;}
          .sw-spacer{flex:1;}
          .sw-hbtn{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:4px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap;}
          .sw-hbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eef1f4);}
          .sw-hbtn:disabled{opacity:.45;cursor:not-allowed;}
          .sw-hbtn.primary{background:#1f8f4d;border-color:#1f8f4d;color:#fff;}
          .sw-hbtn.primary:hover:not(:disabled){background:#187a40;}
          .sw-hbtn.danger{background:#d3352c;border-color:#d3352c;color:#fff;}
          .sw-hbtn.danger:hover:not(:disabled){background:#b52a23;}
          .sw-hbtn.on{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l3,#9ad4ae);color:var(--dsw-alias-label-primary,#155d33);}
          .sw-tabs{display:flex;gap:2px;padding:6px 14px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#eaeef2);align-items:center;}
          .sw-tab{border:none;background:transparent;cursor:pointer;font-size:13px;padding:6px 14px;color:var(--dsw-alias-label-secondary,#57606a);border-bottom:2px solid transparent;}
          .sw-tab.on{color:var(--dsw-alias-label-primary,#1f2328);border-bottom-color:var(--dsw-alias-state-business-primary,#1f8f4d);font-weight:600;}
          .sw-tab.small{font-size:12px;padding:4px 10px;}
          .sw-logwrap{flex:1;min-height:0;display:flex;}
          .sw-log{flex:1;background:#0d1117;color:#c9d1d9;padding:10px 14px;overflow:auto;font-family:var(--dsw-font-mono,Consolas,Menlo,monospace);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all;margin:0;}
          .sw-cfgbar{border-top:1px solid var(--dsw-alias-border-l2,#eaeef2);padding:12px 16px 16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-2,#f8fafc);max-height:46%;overflow:auto;}
          .sw-cfghead{display:flex;align-items:center;gap:8px;}
          .sw-cfgtitle{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);}
          .sw-cfggrp{border:1px solid var(--dsw-alias-border-l2,#eaeef2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
          .sw-cfggrphead{display:flex;align-items:baseline;gap:10px;padding-bottom:6px;border-bottom:1px dashed var(--dsw-alias-border-l2,#eaeef2);}
          .sw-cfggrptitle{font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2328);}
          .sw-cfggrpdesc{font-size:11.5px;color:var(--dsw-alias-label-caption,#6a737d);}
          .sw-cfground{display:flex;flex-direction:row;gap:8px;align-items:center;flex-wrap:nowrap;}
          .sw-cfglabelwrap{display:flex;align-items:center;gap:6px;flex:none;min-width:56px;}
          .sw-cfglabel{font-size:12px;color:var(--dsw-alias-label-caption,#6a737d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
          .sw-cfgcheck{flex:none;font-size:11px;color:#1a8a3c;white-space:nowrap;}
          .sw-cfground .sw-input{flex:1;min-width:0;}
          .sw-browse{flex:0 0 auto;white-space:nowrap;padding:4px 14px;}
          .sw-cfgactions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
          .sw-input{border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:6px;padding:5px 9px;font-size:12px;font-family:var(--dsw-font-mono,Consolas,Menlo,monospace);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;width:100%;box-sizing:border-box;}
          .sw-note{font-size:12px;color:var(--dsw-alias-label-caption,#6a737d);}
          .sw-err{font-size:12px;color:#d3352c;word-break:break-all;}
          .sw-statusline{display:flex;gap:14px;flex-wrap:wrap;padding:5px 14px;border-top:1px solid var(--dsw-alias-border-l2,#eaeef2);font-size:12px;color:var(--dsw-alias-label-caption,#6a737d);font-family:var(--dsw-font-mono,Consolas,Menlo,monospace);}
          .sw-buildlog{flex:1;background:#f6f8fa;color:#24292f;border:1px solid #eaeef2;border-radius:0;padding:10px 14px;overflow:auto;font-family:var(--dsw-font-mono,Consolas,Menlo,monospace);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0;}
          /* 目录选择对话框 */
          .sw-picker{position:fixed;left:50%;top:12%;transform:translateX(-50%);width:min(720px,92vw);max-height:76vh;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.3);z-index:10001;display:flex;flex-direction:column;overflow:hidden;}
          .sw-phead{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#eaeef2);}
          .sw-ptitle{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
          .sw-pcrumbs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:8px 16px 0;font-size:12px;}
          .sw-pcrumb{border:none;background:transparent;color:var(--dsw-alias-state-business-primary,#1f8f4d);cursor:pointer;padding:2px 6px;border-radius:4px;font-size:12px;}
          .sw-pcrumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));}
          .sw-psep{color:var(--dsw-alias-label-caption,#6a737d);}
          .sw-plist{flex:1;min-height:200px;overflow:auto;padding:8px;display:flex;flex-direction:column;}
          .sw-prow{display:flex;align-items:center;gap:8px;text-align:left;border:none;background:transparent;color:inherit;cursor:pointer;padding:6px 10px;border-radius:6px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
          .sw-prow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));}
          .sw-pempty{padding:24px;text-align:center;color:var(--dsw-alias-label-caption,#6a737d);font-size:13px;}
          .sw-pfoot{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,#eaeef2);}
          .sw-plabel{font-size:12px;color:var(--dsw-alias-label-caption,#6a737d);flex:none;}
          .sw-pfoot .sw-input{flex:1;}
          /* 深色主题兜底：激活页签/按钮标题在深色下必须清晰可读 */
          @media (prefers-color-scheme: dark){
            .sw-tab.on{color:#e6edf3;}
            .sw-hbtn.on{color:#e6edf3;background:rgba(127,127,127,.22);border-color:#e6edf3;}
            .sw-title,.sw-cfgtitle,.sw-cfggrptitle{color:#e6edf3;}
            .sw-tab{color:#8b949e;}
            .sw-hbtn{color:#e6edf3;background:rgba(127,127,127,.12);border-color:rgba(255,255,255,.18);}
            .sw-btn{color:#8b949e;}
            .sw-btn.on{color:#e6edf3;}
          }
        `
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-spring-widget: styles')

      // ---------- 外部 store（函数式订阅通知，组件内用 useState 强制重渲染） ----------
      const store = {
        open: false, tab: 'app', follow: true, paused: false, showConfig: false, collapsed: false,
        status: null, logs: '', build: '', access: '', picker: null,
        outOff: 0, errOff: 0, buildSeq: -1, buildOff: 0, accessOff: 0,
        busy: false, error: '', cfgDraft: null, copied: '', consoleGeo: null,
      }
      const subs = new Set()
      const setStore = (patch) => { Object.assign(store, patch); for (const fn of subs) fn() }

      // ---------- 控制台浮窗几何：默认布局 / localStorage 记忆 / 视口 clamp ----------
      const GEO_KEY = 'dsh-spring-widget.geo'
      const GEO_MIN_W = 520, GEO_MIN_H = 320
      const clampGeo = (g) => {
        const vw = window.innerWidth, vh = window.innerHeight
        let w = Math.min(Math.max(g.w, GEO_MIN_W), vw)
        let h = Math.min(Math.max(g.h, GEO_MIN_H), vh)
        // 严格 clamp：窗口完全在视口内
        let x = Math.min(Math.max(g.x, 0), vw - w)
        let y = Math.min(Math.max(g.y, 0), vh - h)
        return { x, y, w, h }
      }
      const defaultGeo = () => {
        // 与旧 CSS 布局一致：左右 24px、顶 56px、底 24px、max-width 1400px 居中
        const vw = window.innerWidth, vh = window.innerHeight
        const w = Math.min(vw - 48, 1400)
        return clampGeo({ x: (vw - w) / 2, y: 56, w, h: vh - 80 })
      }
      const loadGeo = () => {
        try {
          const raw = window.localStorage.getItem(GEO_KEY)
          if (!raw) return null
          const g = JSON.parse(raw)
          if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' || typeof g.w !== 'number' || typeof g.h !== 'number') return null
          return clampGeo(g)
        } catch { return null }
      }
      const saveGeo = (g) => {
        try { window.localStorage.setItem(GEO_KEY, JSON.stringify(g)) } catch { }
      }
      // 打开控制台时初始化几何（有记忆用记忆，否则默认布局）
      const initGeo = () => { if (!store.consoleGeo) setStore({ consoleGeo: loadGeo() || defaultGeo() }) }

      // 拖动 / 缩放：pointerdown 记录起点，move 全局监听并 clamp 后写 store，up 清理并持久化
      const beginDrag = (e) => {
        if (e.button !== 0) return
        // 只从标题栏空白处起拖：按钮/输入框上起拖时照常点击，不进入拖动
        if (e.target.closest && e.target.closest('button,input,select,textarea,a,[role=button]')) return
        const geo0 = store.consoleGeo || defaultGeo()
        const px = e.clientX, py = e.clientY
        e.preventDefault()
        const onMove = (ev) => {
          setStore({ consoleGeo: clampGeo({ ...geo0, x: geo0.x + ev.clientX - px, y: geo0.y + ev.clientY - py }) })
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (store.consoleGeo) saveGeo(store.consoleGeo)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      const beginResize = (e) => {
        if (e.button !== 0) return
        const geo0 = store.consoleGeo || defaultGeo()
        const px = e.clientX, py = e.clientY
        e.preventDefault()
        e.stopPropagation()
        const onMove = (ev) => {
          setStore({ consoleGeo: clampGeo({ ...geo0, w: geo0.w + ev.clientX - px, h: geo0.h + ev.clientY - py }) })
        }
        onMove(e)
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (store.consoleGeo) saveGeo(store.consoleGeo)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const rpc = async (method, args) => {
        try {
          // 独立 RPC 频道 /spring-widget（对应 host 端 rpc.handle('/spring-widget')）。
          // 不要用 /api —— 那是官方共享拦截器通道（typert-gateway 的命令端点用），
          // 插件抢占会让 /api 上的 commands/list 等全部 404
          const res = await connection.rpc.call('/spring-widget', RPC + '/' + method, args || {})
          if (res && res.ok) return res.value
          throw new Error(res && res.error ? res.error.message : 'RPC ' + method + ' 失败')
        } catch (e) {
          setStore({ error: String((e && e.message) || e) })
          return null
        }
      }

      const openConsole = () => { initGeo(); setStore({ open: true, paused: false }); refreshLogs() }
      const closeConsole = () => setStore({ open: false })
      const toggleCollapse = () => setStore({ collapsed: !store.collapsed })

      const refreshStatus = async () => {
        const s = await rpc('status')
        if (s) setStore({ status: s, error: '' })
      }
      const refreshLogs = async () => {
        const r = await rpc('logs', { outFrom: store.outOff, errFrom: store.errOff, buildFrom: store.buildOff, accessFrom: store.accessOff })
        if (!r) return
        const next = {}
        // 编译输出：宿主 buildSeq 变化（新构建开始）→ 整体重置；否则增量拼接
        if (r.build) {
          if (r.buildSeq !== undefined && r.buildSeq !== store.buildSeq) {
            store.buildSeq = r.buildSeq; store.buildOff = 0
            store.build = r.build.text || ''
          } else {
            if (r.build.text) store.build = (store.build + r.build.text).slice(-160000)
          }
          if (r.build.nextOffset !== undefined) store.buildOff = r.build.nextOffset
          next.build = store.build
        }
        if (r.out) {
          if (r.out.lossy) { store.logs = ''; store.outOff = 0 }
          next.logs = (store.logs + (r.out.text || '')).slice(-160000)
          store.outOff = r.out.nextOffset
        }
        if (r.err && r.err.text) {
          if (r.err.lossy) { store.logs = ''; store.errOff = 0 }
          next.logs = ((next.logs !== undefined ? next.logs : store.logs) + (r.err.text || '')).slice(-160000)
          store.errOff = r.err.nextOffset
        }
        // 请求日志（Tomcat access log）：增量追加
        if (r.access) {
          if (r.access.lossy) { store.access = ''; store.accessOff = 0 }
          next.access = (store.access + (r.access.text || '')).slice(-160000)
          store.accessOff = r.access.nextOffset
        }
        setStore(next)
      }

      const act = async (method, args) => {
        if (store.busy) return
        setStore({ busy: true, error: '' })
        if (method === 'start') {
          // 新启动：清显示并归零读取偏移（宿主 lastProc 会换新进程，旧偏移对新流无效）
          store.logs = ''; store.outOff = 0; store.errOff = 0
          setStore({ logs: '', tab: 'app', open: true, follow: true, paused: false })
        }
        const s = await rpc(method, args)
        setStore({ busy: false })
        if (s) setStore({ status: s })
        refreshLogs()
      }

      const saveCfg = async () => {
        if (!store.cfgDraft) return
        setStore({ busy: true, error: '' })
        const s = await rpc('setConfig', { patch: store.cfgDraft })
        setStore({ busy: false, cfgDraft: null })
        if (s) setStore({ status: s })
      }

      const copyLogs = async () => {
        const text = store.tab === 'app' ? store.logs : (store.tab === 'access' ? store.access : store.build)
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text || '')
            setStore({ copied: '已复制' })
          } else setStore({ copied: '不支持剪贴板' })
        } catch { setStore({ copied: '复制失败' }) }
        ctx.timeout(() => setStore({ copied: '' }), 2000)
      }

      ctx.effect(() => {
        const tick = () => {
          refreshStatus()
          if (store.open && !store.paused) refreshLogs()
        }
        const stop = ctx.interval(tick, 1000)
        tick()
        return stop
      }, 'dsh-spring-widget: poller')

      // 浏览器视口变化：把已打开的浮窗重新 clamp 回视口内（防窗口缩小后浮窗挂在外面）
      ctx.effect(() => {
        const onWinResize = () => {
          if (store.consoleGeo) setStore({ consoleGeo: clampGeo(store.consoleGeo) })
        }
        window.addEventListener('resize', onWinResize)
        return () => window.removeEventListener('resize', onWinResize)
      }, 'dsh-spring-widget: viewport-clamp')

      // ---------- 组件 ----------
      const useStore = () => {
        // 关键修复：函数式更新（setCount(c => c + 1)），绝不捕获旧值
        const [, setCount] = react.useState(0)
        react.useEffect(() => {
          const fn = () => setCount((c) => c + 1)
          subs.add(fn)
          return () => subs.delete(fn)
        }, [])
        return store
      }

      const HeaderRunWidget = () => {
        const st = useStore()
        const s = st.status || {}
        const info = phaseInfo(s.phase)
        const busy = st.busy
        const canStart = !busy && (s.phase === 'stopped' || s.phase === 'crashed' || !s.phase)
        const canStop = !busy && s.phase !== 'stopped' && s.phase !== 'crashed' && s.phase !== 'building'
        const live = s.phase === 'running' || s.phase === 'building' || s.phase === 'starting' || s.phase === 'stopping'
        const label = s.jarName || '后端服务'
        const metaText = s.phase === 'running'
          ? (s.port ? label + ' : ' + s.port : label)
          : (info.text + (live ? '…' : ''))
        if (st.collapsed) {
          return h('button', {
            className: 'sw-btn', title: '展开后端服务控制（Spring Boot）', 'aria-label': '展开后端服务控制',
            onClick: toggleCollapse,
          }, h('span', { className: live ? 'sw-pulse' : '', style: { width: 7, height: 7, borderRadius: '50%', background: info.color, display: 'inline-block' } }), '后端')
        }
        return h('div', { className: 'sw-bar', role: 'group', 'aria-label': '后端服务控制' },
          h('button', {
            className: 'sw-btn go', disabled: !canStart,
            title: canStart ? '源码直启（自动打开日志控制台）' : '服务已在运行，点「日志」查看输出',
            'aria-label': '启动后端服务',
            onClick: () => act('start', { mode: 'src' }),
          }, h(IconPlay)),
          h('button', {
            className: 'sw-btn halt', disabled: !canStop,
            title: canStop ? '停止后端服务' : '服务未在运行',
            'aria-label': '停止后端服务',
            onClick: () => act('stop'),
          }, h(IconStop)),
          h('button', {
            className: 'sw-btn' + (st.open ? ' on' : ''),
            title: '打开日志控制台', 'aria-label': '查看运行日志',
            onClick: openConsole,
          }, h(IconLog), '日志'),
          h('button', {
            className: 'sw-meta',
            title: '后端服务：' + info.text + '（点击打开控制台）',
            'aria-label': '后端服务：' + info.text,
            onClick: openConsole,
          },
            h('span', { className: live ? 'sw-pulse' : '', style: { width: 7, height: 7, borderRadius: '50%', background: info.color, display: 'inline-block', flex: 'none' } }),
            h('span', { className: 'sw-metaText' }, metaText),
            h(IconChevron, { className: st.open ? 'sw-chevOpen' : '' })),
          h('button', {
            className: 'sw-btn', title: '收起后端服务控制（保留一个状态点）', 'aria-label': '收起',
            onClick: toggleCollapse,
          }, h(IconChevron, { style: { transform: 'rotate(-90deg)' } })))
      }

      const LogView = () => {
        const st = useStore()
        const ref = react.useRef(null)
        react.useEffect(() => {
          if (!st.follow) return
          const el = ref.current
          if (el) el.scrollTop = el.scrollHeight
        }, [st.logs, st.build, st.access, st.follow])
        const cls = st.tab === 'app' ? 'sw-log' : (st.tab === 'access' ? 'sw-log sw-log-access' : 'sw-buildlog')
        const text = st.tab === 'app' ? (st.logs || '（暂无日志——点上方「▶ 源码启动」后自动实时滚动）')
          : st.tab === 'access' ? (st.access || '（暂无请求日志——启动服务后，在前端页面/接口发起请求即会在此显示）')
          : (st.build || '（暂无编译输出）')
        return h('pre', {
          className: cls,
          ref,
          onScroll: (e) => {
            const el = e.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
            if (!atBottom && st.follow) setStore({ follow: false })
          },
        }, text)
      }

      // 配置分组：[组标题, 组说明, [key, 标签, 占位符, 是否路径(可浏览), 探测值取自 status.detected 的 key]]
      const CFG_GROUPS = [
        { title: '路径配置', desc: '留空时自动从 PATH 探测', fields: [
          ['cwd', '项目目录', 'E:\\path\\to\\project', true, 'cwd'],
          ['javaPath', 'JDK', '留空=PATH 中的 java', true, 'javaPath'],
          ['mavenHome', 'Maven', '留空=PATH 中的 mvn', true, 'mavenHome'],
        ] },
        { title: '启动配置', desc: '留空时自动识别（pom.xml / yml）', fields: [
          ['mainClass', '主类入口', '留空=读 pom.xml 自动识别', false, ''],
          ['port', '端口', '留空=读 bootstrap/application.yml', false, ''],
          ['jarName', 'Jar 名', '留空=读 pom.xml finalName', false, ''],
        ] },
      ]
      const CFG_ALL = CFG_GROUPS.flatMap((g) => g.fields)

      // 构造配置草稿：已保存值优先；为空的路径字段自动填入探测值（detected）
      const buildCfgDraft = () => {
        const s = store.status || {}
        const saved = { ...(s.cfg || {}) }
        const det = s.detected || {}
        for (const [k, , , isPath, detKey] of CFG_ALL) {
          if (isPath && detKey && det[detKey] && !String(saved[k] || '').trim()) saved[k] = det[detKey]
        }
        return saved
      }
      const openConfig = () => {
        if (store.showConfig) { setStore({ showConfig: false, cfgDraft: null }); return }
        setStore({ showConfig: true, cfgDraft: buildCfgDraft() })
      }

      // ---------- 自绘目录选择对话框（完整中文标题，不依赖系统对话框标题被截断） ----------
      // store.picker: null 或 { key, title, path, listing, loading, manual, err }
      const openPicker = async (key, title) => {
        setStore({ picker: { key, title, path: '', listing: null, loading: true, manual: '', err: '' } })
        const listing = await loadListing('')
        if (listing) setStore({ picker: { key, title, path: listing.path, listing, loading: false, manual: listing.path, err: '' } })
      }
      const loadListing = async (path) => {
        try {
          const r = await workspaces.listDirectory(path || undefined)
          return r
        } catch (e) {
          setStore({ picker: Object.assign({}, store.picker, { loading: false, err: '读取目录失败：' + ((e && e.message) || e) }) })
          return null
        }
      }
      const navPicker = async (path) => {
        setStore({ picker: Object.assign({}, store.picker, { loading: true, err: '' }) })
        const listing = await loadListing(path)
        if (listing) setStore({ picker: Object.assign({}, store.picker, { path: listing.path, listing, loading: false, manual: listing.path }) })
      }
      const closePicker = () => setStore({ picker: null })
      const confirmPicker = () => {
        const p = store.picker
        if (!p) return
        const dir = String(p.manual || p.path || '').trim()
        if (!dir) return
        let val = dir
        if (p.key === 'javaPath') {
          const looksLikeBin = /[\\/]bin$/i.test(dir)
          val = (looksLikeBin ? dir : dir + '\\bin') + '\\java.exe'
          val = val.replace(/[\\/]{2,}/g, '\\')
        } else if (p.key === 'mavenHome') {
          val = dir.replace(/[\\/]+$/, '').replace(/[\\/]bin$/i, '')
        }
        setStore({ cfgDraft: Object.assign({}, store.cfgDraft || {}, { [p.key]: val }), picker: null })
      }

      // 「浏览…」：打开自绘目录选择器（标题完整显示选择目标）
      const browseDir = (key) => {
        const titles = {
          cwd: '选择项目目录（Spring Boot 工程根目录，含 pom.xml）',
          javaPath: '选择 JDK 目录（将自动补全 bin\\java.exe）',
          mavenHome: '选择 Maven 根目录（含 bin\\mvn.cmd）',
        }
        openPicker(key, titles[key] || '选择目录')
      }

      const Console = () => {
        const st = useStore()
        if (!st.open) return null
        return h(react.Fragment, null,
          h(ConsoleBody),
          st.picker ? h(PickerDialog) : null)
      }

      // 目录选择对话框：完整中文标题 + 面包屑 + 子目录列表 + 手输路径
      const PickerDialog = () => {
        const st = useStore()
        const p = st.picker || {}
        const listing = p.listing
        const crumbs = (listing && listing.crumbs) || []
        const entries = (listing && listing.entries) || []
        return h(react.Fragment, null,
          h('div', { className: 'sw-mask', style: { zIndex: 10000 }, onClick: closePicker }),
          h('div', { className: 'sw-picker', role: 'dialog', 'aria-label': p.title },
            h('div', { className: 'sw-phead' },
              h('span', { className: 'sw-ptitle' }, p.title || '选择目录'),
              h('span', { className: 'sw-spacer' }),
              h('button', { className: 'sw-hbtn', onClick: closePicker }, '✕')),
            h('div', { className: 'sw-pcrumbs' },
              crumbs.map((c, i) => h(react.Fragment, { key: c.path + ':' + i },
                i > 0 ? h('span', { className: 'sw-psep' }, '›') : null,
                h('button', { className: 'sw-pcrumb', onClick: () => navPicker(c.path) }, c.name)))),
            h('div', { className: 'sw-plist' },
              p.loading ? h('div', { className: 'sw-pempty' }, '读取中…')
                : entries.length === 0 ? h('div', { className: 'sw-pempty' }, '（无子目录）')
                : entries.map((e) => h('button', {
                    key: e.path, className: 'sw-prow', title: e.path,
                    onDoubleClick: () => navPicker(e.path),
                    onClick: () => setStore({ picker: Object.assign({}, p, { manual: e.path }) }),
                  }, '📁 ' + e.name + (e.hidden ? '（隐藏）' : '')))),
            p.err ? h('div', { className: 'sw-err', style: { padding: '4px 14px' } }, p.err) : null,
            h('div', { className: 'sw-pfoot' },
              h('span', { className: 'sw-plabel' }, '路径:'),
              h('input', {
                className: 'sw-input', value: p.manual || '',
                placeholder: '可直接输入完整路径，或双击上方目录进入',
                onChange: (e) => setStore({ picker: Object.assign({}, p, { manual: e.target.value }) }),
                onKeyDown: (e) => { if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); if (v) navPicker(v) } },
              }),
              h('button', { className: 'sw-hbtn', onClick: () => navPicker(String(p.manual || '').trim()) }, '转到'),
              h('span', { className: 'sw-spacer' }),
              h('button', { className: 'sw-hbtn', onClick: closePicker }, '取消'),
              h('button', { className: 'sw-hbtn primary', disabled: !String(p.manual || '').trim(), onClick: confirmPicker }, '选择此目录'))))
      }

      const ConsoleBody = () => {
        const st = useStore()
        const s = st.status || {}
        const info = phaseInfo(s.phase)
        const cfg = st.cfgDraft || (s.cfg || {})
        const busy = st.busy
        const phaseBusy = busy || s.phase === 'building' || s.phase === 'starting' || s.phase === 'stopping'
        const canStart = !phaseBusy && (s.phase === 'stopped' || s.phase === 'crashed' || !s.phase)
        const canStop = !busy && s.phase !== 'stopped' && s.phase !== 'crashed' && s.phase !== 'building'
        const up = s.phase === 'running' && s.startedAt ? Math.max(0, Math.floor(((s.now) || Date.now()) - s.startedAt) / 1000) : 0
        const upText = up ? (Math.floor(up / 3600) + ':' + String(Math.floor((up % 3600) / 60)).padStart(2, '0') + ':' + String(Math.floor(up % 60)).padStart(2, '0')) : '—'
        const label = s.jarName || 'kingdee-sync-server'
        const geo = st.consoleGeo || defaultGeo()
        return h(react.Fragment, null,
          h('div', {
            className: 'sw-console', role: 'dialog', 'aria-label': '后端服务控制台',
            style: { left: geo.x + 'px', top: geo.y + 'px', width: geo.w + 'px', height: geo.h + 'px' },
          },
            h('div', { className: 'sw-head', onPointerDown: beginDrag },
              h('span', { className: 'sw-dot ' + (s.phase === 'running' ? 'sw-pulse' : ''), style: { background: info.color } }),
              h('span', { className: 'sw-title' }, label),
              h('span', { className: 'sw-pill' }, info.text + (s.phase === 'running' && s.port ? ' · :' + s.port : '')),
              h('span', { className: 'sw-spacer' }),
              h('button', { className: 'sw-hbtn primary', disabled: !canStart, onClick: () => act('start', { mode: 'src' }) }, '▶ 源码启动'),
              h('button', { className: 'sw-hbtn', disabled: !canStart, onClick: () => act('start', { mode: 'jar' }) }, 'Jar 启动'),
              h('button', { className: 'sw-hbtn', disabled: !canStart, onClick: () => act('start', { mode: 'jar', rebuild: true }) }, '打包并启动'),
              h('button', { className: 'sw-hbtn danger', disabled: !canStop, onClick: () => act('stop') }, '■ 停止'),
              h('button', { className: 'sw-hbtn', disabled: !canStop, onClick: () => act('restart', { mode: s.mode || 'src' }) }, '⟳ 重启'),
              h('button', { className: 'sw-hbtn' + (st.showConfig ? ' on' : ''), onClick: openConfig }, '⚙ 配置'),
              h('button', { className: 'sw-hbtn', onClick: closeConsole }, '✕ 隐藏')),
            h('div', { className: 'sw-tabs' },
              h('button', { className: 'sw-tab' + (st.tab === 'app' ? ' on' : ''), onClick: () => setStore({ tab: 'app' }) }, '服务日志'),
              h('button', { className: 'sw-tab' + (st.tab === 'access' ? ' on' : ''), onClick: () => setStore({ tab: 'access' }) }, '请求日志'),
              h('button', { className: 'sw-tab' + (st.tab === 'build' ? ' on' : ''), onClick: () => setStore({ tab: 'build' }) }, '编译输出'),
              h('span', { className: 'sw-spacer' }),
              h('button', { className: 'sw-tab small' + (st.paused ? ' on' : ''), onClick: () => setStore({ paused: !st.paused }) }, st.paused ? '▶ 继续抓取' : '⏸ 暂停抓取'),
              h('button', { className: 'sw-tab small' + (st.follow ? ' on' : ''), onClick: () => setStore({ follow: !st.follow }) }, '⇩ 跟随滚动'),
              // 清屏：只清当前激活页签的显示内容；读取偏移保留 → 下次轮询只追加新输出，历史日志不会闪回
              h('button', { className: 'sw-tab small', onClick: () => {
                const patch = {}
                if (store.tab === 'app') patch.logs = ''
                else if (store.tab === 'access') patch.access = ''
                else if (store.tab === 'build') patch.build = ''
                setStore(patch)
              } }, '✕ 清屏'),
              h('button', { className: 'sw-tab small', onClick: copyLogs }, '⧉ 复制' + (st.copied ? '（' + st.copied + '）' : ''))),
            h('div', { className: 'sw-logwrap' }, h(LogView)),
            st.error ? h('div', { className: 'sw-err', style: { padding: '4px 14px' } }, st.error) : null,
            s.lastError ? h('div', { className: 'sw-err', style: { padding: '4px 14px' } }, s.lastError) : null,
            st.showConfig ? h('div', { className: 'sw-cfgbar' },
              h('div', { className: 'sw-cfghead' },
                h('span', { className: 'sw-cfgtitle' }, '服务配置'),
                h('span', { className: 'sw-spacer' }),
                h('span', { className: 'sw-note' }, '保存在 ~/.dsh/spring-widget.json')),
              CFG_GROUPS.map((grp) => h('div', { className: 'sw-cfggrp', key: grp.title },
                h('div', { className: 'sw-cfggrphead' },
                  h('span', { className: 'sw-cfggrptitle' }, grp.title),
                  h('span', { className: 'sw-cfggrpdesc' }, grp.desc)),
                grp.fields.map(([k, labelText, ph, isPath, detKey]) => {
                  const det = (s.detected || {})[k]
                  const filled = isPath && det && String(cfg[k] || '').trim() === det
                  const field = h('div', { className: 'sw-cfground', key: k },
                    h('div', { className: 'sw-cfglabelwrap' },
                      h('span', { className: 'sw-cfglabel' }, labelText),
                      filled ? h('span', { className: 'sw-cfgcheck' }, '✓ 自动检测') : null),
                    h('input', {
                      className: 'sw-input', placeholder: ph,
                      value: String(cfg[k] === undefined || cfg[k] === null ? '' : cfg[k]),
                      onChange: (e) => setStore({ cfgDraft: Object.assign({}, cfg, { [k]: e.target.value }) }),
                    }),
                    isPath
                      ? h('button', {
                          className: 'sw-hbtn sw-browse', style: { flex: 'none' },
                          title: '打开文件资源管理器选择' + (k === 'javaPath' ? ' JDK 目录（自动补 bin\\java.exe）' : k === 'mavenHome' ? ' Maven 目录' : '项目目录'),
                          onClick: () => browseDir(k),
                        }, '浏览…')
                      : h('span', null))
                  return field
                }))),
              h('div', { className: 'sw-cfgactions' },
                h('button', { className: 'sw-hbtn primary', disabled: st.busy, onClick: saveCfg }, '保存并重新探测'),
                h('button', { className: 'sw-hbtn', onClick: () => setStore({ cfgDraft: buildCfgDraft() }) }, '还原'),
                h('span', { className: 'sw-note' }, '空白路径字段已自动检测填入（标 ✓）；JDK 支持填根目录/bin/java.exe，Maven 支持根目录/bin'))) : null,
            h('div', { className: 'sw-statusline' },
              h('span', null, 'PID: ' + (s.pid ? String(s.pid) : '—')),
              h('span', null, '端口: ' + (s.port ? String(s.port) : '—')),
              h('span', null, '运行: ' + upText),
              h('span', null, '方式: ' + (s.mode === 'src' ? '源码直启' : 'Jar')),
              h('span', null, '主类: ' + (s.mainClass || '自动识别')),
              h('span', null, '目录: ' + (s.cwd || '—'))),
            h('div', { className: 'sw-resize', title: '拖动调整大小', onPointerDown: beginResize })))
      }

      // 顶栏常驻微件：utilities（标题右侧操作组之右）；控制台走全局 overlay
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-spring-widget', order: 10, label: '后端服务' },
        () => h(HeaderRunWidget)))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'dsh-spring-widget-console', order: 60, label: '后端服务控制台' },
        () => h(Console)))
    }

    return { name, inject, apply }
  },
})
