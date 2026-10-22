/**
 * Recent-window insights for the workbench: estimated cost, deliverables,
 * unfinished todos, sessions waiting on the user, context-window warnings, and a
 * copyable weekly report.
 *
 * Everything is derived from the same session-log facts the charts use, so this
 * module takes no new data source. Prices are estimates: the defaults are a
 * small, editable table in CNY per million tokens; unknown models are counted
 * separately and reported as "unpriced" instead of silently costing zero.
 */
import { maskPathName, maskText, truncate } from './redact.mjs'

/** Milliseconds in one day. */
const DAY_MS = 86400000

/** Default price table, CNY per 1,000,000 tokens. Edit per deployment. */
export const DEFAULT_PRICES = {
  'deepseek-flash': { input: 2, cacheRead: 0.5, output: 8 },
  'deepseek-v4-flash': { input: 2, cacheRead: 0.5, output: 8 },
  'deepseek-v4-flash-vision-exp': { input: 2, cacheRead: 0.5, output: 8 },
  'deepseek-chat': { input: 2, cacheRead: 0.5, output: 8 },
  'deepseek-v4-pro': { input: 4, cacheRead: 1, output: 16 },
  'deepseek-reasoner': { input: 4, cacheRead: 1, output: 16 },
}

/** Default insight windows, in days. */
export const DEFAULT_WINDOWS = {
  cost: 7,
  todo: 14,
  deliverable: 14,
  waiting: 3,
  context: 2,
}

/**
 * Resolve the price entry for one model route.
 *
 * Lookup order: exact `provider/model` key, exact model key, then a family
 * heuristic (`flash`/`economy`/`chat` vs `pro`/`reasoner`). Unknown families
 * return null so the caller can report them as unpriced.
 * @param {object} prices - price table.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {{input: number, cacheRead: number, output: number} | null} price per million tokens.
 */
export function resolvePrice(prices, provider, model) {
  const table = prices ?? DEFAULT_PRICES
  const route = `${provider}/${model}`
  if (table[route] !== undefined) return table[route]
  if (table[model] !== undefined) return table[model]
  const fallback = DEFAULT_PRICES[model]
  if (fallback !== undefined) return fallback
  if (/flash|economy|chat/iu.test(model)) {
    return table['deepseek-v4-flash'] ?? DEFAULT_PRICES['deepseek-v4-flash']
  }
  if (/pro|reasoner/iu.test(model)) {
    return table['deepseek-v4-pro'] ?? DEFAULT_PRICES['deepseek-v4-pro']
  }
  return null
}

/**
 * Estimate the cost of one token bundle.
 * @param {{input: number, cacheRead: number, output: number}} price - per-million price.
 * @param {{input?: number, cacheRead?: number, cacheWrite?: number, output?: number}} tokens - token counts.
 * @returns {{cost: number, saved: number}} estimated cost and cache saving in currency units.
 */
export function estimateCost(price, tokens) {
  const million = (value) => (value ?? 0) / 1_000_000
  const cost =
    million(tokens.input) * price.input +
    million(tokens.cacheRead) * price.cacheRead +
    million(tokens.cacheWrite) * price.input +
    million(tokens.output) * price.output
  const saved = million(tokens.cacheRead) * Math.max(0, price.input - price.cacheRead)
  return { cost, saved }
}

/**
 * Format a token count for humans.
 * @param {number} value - token count.
 * @returns {string} display text such as "12.3M".
 */
export function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

/**
 * Format a money amount.
 * @param {number} value - amount in CNY.
 * @returns {string} display text such as "¥12.34".
 */
export function formatMoney(value) {
  if (!Number.isFinite(value)) return '¥—'
  if (value >= 1000) return `¥${(value / 1000).toFixed(2)}K`
  if (value >= 10) return `¥${value.toFixed(1)}`
  return `¥${value.toFixed(2)}`
}

/**
 * Format a day key for the report header.
 * @param {number} epochMs - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {string} `YYYY-MM-DD` in the requested zone.
 */
function dayKeyOf(epochMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(epochMs))
}

/**
 * Session title for display.
 * @param {object} session - session record.
 * @returns {string} title.
 */
