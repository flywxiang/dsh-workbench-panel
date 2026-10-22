/**
 * Shared data shaping for the DSH workbench: one contract feeds both the
 * standalone dashboard page and the in-GUI sidebar panel.
 *
 * This module owns every derived number and every display rule (series order,
 * colors, time bucketing, empty-value policy). Renderers only draw: either DOM
 * nodes in the standalone page or React elements in the GUI panel.
 *
 * Time bucketing uses a caller-supplied IANA zone so "daily" means the user's
 * local day rather than UTC.
 */
import { buildInsights } from './insights.mjs'

/**
 * Trailing window the call heatmap always draws, independent of the trend
 * window. 365 days puts ~53 week-columns on the board, which is what makes the
 * contribution graph legible; the trend charts keep following the user's own
 * `days` selection.
 */
export const HEATMAP_DAYS = 365

/** Ordered provider/model series palette. Stable so a model keeps its color. */
export const SERIES_COLORS = [
  '#4d6bfe', // deepseek blue
  '#12a594', // teal
  '#f0a13a', // amber
  '#e5484d', // red
  '#8e4ec6', // purple
  '#0090ff', // sky
  '#46a758', // green
  '#ff8a3d', // orange
  '#d6409f', // magenta
  '#6e7681', // gray
  '#b5a642', // brass
  '#3a8c8c', // deep teal
]

/**
 * Resolve a stable color for a series label.
 * @param {string} label - `provider/model`.
 * @param {number} index - fallback palette index.
 * @param {Record<string, string>} assignments - accumulating label to color map.
 * @returns {string} CSS color.
 */
export function seriesColor(label, index, assignments) {
  if (assignments[label] === undefined) {
    assignments[label] = SERIES_COLORS[index % SERIES_COLORS.length]
  }
  return assignments[label]
}

/**
 * Format an epoch-millisecond instant as a local calendar date key.
 * @param {number} epochMs - instant to format.
 * @param {string} timeZone - IANA zone.
 * @returns {string} `YYYY-MM-DD`.
 */
export function dayKey(epochMs, timeZone) {
  const parts = localParts(epochMs, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * Format an epoch-millisecond instant as a local hour index 0-23.
 * @param {number} epochMs - instant to format.
 * @param {string} timeZone - IANA zone.
 * @returns {number} hour of day in the zone.
 */
export function hourOf(epochMs, timeZone) {
  return localParts(epochMs, timeZone).hour
}

/**
 * Format an epoch-millisecond instant as a local ISO weekday.
 * @param {number} epochMs - instant to format.
 * @param {string} timeZone - IANA zone.
 * @returns {number} ISO weekday, Monday 1 through Sunday 7.
 */
export function isoWeekdayOf(epochMs, timeZone) {
  return WEEKDAY_INDEX[localParts(epochMs, timeZone).weekday] ?? 1
}

/** Zone formatters, created once per zone instead of once per call. */
const zoneFormatters = new Map()

/** Bounded memo of computed local parts, keyed by `zone|epoch`. */
const localPartsCache = new Map()

/** Cap on the local-parts memo; a build rarely exceeds it and a clear is cheap. */
const LOCAL_PARTS_LIMIT = 200_000

/** ISO weekday index by short English name. */
const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/**
 * Resolve one instant's local calendar parts in a zone.
 *
 * `Intl.DateTimeFormat` construction is expensive (it resolves zone data), so a
 * formatter is cached per zone and results are memoized: a payload build formats
 * every call, and constructing a formatter per call made the build take seconds.
 * @param {number} epochMs - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {{year: string, month: string, day: string, hour: number, weekday: string}} local parts.
 */
function localParts(epochMs, timeZone) {
  const cacheKey = `${timeZone}|${epochMs}`
  const cached = localPartsCache.get(cacheKey)
  if (cached !== undefined) return cached
  let formatter = zoneFormatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    })
    zoneFormatters.set(timeZone, formatter)
  }
  const values = {}
  for (const part of formatter.formatToParts(new Date(epochMs))) values[part.type] = part.value
  const parts = {
    year: values.year ?? '1970',
    month: values.month ?? '01',
    day: values.day ?? '01',
    hour: values.hour === '24' ? 0 : Number.parseInt(values.hour ?? '0', 10),
    weekday: values.weekday ?? 'Mon',
  }
  if (localPartsCache.size >= LOCAL_PARTS_LIMIT) localPartsCache.clear()
  localPartsCache.set(cacheKey, parts)
  return parts
}

