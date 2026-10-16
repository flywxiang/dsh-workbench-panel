/**
 * Workbench chart engine: dependency-free SVG/DOM rendering for the payload
 * produced by `workbench-data.mjs`.
 *
 * The same engine draws the standalone dashboard page and the in-GUI sidebar
 * panel, so both surfaces can never disagree about a number or a color. It
 * touches no framework and no global but the document it is handed, and it
 * re-renders a chart in place when a control changes.
 *
 * Theming reads CSS custom properties from the host element and falls back to
 * light-mode values, so an embedding host can restyle the whole page by
 * defining a handful of tokens.
 */
import {
  HOURS,
  METRICS,
  WEEKDAYS,
  formatMetricValue,
  formatMs,
  formatTokens,
  heatLevel,
  isoWeekdayOf,
} from './workbench-data.mjs'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Chart geometry, in CSS pixels of the live container width. */
const CHART = {
  trendHeight: 240,
  latencyHeight: 170,
  heatCell: 20,
  heatGap: 2,
  padTop: 12,
  padBottom: 26,
  padLeft: 56,
  padRight: 12,
}

/**
 * Create one SVG element with attributes.
 * @param {Document} doc - owner document.
 * @param {string} tag - SVG tag name.
 * @param {Record<string, string | number>} [attributes] - attribute map.
 * @returns {SVGElement} the created element.
 */
function svgEl(doc, tag, attributes = {}) {
  const node = doc.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

/**
 * Create one HTML element with attributes, text, and children.
 * @param {Document} doc - owner document.
 * @param {string} tag - tag name.
 * @param {Record<string, string>} [attributes] - attribute map.
 * @param {(Node | string)[]} [children] - child nodes.
 * @returns {HTMLElement} the created element.
 */
function el(doc, tag, attributes = {}, children = []) {
  const node = doc.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value
    else if (name === 'text') node.textContent = value
    else node.setAttribute(name, value)
  }
  for (const child of children) node.append(child)
  return node
}

/**
 * Pick the largest "nice" axis maximum at or above a data maximum.
 * @param {number} max - data maximum.
 * @returns {number} axis maximum, at least 1.
 */
function niceMax(max) {
  if (!Number.isFinite(max) || max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude
    if (candidate >= max) return candidate
  }
  return 10 * magnitude
}

/**
 * Read a theme token from a host element, with a fallback.
 * @param {HTMLElement} host - element carrying the tokens.
 * @param {string} name - custom property name.
 * @param {string} fallback - value when unset.
 * @returns {string} resolved value.
 */
function token(host, name, fallback) {
  const value = getComputedStyleSafe(host).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/**
 * Read computed style defensively (jsdom-free hosts may lack it).
 * @param {HTMLElement} host - element to inspect.
 * @returns {CSSStyleDeclaration} computed style or an empty shim.
 */
function getComputedStyleSafe(host) {
  if (typeof host.ownerDocument?.defaultView?.getComputedStyle === 'function') {
    return host.ownerDocument.defaultView.getComputedStyle(host)
  }
  return { getPropertyValue: () => '' }
}

/**
 * Format an epoch-millisecond instant for the coverage line.
 * @param {number | null} epochMs - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {string} local date and time, or a dash.
 */
function formatInstant(epochMs, timeZone) {
  if (epochMs === null) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs))
}

/**
 * Shorten a `provider/model` label for axes and legends.
 * @param {string} label - full series label.
 * @returns {string} display label.
 */
export function shortModelLabel(label) {
  const [provider, model = ''] = label.split('/')
  const shortProvider = provider.replace(/-official$/, '').replace(/-coding$/, '').replace(/-isc$/, '')
  return `${shortProvider}/${model}`
}

/**
 * Render the complete workbench into a host element.
 *
 * @param {HTMLElement} host - container to own; its children are replaced.
 * @param {object} payload - payload from `buildWorkbenchPayload`.
 * @param {object} [options]
 * @param {(payload: object) => Promise<object>} [options.refresh] - re-fetch hook; enables the refresh button.
 * @param {boolean} [options.compact] - tighter layout for a narrow panel.
 * @returns {() => void} disposer that stops observing container resizes.
 */