function sessionTitle(session) {
  if (typeof session.title === 'string' && session.title !== '') return session.title
  if (typeof session.cwd === 'string' && session.cwd !== '') {
    const parts = session.cwd.split(/[\\/]/u).filter((part) => part !== '')
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return String(session.id ?? '').replace(/^session-/u, '').slice(0, 12)
}

/**
 * Build the insights block of the workbench payload.
 * @param {object} input - aggregation input.
 * @param {object[]} input.calls - language-model call records (all time).
 * @param {object[]} input.sessions - per-session records with insight fields.
 * @param {object} [input.options] - overrides.
 * @param {number} [input.options.now] - reference instant.
 * @param {object} [input.options.prices] - price table override.
 * @param {number} [input.options.contextWarnTokens] - context-size warning threshold in tokens.
 * @param {boolean} [input.options.showLatency] - whether the latency chart is shown.
 * @param {string} [input.options.timeZone] - IANA zone for report dates.
 * @param {object} [input.options.windows] - window overrides in days.
 * @returns {object} insights payload.
 */
export function buildInsights(input) {
  const { calls, sessions } = input
  const options = input.options ?? {}
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const prices = options.prices ?? DEFAULT_PRICES
  const windows = { ...DEFAULT_WINDOWS, ...(options.windows ?? {}) }
  const contextWarnTokens = Number.isFinite(options.contextWarnTokens) ? options.contextWarnTokens : 200_000
  const timeZone = options.timeZone ?? 'UTC'
  const cutoff = (days) => now - days * DAY_MS

  // --- cost over the cost window, grouped by model route ---
  const routes = new Map()
  let windowCalls = 0
  let windowInput = 0
  let windowOutput = 0
  let windowCacheRead = 0
  let windowCacheWrite = 0
  for (const call of calls) {
    const at = call.startTime
    if (!Number.isFinite(at) || at < cutoff(windows.cost)) continue
    windowCalls += 1
    windowInput += call.inputTokens ?? 0
    windowOutput += call.outputTokens ?? 0
    windowCacheRead += call.cacheReadTokens ?? 0
    windowCacheWrite += call.cacheWriteTokens ?? 0
    const provider = String(call.provider ?? '?')
    const model = String(call.model ?? '?')
    const key = `${provider}/${model}`
    const route = routes.get(key) ?? { provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    route.calls += 1
    route.input += call.inputTokens ?? 0
    route.output += call.outputTokens ?? 0
    route.cacheRead += call.cacheReadTokens ?? 0
    route.cacheWrite += call.cacheWriteTokens ?? 0
    routes.set(key, route)
  }
  let costTotal = 0
  let savedTotal = 0
  let pricedCalls = 0
  let unpricedCalls = 0
  const unpricedModels = new Map()
  const byModel = []
  for (const route of routes.values()) {
    const price = resolvePrice(prices, route.provider, route.model)
    if (price === null) {
      unpricedCalls += route.calls
      unpricedModels.set(`${route.provider}/${route.model}`, (unpricedModels.get(`${route.provider}/${route.model}`) ?? 0) + route.calls)
      byModel.push({ label: `${route.provider}/${route.model}`, calls: route.calls, cost: null })
      continue
    }
    pricedCalls += route.calls
    const estimate = estimateCost(price, route)
    costTotal += estimate.cost
    savedTotal += estimate.saved
    byModel.push({ label: `${route.provider}/${route.model}`, calls: route.calls, cost: estimate.cost })
  }

  // --- per-session spend, for the "most expensive sessions" ranking ---
  const sessionSpend = []
  for (const session of sessions) {
    const at = session.lastEventAt ?? 0
    if (at < cutoff(windows.cost)) continue
    let cost = 0
    let tokens = 0
    for (const usage of session.models ?? []) {
      const price = resolvePrice(prices, usage.provider, usage.model)
      if (price === null) continue
      cost += estimateCost(price, usage).cost
      tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0)
    }
    if (cost > 0) {
      sessionSpend.push({ sessionId: session.id, title: sessionTitle(session), cwd: session.cwd ?? null, cost, tokens, lastEventAt: at })
    }
  }
  sessionSpend.sort((left, right) => right.cost - left.cost)

  // --- sessions waiting on the user ---
  const waiting = []
  for (const session of sessions) {
    const waitingOn = session.waiting
    if (waitingOn === null || waitingOn === undefined) continue
    const since = Number.isFinite(waitingOn.since) ? waitingOn.since : (session.lastEventAt ?? 0)
    if (since < cutoff(windows.waiting)) continue
    waiting.push({
      sessionId: session.id,
      title: sessionTitle(session),
      cwd: session.cwd ?? null,
      kind: waitingOn.kind,
      toolName: waitingOn.toolName ?? null,
      reason: waitingOn.reason === null || waitingOn.reason === undefined ? null : maskText(waitingOn.reason, 80),
      since,
      ageMs: Math.max(0, now - since),
    })
  }
  waiting.sort((left, right) => left.since - right.since)

  // --- unfinished todo lists across sessions ---
  const todos = []
  for (const session of sessions) {
    const list = session.todos
    if (list === null || list === undefined || list.total === 0 || list.completed >= list.total) continue
    const at = session.lastEventAt ?? 0
    if (at < cutoff(windows.todo)) continue
    const items = (list.items ?? [])
      .filter((item) => item.status !== 'completed')
      .slice(0, 6)
      .map((item) => ({ content: truncate(item.content, 100), status: item.status }))
    if (items.length === 0) continue
    todos.push({
      sessionId: session.id,
      title: sessionTitle(session),
      cwd: session.cwd ?? null,
      total: list.total,
      completed: list.completed,
      items,
      lastEventAt: at,
    })
  }
  todos.sort((left, right) => right.lastEventAt - left.lastEventAt)

  // --- deliverables produced in the window (one entry per file, latest wins) ---
  const deliverableByPath = new Map()
  for (const session of sessions) {
    for (const delivered of session.deliverables ?? []) {
      const at = delivered.at ?? 0
      if (at < cutoff(windows.deliverable)) continue
      const key = delivered.path
      const existing = deliverableByPath.get(key)
      if (existing !== undefined && existing.at >= at) continue
      deliverableByPath.set(key, {
        path: maskText(delivered.path, 240),
        name: maskPathName(delivered.path),
        description: delivered.description === null || delivered.description === undefined ? null : maskText(delivered.description, 100),
        sessionId: session.id,
        title: sessionTitle(session),
        at,
      })
    }
  }
  const deliverables = [...deliverableByPath.values()]
  deliverables.sort((left, right) => right.at - left.at)

  // --- context-window warnings ---
  const context = []
  for (const session of sessions) {
    const usage = session.context
    if (usage === null || usage === undefined) continue
    const at = usage.at ?? session.lastEventAt ?? 0
    if (at < cutoff(windows.context)) continue
    const used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (used < contextWarnTokens) continue
    context.push({
      sessionId: session.id,
      title: sessionTitle(session),
      cwd: session.cwd ?? null,
      usedTokens: used,
      warnTokens: contextWarnTokens,
      maxTokens: Number.isFinite(usage.maxTokens) ? usage.maxTokens : null,
      ratio: +(used / contextWarnTokens).toFixed(3),
      model: usage.model ?? null,
      at,
    })
  }
  context.sort((left, right) => right.usedTokens - left.usedTokens)

  // --- weekly report text (plain text, copied to the clipboard verbatim) ---
  const topModel = [...byModel].sort((left, right) => right.calls - left.calls)[0] ?? null
  const topSession = sessionSpend[0] ?? null
  const from = dayKeyOf(cutoff(windows.cost), timeZone)
  const to = dayKeyOf(now, timeZone)
  const lines = [
    `【AI 使用周报】${from} ~ ${to}`,
    `· 调用 ${windowCalls} 次，Token ${formatTokens(windowInput + windowOutput + windowCacheRead + windowCacheWrite)}` +
      `（输入 ${formatTokens(windowInput)} / 缓存读取 ${formatTokens(windowCacheRead)} / 输出 ${formatTokens(windowOutput)}）`,
    `· 估算花费 ${formatMoney(costTotal)}（缓存读取省下约 ${formatMoney(savedTotal)}）`,
    `· 交付文件 ${deliverables.length} 个 · 未完成待办 ${todos.length} 项 · 等你确认 ${waiting.length} 项 · 上下文提醒 ${context.length} 项`,
    topModel === null ? '· 最常用模型：—' : `· 最常用模型：${topModel.label}（${topModel.calls} 次，占 ${Math.round((topModel.calls / Math.max(windowCalls, 1)) * 100)}%）`,
    topSession === null ? '· 花费最高会话：—' : `· 花费最高会话：${truncate(topSession.title, 30)}（约 ${formatMoney(topSession.cost)}）`,
  ]
  if (unpricedCalls > 0) {
    const names = [...unpricedModels.keys()].slice(0, 3).join('、')
    lines.push(`· 另有 ${unpricedCalls} 次调用因未配置价格未计入（${names}）`)
  }
  lines.push('（花费用内置价目表估算，可在插件配置 prices 里修改）')

  return {
    windowDays: windows.cost,
    currency: 'CNY',
    priceNote: unpricedCalls > 0 ? `其中 ${unpricedCalls} 次调用未配置价格` : '全部调用均已配置价格',
    cost: {
      total: +costTotal.toFixed(4),
      saved: +savedTotal.toFixed(4),
      calls: windowCalls,
      pricedCalls,
      unpricedCalls,
      tokens: { input: windowInput, output: windowOutput, cacheRead: windowCacheRead, cacheWrite: windowCacheWrite },
      byModel: byModel.sort((left, right) => right.calls - left.calls),
      unpricedModels: [...unpricedModels.entries()].slice(0, 5).map(([label, count]) => ({ label, calls: count })),
    },
    topSessions: sessionSpend.slice(0, 5),
    waiting: waiting.slice(0, 10),
    todos: todos.slice(0, 10),
    deliverables: deliverables.slice(0, 20),
    context: context.slice(0, 10),
    contextWarnTokens: contextWarnTokens,
    counts: {
      waiting: waiting.length,
      todos: todos.length,
      deliverables: deliverables.length,
      context: context.length,
    },
    showLatency: options.showLatency === true,
    reportText: lines.join('\n'),
  }
}
