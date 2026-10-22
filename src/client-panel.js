/**
 * DSH client plugin body for the workbench page.
 *
 * Inlined by `tools/build.mjs` into the generated client bundle, where
 * `WB_ENGINE` (the shared chart engine), `React`, and `WORKBENCH_BASE_PATH`
 * are already in scope. The panel registers one `main` occupant plus its
 * sidebar entry; both share the component id, so the sidebar row opens it.
 */
const PANEL_ID = 'dsh-workbench'
const NS = 'dshWorkbench'
const LOCALE = {
  zh: { panel: '工作台' },
  en: { panel: 'Workbench' },
}

/** Fetch the host's aggregated payload, falling back to the embedded snapshot. */
async function loadPayload() {
  const response = await fetch(WORKBENCH_BASE_PATH + '/api/summary', {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return await response.json()
}

/** Fetch the live "正在处理" payload. */
async function loadActive() {
  const response = await fetch(WORKBENCH_BASE_PATH + '/api/active', {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return await response.json()
}

/** Parse the payload embedded in the pre-generated dashboard snapshot. */
function parseEmbedded(html) {
  const match = /<script type="application\/json" id="wb-payload">([\s\S]*?)<\/script>/.exec(html)
  if (match === null) throw new Error('页面内未找到数据载荷')
  return JSON.parse(match[1])
}

/**
 * The workbench page: renders the shared chart engine into a plain container.
 *
 * The engine owns its own DOM, so the component only mounts, refreshes, and
 * disposes it. A slow poll keeps the panel live without making DSH re-render
 * the charts.
 */
function WorkbenchPanel() {
  const containerRef = React.useRef(null)
  const [status, setStatus] = React.useState('loading')
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    const style = document.createElement('style')
    style.textContent = __WB_CSS__
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  React.useEffect(() => {
    const host = containerRef.current
    if (host === null) return undefined
    let disposer = null
    let poll = null
    let activePoll = null
    let activeIntervalMs = 10000
    let disposed = false

    const mount = (payload) => {
      if (disposed) return
      if (disposer !== null) disposer()
      disposer = WB_ENGINE.renderWorkbench(host, payload, {
        refresh: loadPayload,
        compact: true,
        liveActive: true,
      })
      paintActive()
    }

    const paintActive = () => {
      const section = host.querySelector('[data-wb-active]')
      if (section === null) return
      loadActive()
        .then((data) => {
          if (disposed) return
          WB_ENGINE.renderActiveSection(section, data)
          const next = Number.isFinite(data?.refreshMs) ? Math.min(60000, Math.max(1000, data.refreshMs)) : activeIntervalMs
          if (next !== activeIntervalMs) {
            activeIntervalMs = next
            scheduleActive()
          }
        })
        .catch(() => {
          if (!disposed) WB_ENGINE.renderActiveSection(section, null)
        })
    }

    const scheduleActive = () => {
      if (activePoll !== null) clearInterval(activePoll)
      activePoll = setInterval(paintActive, activeIntervalMs)
    }

    const tick = () => {
      loadPayload()
        .then((payload) => {
          if (disposed) return
          mount(payload)
          setError('')
          setStatus('ready')
        })
        .catch((cause) => {
          if (disposed) return
          if (disposer === null) {
            const text = String((cause && cause.message) || cause)
            fetch(WORKBENCH_BASE_PATH + '/dashboard.html')
              .then((response) => (response.ok ? response.text() : Promise.reject(new Error('HTTP ' + response.status))))
              .then((html) => {
                if (disposed) return
                mount(parseEmbedded(html))
                setError(text + '（已回退到内置快照）')
                setStatus('ready')
              })
              .catch(() => {
                if (disposed) return
                setError(text)
                setStatus('error')
              })
          } else {
            setError(String((cause && cause.message) || cause))
          }
        })
    }

    tick()
    poll = setInterval(tick, 30000)
    scheduleActive()
    return () => {
      disposed = true
      if (poll !== null) clearInterval(poll)
      if (activePoll !== null) clearInterval(activePoll)
      if (disposer !== null) disposer()
    }
  }, [])

  // The container must exist in every state: the mount effect reads its ref, so a
  // loading placeholder that replaced the container would leave the ref null and
  // the panel stuck on that placeholder forever. Status text is an absolutely
  // positioned overlay instead, which also keeps the chart engine's own DOM
  // untouched (it clears and repaints its host directly).
  return React.createElement(
    'div',
    { className: 'wb-panel', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    React.createElement(
      'div',
      { className: 'wb-panel-frame', style: { flex: '1 1 auto', minHeight: 0, position: 'relative' } },
      React.createElement('div', {
        ref: containerRef,
        className: 'wb-panel-host',
        style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' },
      }),
      status === 'loading'
        ? React.createElement('div', { className: 'wb-status' }, '正在读取语言模型调用统计…')
        : null,
      status === 'error'
        ? React.createElement(
            'div',
            { className: 'wb-status wb-status-error' },
            React.createElement('h1', { className: 'wb-title' }, '工作台'),
            React.createElement('p', { className: 'wb-empty' }, '无法读取统计数据：' + error),
            React.createElement('p', { className: 'wb-coverage' }, '宿主路由 ' + WORKBENCH_BASE_PATH + '/api/summary'),
          )
        : null,
    ),
    error !== '' && status === 'ready'
      ? React.createElement('div', { className: 'wb-status wb-warn', style: { padding: '8px 20px 0' } }, error)
      : null,
  )
}

/** Sidebar icon: a small bar-chart glyph that inherits the row's color. */
function WorkbenchIcon() {
  return React.createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    React.createElement('rect', { x: 1.5, y: 8.5, width: 3, height: 6, rx: 1, fill: 'currentColor' }),
    React.createElement('rect', { x: 6.5, y: 4.5, width: 3, height: 10, rx: 1, fill: 'currentColor' }),
    React.createElement('rect', { x: 11.5, y: 1.5, width: 3, height: 13, rx: 1, fill: 'currentColor' }),
  )
}

/** Services the panel needs before it registers into the shell. */
const inject = ['slots', 'locale']

/**
 * Register the workbench page into the main panel and the sidebar list.
 * @param ctx - browser plugin context.
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, LOCALE), 'dsh-workbench: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        order: -10,
        inject: () => ({}),
      },
      WorkbenchPanel,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: -10,
        label: () => t('panel'),
        locale: NS,
      },
      WorkbenchIcon,
    ),
  )
}

module.exports = { apply, inject, PANEL_ID }