/**
 * Summarize one model's calls for one metric.
 * @param {object[]} calls - calls of one series inside one bucket.
 * @param {string} metric - metric id from {@link METRICS}.
 * @returns {number} metric value.
 */
function measure(calls, metric) {
  switch (metric) {
    case 'calls':
      return calls.length
    case 'inputTokens':
      return calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0)
    case 'outputTokens':
      return calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0)
    case 'cacheReadTokens':
      return calls.reduce((sum, call) => sum + (call.cacheReadTokens ?? 0), 0)
    case 'reasoningTokens':
      return calls.reduce((sum, call) => sum + (call.reasoningTokens ?? 0), 0)
    case 'llmSeconds':
      return calls.reduce((sum, call) => sum + (call.responseMs ?? 0), 0) / 1000
    default:
      throw new Error(`unknown metric: ${metric}`)
  }
}

/**
 * Summarize one model's calls for one latency metric, as a mean over the calls
 * that carry the sample. Calls without the sample are excluded rather than
 * counted as zero, and an empty sample set yields `null` so a renderer can draw
 * a gap instead of a misleading zero.
 * @param {object[]} calls - calls of one series inside one bucket.
 * @param {string} metric - latency metric id.
 * @returns {number | null} mean value, or null with no samples.
 */
function measureLatency(calls, metric) {
  const field = metric === 'llmAvgSeconds' ? 'responseMs' : metric === 'ttftAvgMs' ? 'ttftMs' : undefined
  if (field === undefined) throw new Error(`unknown latency metric: ${metric}`)
  let sum = 0
  let count = 0
  for (const call of calls) {
    const value = call[field]
    if (typeof value !== 'number') continue
    sum += value
    count += 1
  }
  if (count === 0) return null
  const mean = sum / count
  return metric === 'llmAvgSeconds' ? mean / 1000 : mean
}

/**
 * The chartable metric families.
 *
 * `stacked` metrics stack one bar segment per model; `latency` metrics draw one
 * line per model (a mean, so segments would be meaningless).
 */
export const METRICS = {
  calls: { id: 'calls', label: '调用次数', kind: 'stacked', unit: '次' },
  tokens: {
    id: 'tokens',
    label: 'Token 用量',
    kind: 'stacked',
    unit: 'token',
    keys: [
      { key: 'inputTokens', label: '输入' },
      { key: 'outputTokens', label: '输出' },
      { key: 'cacheReadTokens', label: '缓存读取' },
      { key: 'reasoningTokens', label: '推理' },
    ],
  },
  llmTime: {
    id: 'llmTime',
    label: '模型响应时间',
    kind: 'stacked',
    unit: '秒',
    keys: [{ key: 'llmSeconds', label: '响应耗时' }],
  },
  latency: {
    id: 'latency',
    label: '延迟（均值）',
    kind: 'latency',
    unit: 'ms',
    keys: [
      { key: 'llmAvgSeconds', label: '平均响应', unit: '秒' },
      { key: 'ttftAvgMs', label: '平均首字', unit: 'ms' },
    ],
  },
}

/**
 * Render a metric value for display.
 * @param {string} metric - stacked metric id.
 * @param {number} value - raw value.
 * @returns {string} human text.
 */
export function formatMetricValue(metric, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  if (metric === 'calls') return value.toLocaleString('en-US')
  if (metric === 'llmSeconds') return value >= 600 ? `${(value / 60).toFixed(1)} 分` : `${value.toFixed(1)} 秒`
  return formatTokens(value)
}

/**
 * Render a token count with a compact suffix.
 * @param {number} value - token count.
 * @returns {string} human text.
 */
export function formatTokens(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}K`
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Render a duration in milliseconds.
 * @param {number | null} value - milliseconds.
 * @returns {string} human text.
 */
export function formatMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} 分`
  if (value >= 1000) return `${(value / 1000).toFixed(2)} 秒`
  return `${Math.round(value)} ms`
}