export function renderWorkbench(host, payload, options = {}) {
  const doc = host.ownerDocument
  let current = payload
  const state = {
    trendMetric: 'calls',
    latencyMetric: 'llmAvgSeconds',
    heatScope: '__all__',
  }

  host.classList.add('wb-root')
  if (options.compact) host.classList.add('wb-compact')

  const status = el(doc, 'div', { className: 'wb-status' })
  const kpis = el(doc, 'div', { className: 'wb-kpis' })
  const legend = el(doc, 'div', { className: 'wb-legend' })
  const trendChart = el(doc, 'div', { className: 'wb-chart' })
  const latencyChart = el(doc, 'div', { className: 'wb-chart wb-chart-short' })
  const heatChart = el(doc, 'div', { className: 'wb-heat' })
  const heatLegend = el(doc, 'div', { className: 'wb-heat-legend' })
  const heatMeta = el(doc, 'div', { className: 'wb-heat-meta' })
  const coverage = el(doc, 'div', { className: 'wb-coverage' })

  const trendButtons = new Map()
  const trendBar = el(doc, 'div', { className: 'wb-controls' })
  for (const metric of [METRICS.calls, METRICS.tokens, METRICS.llmTime]) {
    const button = el(doc, 'button', { className: 'wb-btn', type: 'button', text: metric.label })
    button.addEventListener('click', () => {
      state.trendMetric = metric.id
      drawTrend()
    })
    trendButtons.set(metric.id, button)
    trendBar.append(button)
  }

  const latencyButtons = new Map()
  const latencyBar = el(doc, 'div', { className: 'wb-controls' })
  for (const key of METRICS.latency.keys) {
    const button = el(doc, 'button', { className: 'wb-btn', type: 'button', text: key.label })
    button.addEventListener('click', () => {
      state.latencyMetric = key.key
      drawLatency()
    })
    latencyButtons.set(key.key, button)
    latencyBar.append(button)
  }

  const heatSelect = el(doc, 'select', { className: 'wb-select' })
  heatSelect.addEventListener('change', () => {
    state.heatScope = heatSelect.value
    drawHeatmap()
  })

  const refreshButton = el(doc, 'button', { className: 'wb-btn wb-btn-ghost', type: 'button', text: '刷新' })
  if (typeof options.refresh === 'function') {
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true
      refreshButton.textContent = '刷新中…'
      try {
        current = await options.refresh(current)
        paint()
      } catch (error) {
        status.textContent = `刷新失败：${String(error?.message ?? error)}`
        status.classList.add('wb-status-error')
      } finally {
        refreshButton.disabled = false
        refreshButton.textContent = '刷新'
      }
    })
  } else {
    refreshButton.hidden = true
  }

  host.replaceChildren(
    el(doc, 'header', { className: 'wb-header' }, [
      el(doc, 'div', { className: 'wb-title-wrap' }, [
        el(doc, 'h1', { className: 'wb-title', text: '工作台' }),
        el(doc, 'p', {
          className: 'wb-subtitle',
          text: '仅统计语言模型调用 · 每日趋势与调用热力图',
        }),
      ]),
      el(doc, 'div', { className: 'wb-header-actions' }, [refreshButton]),
    ]),
    status,
    kpis,
    el(doc, 'section', { className: 'wb-section' }, [
      el(doc, 'div', { className: 'wb-section-head' }, [
        el(doc, 'h2', { className: 'wb-h2', text: '调用热力图' }),
        heatSelect,
      ]),
      heatLegend,
      heatMeta,
      heatChart,
    ]),
    el(doc, 'section', { className: 'wb-section' }, [
      el(doc, 'div', { className: 'wb-section-head' }, [
        el(doc, 'h2', { className: 'wb-h2', text: '每日趋势' }),
        trendBar,
      ]),
      legend,
      trendChart,
    ]),
    el(doc, 'section', { className: 'wb-section' }, [
      el(doc, 'div', { className: 'wb-section-head' }, [
        el(doc, 'h2', { className: 'wb-h2', text: '延迟趋势' }),
        latencyBar,
      ]),
      latencyChart,
    ]),
    coverage,
  )

  /** Repaint every region from the current payload and control state. */
  function paint() {
    paintStatus()
    paintKpis()
    paintLegend()
    paintHeatOptions()
    drawTrend()
    drawLatency()
    drawHeatmap()
    paintCoverage()
  }

  function paintStatus() {
    const { window, scan, totals } = current
    status.classList.remove('wb-status-error')
    status.replaceChildren(
      el(doc, 'span', {
        text: `${window.from ?? '—'} → ${window.to ?? '—'} · ${window.days} 天窗口 · 会话 ${scan.sessions} · 调用 ${totals.calls.toLocaleString('en-US')}`,
      }),
      el(doc, 'span', {
        className: 'wb-status-dim',
        text: `更新于 ${formatInstant(current.generatedAt, current.timeZone)}（${current.timeZone}）`,
      }),
    )
    if (scan.failures > 0) {
      status.append(el(doc, 'span', { className: 'wb-warn', text: `解析失败 ${scan.failures} 个会话` }))
    }
  }

  function paintKpis() {
    const { totals, usage, latency } = current
    const { inputTokens, outputTokens, cacheReadTokens, reasoningTokens } = usage
    const cards = [
      { label: 'LLM 调用', value: totals.calls.toLocaleString('en-US'), hint: `覆盖 ${totals.activeDays} 天` },
      { label: 'Token 总量', value: formatTokens(usage.inputTokens + usage.outputTokens + cacheReadTokens + reasoningTokens), hint: `输出 ${formatTokens(usage.outputTokens)}` },
      { label: '缓存读取', value: formatTokens(usage.cacheReadTokens), hint: `占输入 ${(usage.cacheReadTokens / Math.max(usage.inputTokens + usage.cacheReadTokens, 1) * 100).toFixed(0)}%` },
      { label: '平均响应', value: formatMs(latency.avgResponseMs), hint: `P50 ${formatMs(latency.p50ResponseMs)}` },
      { label: '平均首字', value: formatMs(latency.avgTtftMs), hint: `P50 ${formatMs(latency.p50TtftMs)}` },
      { label: '模型数', value: String(totals.models), hint: `会话 ${totals.sessions}` },
    ]
    kpis.replaceChildren(
      ...cards.map((card) =>
        el(doc, 'div', { className: 'wb-kpi' }, [
          el(doc, 'div', { className: 'wb-kpi-label', text: card.label }),
          el(doc, 'div', { className: 'wb-kpi-value', text: card.value }),
          el(doc, 'div', { className: 'wb-kpi-hint', text: card.hint }),
        ]),
      ),
    )
  }

  function paintLegend() {
    const metric = METRICS[state.trendMetric]
    const keys = metric.keys ?? [{ key: metric.id, label: metric.label }]
    legend.replaceChildren(
      ...current.models.map((model) =>
        el(doc, 'span', { className: 'wb-legend-item' }, [
          el(doc, 'i', { className: 'wb-swatch', style: `background:${model.color}` }),
          el(doc, 'span', { title: model.label, text: shortModelLabel(model.label) }),
        ]),
      ),
      keys.length > 1
        ? el(doc, 'span', {
            className: 'wb-legend-note',
            text: `堆叠顺序：${keys.map((key) => key.label).join(' → ')}`,
          })
        : '',
    )
  }

  function paintHeatOptions() {
    const previous = state.heatScope
    const options = [el(doc, 'option', { value: '__all__', text: '全部模型' })]
    for (const model of current.models) {
      options.push(el(doc, 'option', { value: model.label, text: `${shortModelLabel(model.label)}（${model.calls}）` }))
    }
    heatSelect.replaceChildren(...options)
    state.heatScope = current.heatmap.byModel[previous] === undefined && previous !== '__all__' ? '__all__' : previous
    heatSelect.value = state.heatScope
  }

  /** Draw the stacked daily trend for the selected metric. */
  function drawTrend() {
    for (const [id, button] of trendButtons) button.classList.toggle('wb-btn-active', id === state.trendMetric)
    const metric = METRICS[state.trendMetric]
    const series = current.trends[state.trendMetric]
    const keys = metric.keys ?? [{ key: metric.id, label: metric.label }]
    const width = Math.max(320, trendChart.clientWidth || host.clientWidth || 720)
    const height = CHART.trendHeight
    const plotWidth = width - CHART.padLeft - CHART.padRight
    const plotHeight = height - CHART.padTop - CHART.padBottom
    const buckets = series.buckets
    const step = plotWidth / Math.max(buckets.length, 1)
    const barWidth = Math.max(2, Math.min(22, step * 0.72))
    const axisMax = niceMax(Math.max(...buckets.map((bucket) => stackTotal(bucket, keys)), 0))
    const svg = svgEl(doc, 'svg', { width, height, class: 'wb-svg', role: 'img' })

    for (const tick of axisTicks(axisMax, 4)) {
      const y = CHART.padTop + plotHeight - (tick / axisMax) * plotHeight
      svg.append(
        svgEl(doc, 'line', {
          x1: CHART.padLeft,
          x2: width - CHART.padRight,
          y1: y,
          y2: y,
          class: 'wb-grid',
        }),
        textNode(doc, CHART.padLeft - 8, y + 4, formatMetricValue(metric.id, tick), 'wb-axis wb-axis-y'),
      )
    }

    buckets.forEach((bucket, index) => {
      const x = CHART.padLeft + index * step + (step - barWidth) / 2
      let cursor = CHART.padTop + plotHeight
      for (const model of current.models) {
        for (const key of keys) {
          const value = bucket.values[key.key]?.[model.label] ?? 0
          if (value <= 0) continue
          const segment = (value / axisMax) * plotHeight
          cursor -= segment
          svg.append(
            svgEl(doc, 'rect', {
              x,
              y: cursor,
              width: barWidth,
              height: Math.max(segment, 0.6),
              fill: keys.length === 1 ? model.color : shade(model.color, key.key, keys),
              class: 'wb-bar',
            }),
          )
        }
      }
      const hit = svgEl(doc, 'rect', {
        x: CHART.padLeft + index * step,
        y: CHART.padTop,
        width: step,
        height: plotHeight,
        class: 'wb-bar-hit',
      })
      const total = stackTotal(bucket, keys)
      const tooltip = svgEl(doc, 'title', {})
      tooltip.textContent = `${bucket.day}\n${keys
        .map((key) => `${key.label} ${formatMetricValue(key.key, keyTotal(bucket, key.key))}`)
        .join('\n')}\n合计 ${formatMetricValue(metric.id, total)}`
      hit.append(tooltip)
      svg.append(hit)
    })

    const labelEvery = Math.max(1, Math.ceil(buckets.length / 12))
    buckets.forEach((bucket, index) => {
      if (index % labelEvery !== 0 && index !== buckets.length - 1) return
      svg.append(textNode(doc, CHART.padLeft + index * step + step / 2, height - 8, bucket.day.slice(5), 'wb-axis wb-axis-x'))
    })

    trendChart.replaceChildren(svg)
  }

  /** Draw the mean-latency line chart for the selected latency key. */
  function drawLatency() {
    for (const [id, button] of latencyButtons) button.classList.toggle('wb-btn-active', id === state.latencyMetric)
    const series = current.trends.latency
    const keyMeta = series.keys.find((key) => key.key === state.latencyMetric) ?? series.keys[0]
    const width = Math.max(320, latencyChart.clientWidth || host.clientWidth || 720)
    const height = CHART.latencyHeight
    const plotWidth = width - CHART.padLeft - CHART.padRight
    const plotHeight = height - CHART.padTop - CHART.padBottom
    const buckets = series.buckets
    const step = plotWidth / Math.max(buckets.length - 1, 1)
    let dataMax = 0
    for (const bucket of buckets) {
      for (const model of current.models) dataMax = Math.max(dataMax, bucket.values[keyMeta.key]?.[model.label] ?? 0)
    }
    const axisMax = niceMax(dataMax)
    const scaleY = (value) => CHART.padTop + plotHeight - (value / axisMax) * plotHeight
    const scaleX = (index) => CHART.padLeft + index * step
    const svg = svgEl(doc, 'svg', { width, height, class: 'wb-svg', role: 'img' })

    for (const tick of axisTicks(axisMax, 4)) {
      const y = scaleY(tick)
      svg.append(svgEl(doc, 'line', { x1: CHART.padLeft, x2: width - CHART.padRight, y1: y, y2: y, class: 'wb-grid' }))
      svg.append(textNode(doc, CHART.padLeft - 8, y + 4, formatLatencyTick(keyMeta.key, tick), 'wb-axis wb-axis-y'))
    }

    for (const model of current.models) {
      let path = ''
      let previousWasValue = false
      buckets.forEach((bucket, index) => {
        const value = bucket.values[keyMeta.key]?.[model.label]
        const x = scaleX(index)
        if (value === null || value === undefined) {
          previousWasValue = false
          return
        }
        const y = scaleY(value)
        path += `${previousWasValue ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
        previousWasValue = true
        svg.append(svgEl(doc, 'circle', { cx: x, cy: y, r: 1.8, fill: model.color, class: 'wb-dot' }))
      })
      if (path !== '') {
        svg.append(
          svgEl(doc, 'path', {
            d: path,
            fill: 'none',
            stroke: model.color,
            'stroke-width': 1.6,
            'stroke-linejoin': 'round',
            class: 'wb-line',
          }),
        )
      }
    }

    const labelEvery = Math.max(1, Math.ceil(buckets.length / 12))
    buckets.forEach((bucket, index) => {
      if (index % labelEvery !== 0 && index !== buckets.length - 1) return
      svg.append(textNode(doc, scaleX(index), height - 8, bucket.day.slice(5), 'wb-axis wb-axis-x'))
    })

    latencyChart.replaceChildren(svg)
  }

  /**
   * Draw the call heatmap as a contribution graph.
   *
   * Geometry, level cuts, colour language and legend are ported from OpenClaw's
   * own usage heatmap so the two read as the same component: 11px cells on a
   * 14px pitch, weekday labels every other row, one month label per column that
   * opens a new month, and five accent-mixed levels cut at the 25/50/75th
   * percentile of the days that actually had a call. The board keeps OpenClaw's
   * fixed 116px height and draws its own trailing year (`heatmapDaily`), so the
   * graph has the ~53 week-columns that make a contribution graph legible no
   * matter how narrow the trend window is.
   * @returns {void}
   */
  function drawHeatmap() {
    const days = Array.isArray(current.heatmapDaily) ? current.heatmapDaily : current.dailyTotals
    if (days.length === 0) {
      heatChart.replaceChildren(el(doc, 'p', { className: 'wb-empty', text: '没有数据' }))
      heatLegend.replaceChildren()
      heatMeta.replaceChildren()
      return
    }
    const timeZone = current.timeZone
    const cell = 11
    const pitch = 14
    const labelW = 30
    const labelH = 18
    const boardH = 116
    const byDay = new Map(days.map((day) => [day.day, day]))

    /**
     * Shift a `YYYY-MM-DD` key by whole days. Anchoring at UTC noon and moving in
     * UTC keeps this clear of DST: a local-midnight date can sit 23 or 25 hours
     * from its neighbour, a UTC-noon date is always exactly 24.
     * @param {string} key - day key to shift.
     * @param {number} delta - whole days to add, negative to go back.
     * @returns {string} the shifted day key.
     */
    const shiftDay = (key, delta) => {
      const date = new Date(`${key}T12:00:00Z`)
      date.setUTCDate(date.getUTCDate() + delta)
      return date.toISOString().slice(0, 10)
    }

    // Open whole week columns around the window: begin on the Monday of the week
    // the window opens in and end on the Sunday of the week it closes in.
    const firstKey = days[0].day
    const lastKey = days[days.length - 1].day
    const firstWeekday = isoWeekdayOf(new Date(`${firstKey}T12:00:00`).getTime(), timeZone)
    const lastWeekday = isoWeekdayOf(new Date(`${lastKey}T12:00:00`).getTime(), timeZone)
    const gridStart = shiftDay(firstKey, -(firstWeekday - 1))
    const gridEnd = shiftDay(lastKey, 7 - lastWeekday)
    const weekCount = Math.round(
      (Date.parse(`${gridEnd}T00:00:00Z`) - Date.parse(`${gridStart}T00:00:00Z`)) / 604800000,
    ) + 1

    // Five levels cut at the quartiles of the days that had a call, so one busy
    // outlier cannot flatten everything else into level 1. Zero-call days stay at
    // level 0 whatever the quartiles say.
    const counts = days.map((day) => day.calls).filter((n) => n > 0).sort((a, b) => a - b)
    const quantile = (p) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] ?? 0
    const thresholds = counts.length === 0 ? [0, 0, 0] : [quantile(0.25), quantile(0.5), quantile(0.75)]
    function levelFor(calls) {
      if (calls <= 0) return 0
      if (calls < thresholds[0]) return 1
      if (calls < thresholds[1]) return 2
      if (calls < thresholds[2]) return 3
      return 4
    }

    const width = labelW + weekCount * pitch - (pitch - cell)
    const svg = svgEl(doc, 'svg', {
      viewBox: `0 0 ${width} ${boardH}`,
      width,
      height: boardH,
      style: `--wb-heat-width: ${width}px`,
      class: 'wb-svg wb-svg-heat',
      role: 'group',
      'aria-label': '调用热力图',
    })
    for (const row of [1, 3, 5]) {
      svg.append(textNode(doc, labelW - 6, labelH + row * pitch + cell / 2 + 4, WEEKDAYS[row], 'wb-heat-wday'))
    }
    const monthFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: timeZone, month: 'numeric' })
    let labelledMonth = null
    for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
      const colX = labelW + weekIndex * pitch
      let columnMonth = null
      for (let wday = 0; wday < 7; wday += 1) {
        const dayKey = shiftDay(gridStart, weekIndex * 7 + wday)
        if (dayKey < firstKey || dayKey > lastKey) continue
        if (columnMonth === null) columnMonth = dayKey.slice(0, 7)
        const calls = byDay.get(dayKey)?.calls ?? 0
        const isToday = dayKey === lastKey
        const rect = svgEl(doc, 'rect', {
          x: colX,
          y: labelH + wday * pitch,
          width: cell,
          height: cell,
          rx: 2.5,
          class: `wb-heat-cell wb-heat-${levelFor(calls)}${isToday ? ' wb-heat-today' : ''}`,
        })
        rect.append(svgEl(doc, 'title', {}))
        rect.firstChild.textContent = `${dayKey} · ${calls} 次${isToday ? '（今天）' : ''}`
        svg.append(rect)
      }
      if (columnMonth !== null && columnMonth !== labelledMonth) {
        labelledMonth = columnMonth
        svg.append(textNode(doc, colX, 10, monthFmt.format(new Date(`${columnMonth}-01T12:00:00`)), 'wb-heat-month'))
      }
    }
    heatChart.replaceChildren(svg)

    heatLegend.replaceChildren(
      el(doc, 'span', { className: 'wb-heat-legend-label', text: '少' }),
      ...[0, 1, 2, 3, 4].map((level) => el(doc, 'span', { className: `wb-heat-swatch wb-heat-${level}` })),
      el(doc, 'span', { className: 'wb-heat-legend-label', text: '多' }),
    )

    const { highlights } = current
    const peakDay = highlights.peakDay
    const wow = highlights.weekOverWeek
    heatMeta.replaceChildren(
      el(doc, 'span', {
        text: state.heatScope === '__all__' ? '每格 = 一天，颜色深浅 = 当日调用次数' : `当前按全部模型显示（按模型视图仅在 7×24 视图可用）`,
      }),
      peakDay ? el(doc, 'span', { text: `峰值日 ${peakDay.day}（${peakDay.calls} 次）` }) : null,
      wow
        ? el(doc, 'span', {
            text: `近 7 天 ${wow.recent} 次，较前 7 天 ${wow.delta >= 0 ? '+' : ''}${wow.delta}`,
          })
        : null,
    )
  }

  function paintCoverage() {
    const { coverage: ratios, totals, scan, filter } = current
    const parts = [
      `Token 用量覆盖 ${(ratios.usage * 100).toFixed(1)}%（${totals.usageCalls}/${totals.calls} 次调用携带 usage）`,
      `首字延迟覆盖 ${(ratios.ttft * 100).toFixed(1)}%`,
      `响应时长覆盖 ${(ratios.response * 100).toFixed(1)}%`,
      `已排除非语言模型调用${filter.auxiliaryCalls > 0 ? `（另有 ${filter.auxiliaryCalls} 次辅助调用未计入）` : ''}`,
      `日志 ${(scan.bytes / 1024 / 1024).toFixed(1)} MB，解析 ${(scan.decodeMs / 1000).toFixed(2)} s`,
    ]
    coverage.replaceChildren(...parts.map((text) => el(doc, 'span', { text })))
  }

  paint()

  // Re-render charts at the container's real width so axis text stays crisp.
  let pending = null
  const observer =
    typeof host.ownerDocument.defaultView?.ResizeObserver === 'function'
      ? new host.ownerDocument.defaultView.ResizeObserver(() => {
          if (pending !== null) clearTimeout(pending)
          pending = setTimeout(() => {
            pending = null
            drawTrend()
            drawLatency()
          }, 60)
        })
      : null
  observer?.observe(host)

  return () => {
    if (pending !== null) clearTimeout(pending)
    observer?.disconnect()
  }
}

/**
 * Sum a bucket's stacked values across the metric's keys.
 * @param {object} bucket - trend bucket.
 * @param {{key: string}[]} keys - metric keys.
 * @returns {number} total.
 */
function stackTotal(bucket, keys) {
  let total = 0
  for (const model of Object.keys(bucket.values[keys[0].key] ?? {})) {
    for (const key of keys) total += bucket.values[key.key]?.[model] ?? 0
  }
  return total
}

/**
 * Sum one key over every model in a bucket.
 * @param {object} bucket - trend bucket.
 * @param {{key: string}} key - metric key.
 * @returns {number} key total.
 */
function keyTotal(bucket, key) {
  let total = 0
  for (const value of Object.values(bucket.values[key.key] ?? {})) total += value
  return total
}

/**
 * Build evenly spaced axis ticks.
 * @param {number} axisMax - axis maximum.
 * @param {number} count - tick count.
 * @returns {number[]} tick values from 0 to axisMax.
 */
function axisTicks(axisMax, count) {
  return Array.from({ length: count + 1 }, (_, index) => (axisMax / count) * index)
}

/**
 * Format a latency axis tick.
 * @param {string} key - latency metric key.
 * @param {number} value - tick value.
 * @returns {string} display text.
 */
function formatLatencyTick(key, value) {
  if (key === 'llmAvgSeconds') return `${value.toFixed(value < 10 ? 1 : 0)}s`
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

/**
 * Create an SVG text node.
 * @param {Document} doc - owner document.
 * @param {number} x - x coordinate.
 * @param {number} y - y coordinate.
 * @param {string} content - text.
 * @param {string} className - class names.
 * @returns {SVGTextElement} the text element.
 */
function textNode(doc, x, y, content, className) {
  const node = svgEl(doc, 'text', { x, y, class: className })
  node.textContent = content
  return node
}

/**
 * Derive a per-key shade of a series color so stacked keys stay separable.
 * @param {string} color - base CSS color.
 * @param {string} key - active key.
 * @param {{key: string}[]} keys - all keys of the metric.
 * @returns {string} CSS color.
 */
function shade(color, key, keys) {
  const index = keys.findIndex((candidate) => candidate.key === key)
  const factor = 1 - index * 0.22
  const hex = color.replace('#', '')
  const value = Number.parseInt(hex.length === 3 ? hex.split('').map((char) => char + char).join('') : hex, 16)
  const red = Math.round(((value >> 16) & 0xff) * factor)
  const green = Math.round(((value >> 8) & 0xff) * factor)
  const blue = Math.round((value & 0xff) * factor)
  return `rgb(${red}, ${green}, ${blue})`
}

/** Stylesheet for both surfaces. Host tokens override the light defaults. */
export const WORKBENCH_CSS = `
.wb-root {
  --wb-bg: var(--dsh-bg, #ffffff);
  --wb-fg: var(--dsh-text, #1f2328);
  --wb-dim: var(--dsh-text-secondary, #6b7280);
  --wb-border: var(--dsh-border, #e5e7eb);
  --wb-card: var(--dsh-surface, #fafafa);
  --wb-accent: var(--dsh-accent, #4d6bfe);
  color: var(--wb-fg);
  background: var(--wb-bg);
  font: 13px/1.5 var(--dsh-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  box-sizing: border-box;
  overflow: auto;
}
.wb-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.wb-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: 0.2px; }
.wb-subtitle { margin: 2px 0 0; color: var(--wb-dim); font-size: 12px; }
.wb-status { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--wb-dim); font-size: 12px; }
.wb-status-dim { opacity: 0.8; }
.wb-status-error { color: #e5484d; }
.wb-warn { color: #f0a13a; }
.wb-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.wb-kpi { background: var(--wb-card); border: 1px solid var(--wb-border); border-radius: 10px; padding: 10px 12px; }
.wb-kpi-label { color: var(--wb-dim); font-size: 11px; }
.wb-kpi-value { font-size: 18px; font-weight: 650; margin: 2px 0; }
.wb-kpi-hint { color: var(--wb-dim); font-size: 11px; }
.wb-section { border: 1px solid var(--wb-border); border-radius: 12px; padding: 14px; background: var(--wb-bg); }
.wb-section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.wb-h2 { margin: 0; font-size: 14px; font-weight: 650; }
.wb-controls { display: flex; flex-wrap: wrap; gap: 6px; }
.wb-btn {
  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--wb-border); background: transparent; color: var(--wb-dim); cursor: pointer;
}
.wb-btn:hover { color: var(--wb-fg); border-color: var(--wb-accent); }
.wb-btn-active { background: var(--wb-accent); border-color: var(--wb-accent); color: #fff; }
.wb-btn-ghost { border-style: dashed; }
.wb-select { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--wb-border); background: var(--wb-bg); color: var(--wb-fg); max-width: 100%; }
.wb-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 6px; color: var(--wb-dim); font-size: 11px; }
.wb-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.wb-legend-note { opacity: 0.75; }
.wb-swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.wb-chart { width: 100%; overflow: hidden; }
.wb-svg { display: block; max-width: 100%; }
.wb-grid { stroke: var(--wb-border); stroke-width: 1; stroke-dasharray: 3 3; }
.wb-axis { fill: var(--wb-dim); font-size: 10px; }
.wb-axis-y { text-anchor: end; }
.wb-axis-x { text-anchor: middle; }
.wb-bar-hit { fill: transparent; }
.wb-bar-hit:hover { fill: var(--wb-accent); opacity: 0.08; }
.wb-dot { opacity: 0.85; }
.wb-heat { overflow-x: auto; }
.wb-heat-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--wb-dim); font-size: 11px; margin-bottom: 6px; }
.wb-heat-legend { display: flex; align-items: center; gap: 4px; color: var(--wb-dim); font-size: 11px; margin: 6px 0 2px; }
.wb-heat-legend-label { }
.wb-heat-swatch { width: 11px; height: 11px; border-radius: 2.5px; display: inline-block; }
.wb-svg-heat { display: block; width: min(100%, var(--wb-heat-width, 100%)); height: auto; }
.wb-heat-0 { fill: color-mix(in srgb, var(--wb-dim) 12%, var(--wb-bg)); background: color-mix(in srgb, var(--wb-dim) 12%, var(--wb-bg)); }
.wb-heat-1 { fill: color-mix(in srgb, var(--wb-accent) 25%, var(--wb-bg)); background: color-mix(in srgb, var(--wb-accent) 25%, var(--wb-bg)); }
.wb-heat-2 { fill: color-mix(in srgb, var(--wb-accent) 50%, var(--wb-bg)); background: color-mix(in srgb, var(--wb-accent) 50%, var(--wb-bg)); }
.wb-heat-3 { fill: color-mix(in srgb, var(--wb-accent) 75%, var(--wb-bg)); background: color-mix(in srgb, var(--wb-accent) 75%, var(--wb-bg)); }
.wb-heat-4 { fill: var(--wb-accent); background: var(--wb-accent); }
.wb-heat-today { stroke: var(--wb-dim); stroke-width: 1; }
.wb-heat-month { fill: var(--wb-dim); font-size: 10px; }
.wb-heat-wday { fill: var(--wb-dim); font-size: 10px; text-anchor: end; }
.wb-cal { overflow-x: auto; }

.wb-coverage { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--wb-dim); font-size: 11px; border-top: 1px solid var(--wb-border); padding-top: 10px; }
.wb-empty { color: var(--wb-dim); font-size: 12px; }
.wb-compact { padding: 12px; gap: 12px; }
.wb-compact .wb-kpis { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
.wb-compact .wb-title { font-size: 17px; }
@media (prefers-color-scheme: dark) {
  .wb-root {
    --wb-bg: var(--dsh-bg, #16181d);
    --wb-fg: var(--dsh-text, #e6e8eb);
    --wb-dim: var(--dsh-text-secondary, #9aa4b2);
    --wb-border: var(--dsh-border, #2c3038);
    --wb-card: var(--dsh-surface, #1d2026);
  }
}
`