/**
 * Fold raw call records into the complete workbench payload.
 *
 * @param {object} input
 * @param {object[]} input.calls - conversation calls (auxiliary work excluded).
 * @param {{id: string, cwd: string | null, createdAt: number | null}[]} input.sessions - scanned sessions.
 * @param {object} input.scan - scan accounting: artifacts, bytes, decodeMs, failures, torn frames.
 * @param {string} input.timeZone - IANA zone for every calendar bucket.
 * @param {number} [input.days] - trailing day window for the trend; 0 means every day.
 * @param {number} [input.now] - reference instant for the window.
 * @param {object} [input.insights] - insights options (prices, windows, thresholds).
 * @returns {object} the payload consumed by both renderers.
 */
export function buildWorkbenchPayload({ calls, sessions, scan, timeZone, days = 30, now = Date.now(), insights = {} }) {
  const colors = {}
  const modelTotals = new Map()
  for (const call of calls) {
    const label = `${call.provider}/${call.model}`
    modelTotals.set(label, (modelTotals.get(label) ?? 0) + 1)
  }
  const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label)
  models.forEach((label, index) => seriesColor(label, index, colors))

  const allDayKeys = new Set()
  for (const call of calls) {
    if (typeof call.startTime === 'number' && call.startTime > 0) allDayKeys.add(dayKey(call.startTime, timeZone))
  }
  const sortedDays = [...allDayKeys].sort()
  const nowKey = dayKey(now, timeZone)
  const [nowYear, nowMonth, nowDay] = nowKey.split('-').map(Number)
  const anchor = Date.UTC(nowYear, nowMonth - 1, nowDay)
  /**
   * List the trailing `count` day keys ending on `nowKey`.
   * @param {number} count - how many days back to reach.
   * @returns {string[]} `YYYY-MM-DD` keys, oldest first.
   */
  const daysBack = (count) =>
    Array.from({ length: count }, (_unused, index) =>
      new Date(anchor - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    )

  const windowDays = days > 0 ? daysBack(days) : sortedDays

  /** @type {Map<string, Map<string, object[]>>} day -> model -> calls */
  const byDay = new Map()
  /** Lazily open a day's per-model bucket map. */
  const dayBucket = (key) => {
    let modelsOfDay = byDay.get(key)
    if (modelsOfDay === undefined) {
      modelsOfDay = new Map()
      byDay.set(key, modelsOfDay)
    }
    return modelsOfDay
  }
  /** @type {number[][]} 7 rows (Mon..Sun) x 24 hours */
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  /** @type {Map<string, number[][]>} model -> 7x24 grid */
  const heatmapByModel = new Map()
  let heatmapMax = 0
  let firstCall = Number.POSITIVE_INFINITY
  let lastCall = 0
  let usageCalls = 0
  let ttftCalls = 0
  let responseCalls = 0
  let missingStartTime = 0

  for (const call of calls) {
    const label = `${call.provider}/${call.model}`
    if (typeof call.startTime === 'number' && call.startTime > 0) {
      const key = dayKey(call.startTime, timeZone)
      const modelsOfDay = dayBucket(key)
      if (!modelsOfDay.has(label)) modelsOfDay.set(label, [])
      modelsOfDay.get(label).push(call)

      const weekday = isoWeekdayOf(call.startTime, timeZone) - 1
      const hour = hourOf(call.startTime, timeZone)
      heatmap[weekday][hour] += 1
      heatmapMax = Math.max(heatmapMax, heatmap[weekday][hour])
      let grid = heatmapByModel.get(label)
      if (grid === undefined) {
        grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
        heatmapByModel.set(label, grid)
      }
      grid[weekday][hour] += 1

      firstCall = Math.min(firstCall, call.startTime)
      lastCall = Math.max(lastCall, call.startTime)
    } else {
      missingStartTime += 1
    }
    if (call.hasUsage) usageCalls += 1
    if (typeof call.ttftMs === 'number') ttftCalls += 1
    if (typeof call.responseMs === 'number') responseCalls += 1
  }

  /** Assemble the stacked series of one metric across the trend window. */
  const stacked = (metricId, keys) => {
    const buckets = windowDays.map((day) => {
      const modelsOfDay = byDay.get(day) ?? new Map()
      const values = {}
      for (const key of keys) values[key.key] = {}
      let total = 0
      for (const model of models) {
        const list = modelsOfDay.get(model) ?? []
        for (const key of keys) {
          const value = measure(list, key.key)
          values[key.key][model] = value
          if (key.key === keys[0].key) total += value
        }
      }
      return { day, values, total }
    })
    const keyMax = {}
    for (const key of keys) {
      let max = 0
      for (const bucket of buckets) {
        let sum = 0
        for (const model of models) sum += bucket.values[key.key][model] ?? 0
        max = Math.max(max, sum)
      }
      keyMax[key.key] = max
    }
    return { metric: metricId, stackable: true, keys, buckets, keyMax }
  }

  const latency = () => {
    const perModel = {}
    for (const key of METRICS.latency.keys) perModel[key.key] = {}
    const buckets = windowDays.map((day) => {
      const modelsOfDay = byDay.get(day) ?? new Map()
      const values = {}
      for (const key of METRICS.latency.keys) {
        const perModelValues = {}
        for (const model of models) {
          perModelValues[model] = measureLatency(modelsOfDay.get(model) ?? [], key.key)
        }
        values[key.key] = perModelValues
      }
      return { day, values }
    })
    const keyMax = {}
    for (const key of METRICS.latency.keys) {
      let max = 0
      for (const bucket of buckets) {
        for (const model of models) max = Math.max(max, bucket.values[key.key][model] ?? 0)
      }
      keyMax[key.key] = max
    }
    return { metric: 'latency', stackable: false, keys: METRICS.latency.keys, buckets, keyMax }
  }

  const trends = {
    calls: stacked('calls', [{ key: 'calls', label: '调用次数' }]),
    tokens: stacked('tokens', METRICS.tokens.keys),
    llmTime: stacked('llmTime', METRICS.llmTime.keys),
    latency: latency(),
  }

  /**
   * Totals for one day key.
   * @param {string} day - `YYYY-MM-DD`.
   * @returns {{day: string, calls: number, tokens: number}} that day's totals.
   */
  const totalsFor = (day) => {
    const modelsOfDay = byDay.get(day) ?? new Map()
    let count = 0
    let tokens = 0
    for (const list of modelsOfDay.values()) {
      count += list.length
      for (const call of list) tokens += (call.inputTokens ?? 0) + (call.outputTokens ?? 0) + (call.cacheReadTokens ?? 0)
    }
    return { day, calls: count, tokens }
  }

  const dailyTotals = windowDays.map(totalsFor)

  // The heatmap keeps its own trailing year, the way OpenClaw's usage heatmap
  // always spans ~1 year: a contribution graph only reads as a rhythm once there
  // are enough columns to show one, and a 60-day window gives nine. Days before
  // the first recorded call come back as zeroes, which is exactly what a
  // contribution graph is supposed to show before an account gets going.
  const heatmapDaily = daysBack(HEATMAP_DAYS).map(totalsFor)

  const heatmapByModelOut = {}
  for (const [label, grid] of heatmapByModel) {
    let max = 0
    for (const row of grid) for (const value of row) max = Math.max(max, value)
    heatmapByModelOut[label] = { max, grid }
  }

  let inputTotal = 0
  let outputTotal = 0
  let cacheReadTotal = 0
  let reasoningTotal = 0
  let responseMsTotal = 0
  for (const call of calls) {
    inputTotal += call.inputTokens ?? 0
    outputTotal += call.outputTokens ?? 0
    cacheReadTotal += call.cacheReadTokens ?? 0
    reasoningTotal += call.reasoningTokens ?? 0
    responseMsTotal += call.responseMs ?? 0
  }
  const averageOver = (field) => {
    let sum = 0
    let count = 0
    for (const call of calls) {
      const value = call[field]
      if (typeof value !== 'number') continue
      sum += value
      count += 1
    }
    return count === 0 ? null : sum / count
  }
  /** Nearest-rank percentile over the samples present, null with none. */
  const percentileOver = (field, fraction) => {
    const values = []
    for (const call of calls) {
      const value = call[field]
      if (typeof value === 'number') values.push(value)
    }
    if (values.length === 0) return null
    values.sort((left, right) => left - right)
    const index = Math.min(values.length - 1, Math.max(0, Math.ceil(fraction * values.length) - 1))
    return values[index]
  }

  let peakDay = null
  let peakHour = null
  for (const bucket of dailyTotals) {
    if (bucket.calls === 0) continue
    if (peakDay === null || bucket.calls > peakDay.calls) peakDay = { day: bucket.day, calls: bucket.calls }
  }
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const value = heatmap[weekday][hour]
      if (value === 0) continue
      if (peakHour === null || value > peakHour.calls) {
        peakHour = { weekday: WEEKDAYS[weekday], hour, calls: value }
      }
    }
  }
  const recent7 = dailyTotals.slice(-7)
  const previous7 = dailyTotals.slice(-14, -7)
  const sumCalls = (list) => list.reduce((sum, bucket) => sum + bucket.calls, 0)
  const weekOverWeek =
    previous7.length === 0
      ? null
      : {
          recent: sumCalls(recent7),
          previous: sumCalls(previous7),
          delta: sumCalls(recent7) - sumCalls(previous7),
        }

  // Recent-window insights (cost, deliverables, unfinished todos, waiting-on-user
  // sessions, context warnings, weekly report). Prices and thresholds come from
  // the plugin row; the defaults live in insights.mjs.
  const insightsPayload = buildInsights({
    calls,
    sessions,
    options: {
      now,
      timeZone,
      prices: insights.prices,
      windows: insights.windows,
      contextWarnTokens: insights.contextWarnTokens,
      showLatency: insights.showLatency,
    },
  })

  return {
    generatedAt: Date.now(),
    timeZone,
    window: { days, from: windowDays[0] ?? null, to: windowDays.at(-1) ?? null },
    scan: {
      sessions: sessions.length,
      artifacts: scan.artifacts ?? sessions.length,
      bytes: scan.bytes ?? 0,
      decodeMs: scan.decodeMs ?? 0,
      failures: scan.failures ?? 0,
      tornFrames: scan.tornFrames ?? 0,
    },
    filter: { auxiliaryExcluded: true, auxiliaryCalls: scan.auxiliaryCalls ?? 0 },
    totals: {
      calls: calls.length,
      models: models.length,
      sessions: sessions.length,
      firstCall: Number.isFinite(firstCall) ? firstCall : null,
      lastCall: lastCall > 0 ? lastCall : null,
      activeDays: allDayKeys.size,
      usageCalls,
      ttftCalls,
      responseCalls,
      missingStartTime,
    },
    coverage: {
      usage: +(usageCalls / Math.max(calls.length, 1)).toFixed(3),
      ttft: +(ttftCalls / Math.max(calls.length, 1)).toFixed(3),
      response: +(responseCalls / Math.max(calls.length, 1)).toFixed(3),
    },
    usage: {
      inputTokens: inputTotal,
      outputTokens: outputTotal,
      cacheReadTokens: cacheReadTotal,
      reasoningTokens: reasoningTotal,
      llmMs: responseMsTotal,
    },
    latency: {
      avgResponseMs: averageOver('responseMs'),
      p50ResponseMs: percentileOver('responseMs', 0.5),
      p95ResponseMs: percentileOver('responseMs', 0.95),
      avgTtftMs: averageOver('ttftMs'),
      p50TtftMs: percentileOver('ttftMs', 0.5),
      p95TtftMs: percentileOver('ttftMs', 0.95),
    },
    highlights: { peakDay, peakHour, weekOverWeek },
    models: models.map((label) => ({
      label,
      color: colors[label],
      calls: modelTotals.get(label) ?? 0,
    })),
    dailyTotals,
    heatmapDaily,
    heatmapWindow: {
      days: HEATMAP_DAYS,
      from: heatmapDaily[0]?.day ?? null,
      to: heatmapDaily.at(-1)?.day ?? null,
    },
    trends,
    heatmap: { max: heatmapMax, grid: heatmap, byModel: heatmapByModelOut },
    insights: insightsPayload,
  }
}

/** ISO weekday labels, Monday first, matching the heatmap rows. */
export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** Hour labels for the heatmap, every third hour rendered by the axis. */
export const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))

/**
 * Quantize a heatmap count into a 0-4 intensity level.
 * @param {number} value - cell count.
 * @param {number} max - largest cell count.
 * @returns {number} 0 through 4.
 */
export function heatLevel(value, max) {
  if (value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio <= 0.125) return 1
  if (ratio <= 0.3) return 2
  if (ratio <= 0.6) return 3
  return 4
}
