/**
 * DSH host half of the workbench plugin.
 *
 * Serves the language-model call statistics over HTTP and keeps one warm
 * aggregate in memory:
 *
 *   GET /dsh-workbench/api/summary   aggregated payload (what the panel fetches)
 *   GET /dsh-workbench/api/active    what is being processed right now
 *   GET /dsh-workbench/api/summaries daily/weekly work summaries already stored
 *   POST /dsh-workbench/api/summaries/generate  write one summary with the host model
 *   GET /dsh-workbench/api/health    collection accounting, for troubleshooting
 *   GET /dsh-workbench/dashboard.html  the generated standalone page
 *
 * Collection reads the session logs under `$DSH_HOME/sessions` directly with a
 * per-session parse cache, so it needs no host service and cannot be broken by
 * another plugin changing the query API. A background refresh keeps the payload
 * current; a request only pays for a collect when the cached payload is stale.
 *
 * The active route reuses the same artifacts but tails them incrementally (see
 * `shared/active-state.mjs`), so a panel polling every few seconds costs
 * milliseconds rather than re-decoding every log.
 *
 * The web server exists only under browser-facing profiles, so the routes ride a
 * scoped `ctx.inject(['webServer'])`: the closure runs where the service appears
 * and never runs where it does not.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectWorkbench, resolveDshHome } from './shared/collect.mjs'
import { createActiveTracker } from './shared/active-state.mjs'
import { dueSummaryJobs, generateSummary, listSummaryEntries, loadSummaryStore } from './shared/summaries.mjs'
import { dayKeyOf } from './shared/summary-data.mjs'

/** Route prefix owned by this plugin. */
export const BASE_PATH = '/dsh-workbench'

/** Refresh interval for the warm aggregate. */
const REFRESH_MS = 5 * 60 * 1000

/** A payload older than this triggers a collect on request. */
const STALE_MS = 60 * 1000

/** Live state is only this stale before a poll recomputes it. */
const ACTIVE_CACHE_MS = 1500

/** Default client polling interval for the live section. */
const DEFAULT_ACTIVE_REFRESH_MS = 10 * 1000

/** Empty live-state counts, used before the first successful collect. */
function emptyActiveCounts() {
  return { sessions: 0, runningTurns: 0, runningJobs: 0, waitingApproval: 0, retrying: 0 }
}

/**
 * Clamp an integer configuration value.
 * @param {unknown} value - raw value.
 * @param {number} fallback - default when unset or invalid.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Build the requested time window in days from a validated query value.
 * @param {URL} url - request URL.
 * @param {number} fallback - default window.
 * @returns {number} days, 1 through 365.
 */
function daysFrom(url, fallback) {
  const raw = Number.parseInt(url.searchParams.get('days') ?? '', 10)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(365, raw)
}

/**
 * Register the workbench routes on the host's web server.
 * @param {object} ctx - host plugin context whose `webServer` is available.
 * @param {object} config - plugin configuration.
 */
export function registerRoutes(ctx, config) {
  const dshHome = config.dshHome ?? resolveDshHome()
  const timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  const defaultDays = Number.isFinite(config.days) ? config.days : 60
  /** Last successful aggregate, reused until stale. */
  let cached = null
  /** In-flight collect, so concurrent requests share one scan. */
  let inflight = null
  /** Last collection accounting, for the health route. */
  let lastStats = null
  let lastError = null

  // Live "正在处理" configuration. Every knob has a safe default so an older
  // profile patch keeps working unchanged.
  const activeEnabled = config.activeEnabled !== false
  const activeRefreshMs = clampInt(config.activeRefreshMs, DEFAULT_ACTIVE_REFRESH_MS, 1000, 60000)
  const activeIdleMinutes = clampInt(config.activeIdleMinutes, 10, 1, 120)
  const activeMaxSessions = clampInt(config.activeMaxSessions, 10, 1, 50)
  const showToolTarget = config.showToolTarget === true
  /** Trackers keyed by requested idle window, so a query override gets its own. */
  const trackers = new Map()
  /** Cached live payloads keyed by idle window. */
  const activeCache = new Map()
  /** In-flight live collects keyed by idle window. */
  const activeInflight = new Map()
  let activeError = null

  // Insights configuration: estimated prices (CNY per million tokens), window
  // sizes in days, the context-warning threshold, and whether the latency chart
  // still gets drawn.
  const prices = config.prices !== null && typeof config.prices === 'object' ? config.prices : undefined
  const insightWindows = {
    cost: clampInt(config.costDays, 7, 1, 365),
    todo: clampInt(config.todoDays, 14, 1, 365),
    deliverable: clampInt(config.deliverableDays, 14, 1, 365),
    waiting: clampInt(config.waitingDays, 3, 1, 90),
    context: clampInt(config.contextDays, 2, 1, 90),
  }
  const contextWarnTokens = clampInt(config.contextWarnTokens, 200_000, 20_000, 2_000_000)
  const latencyEnabled = config.latencyEnabled === true
  const insightsOptions = { prices, windows: insightWindows, contextWarnTokens, showLatency: latencyEnabled }

  // Work-summary configuration. Summaries are generated by the host's own model
  // service; when the service or a route is missing the routes answer with a
  // clear error instead of failing the plugin.
  const summaryEnabled = config.summaryEnabled !== false
  const summaryDailyTime = typeof config.summaryDailyTime === 'string' ? config.summaryDailyTime : '18:30'
  const summaryWeeklyTime = typeof config.summaryWeeklyTime === 'string' ? config.summaryWeeklyTime : '18:30'
  const summaryMaxChars = clampInt(config.summaryMaxChars, 60_000, 5_000, 200_000)
  const summaryMaxTokens = clampInt(config.summaryMaxOutputTokens, 1800, 300, 8000)
  const summaryProvider = typeof config.summaryProvider === 'string' ? config.summaryProvider : ''
  const summaryModel = typeof config.summaryModel === 'string' ? config.summaryModel : ''
  let lastSummaryError = null
  let lastSummaryAt = null
  /** Reasons the panel should read as a configuration/environment problem. */
  const ENVIRONMENT_SKIP_REASONS = new Set(['no-llm-service', 'no-model-route'])
  /** Human-readable text for a skip reason. */
  const skipMessage = (reason) => {
    if (reason === 'no-llm-service') return '当前 profile 没有加载模型服务（llm），无法生成工作总结'
    if (reason === 'no-model-route') return '找不到可用的模型路由：请配置 summaryProvider/summaryModel，或设置会话默认模型'
    if (reason === 'no-material') return '这段时间没有可用的工作对话材料'
    return `生成跳过：${reason}`
  }

  /**
   * Resolve the model route summaries use: explicit config first, then the
   * profile's default agent model.
   * @returns {{provider: string, model: string} | null} route or null.
   */
  const summaryTarget = () => {
    if (summaryProvider !== '' && summaryModel !== '') return { provider: summaryProvider, model: summaryModel }
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
      const selection = service?.currentSelection?.()
      if (selection !== null && typeof selection === 'object' && selection.provider && selection.model) {
        return { provider: String(selection.provider), model: String(selection.model) }
      }
    } catch {
      // A profile without the default-model service can still set explicit routes.
    }
    return null
  }

  /**
   * The host LLM service, if this profile loaded one.
   * @returns {any} service or null.
   */
  const llmService = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('llm') ?? null : null
    } catch {
      return null
    }
  }

  /**
   * Build the summaries payload the panel renders.
   * @returns {object} config plus the newest daily and weekly entries.
   */
  const summariesPayload = () => {
    try {
      const store = loadSummaryStore(dshHome)
      return {
        enabled: summaryEnabled,
        dailyTime: summaryDailyTime,
        weeklyTime: summaryWeeklyTime,
        generatedAt: Date.now(),
        daily: listSummaryEntries(store, 'daily').slice(0, 10),
        weekly: listSummaryEntries(store, 'weekly').slice(0, 6),
        lastError: lastSummaryError,
        lastGeneratedAt: lastSummaryAt,
      }
    } catch (error) {
      return {
        enabled: summaryEnabled,
        dailyTime: summaryDailyTime,
        weeklyTime: summaryWeeklyTime,
        generatedAt: Date.now(),
        daily: [],
        weekly: [],
        lastError: String(error?.message ?? error),
      }
    }
  }

  /**
   * Run one summary generation with the configured route.
   * @param {'daily' | 'weekly'} kind - summary kind.
   * @param {string | undefined} dateKey - period anchor.
   * @returns {Promise<object>} generated entry or a skip reason.
   */
  const runSummary = async (kind, dateKey) => {
    const llm = llmService()
    if (llm === null) return { skipped: true, reason: 'no-llm-service' }
    const target = summaryTarget()
    if (target === null) return { skipped: true, reason: 'no-model-route' }
    const result = await generateSummary({
      kind,
      dateKey,
      dshHome,
      timeZone,
      llm,
      provider: target.provider,
      model: target.model,
      maxChars: summaryMaxChars,
      maxTokens: summaryMaxTokens,
    })
    if (result?.skipped !== true) lastSummaryAt = Date.now()
    return result
  }

  /**
   * Auto-generate summaries whose time has come. Runs on a slow timer and skips
   * keys already attempted within the same local day, so an empty day cannot
   * loop every tick.
   * @returns {Promise<void>}
   */
  let summaryInflight = false
  const summaryAttempts = new Set()
  let summaryAttemptDay = null
  const checkSummaries = async () => {
    if (!summaryEnabled || summaryInflight) return
    try {
      const now = Date.now()
      const bucket = dayKeyOf(now, timeZone)
      if (summaryAttemptDay !== bucket) {
        summaryAttempts.clear()
        summaryAttemptDay = bucket
      }
      const store = loadSummaryStore(dshHome)
      const jobs = dueSummaryJobs({
        now,
        timeZone,
        dailyTime: summaryDailyTime,
        weeklyTime: summaryWeeklyTime,
        store,
      })
      if (jobs.length === 0) return
      // Explain why nothing can be generated instead of failing silently: the
      // panel shows this text, and /api/health repeats it.
      if (llmService() === null || summaryTarget() === null) {
        lastSummaryError = skipMessage(llmService() === null ? 'no-llm-service' : 'no-model-route')
        return
      }
      summaryInflight = true
      for (const job of jobs) {
        const attemptKey = `${job.kind}:${job.dateKey}`
        if (summaryAttempts.has(attemptKey)) continue
        summaryAttempts.add(attemptKey)
        try {
          const result = await runSummary(job.kind, job.dateKey)
          lastSummaryError = result?.skipped === true ? skipMessage(result.reason) : null
        } catch (error) {
          lastSummaryError = String(error?.message ?? error)
        }
      }
    } finally {
      summaryInflight = false
    }
  }

  /**
   * Tracker for one idle window.
   * @param {number} idleMinutes - trailing activity window.
   * @returns {object} tracker instance.
   */
  const trackerFor = (idleMinutes) => {
    let tracker = trackers.get(idleMinutes)
    if (tracker === undefined) {
      tracker = createActiveTracker({ dshHome, idleMinutes, maxSessions: activeMaxSessions, showTarget: showToolTarget })
      trackers.set(idleMinutes, tracker)
    }
    return tracker
  }

  /**
   * Collect (or reuse) the live payload.
   * @param {number} idleMinutes - trailing activity window.
   * @returns {Promise<object>} active payload.
   */
  const ensureActive = async (idleMinutes) => {
    const entry = activeCache.get(idleMinutes)
    if (entry !== undefined && Date.now() - entry.at < ACTIVE_CACHE_MS) return entry.value
    const running = activeInflight.get(idleMinutes)
    if (running !== undefined) return running
    const promise = Promise.resolve()
      .then(() => {
        const payload = trackerFor(idleMinutes).collect()
        activeCache.set(idleMinutes, { at: Date.now(), value: payload })
        activeError = null
        return payload
      })
      .catch((error) => {
        activeError = String(error?.message ?? error)
        throw error
      })
      .finally(() => {
        activeInflight.delete(idleMinutes)
      })
    activeInflight.set(idleMinutes, promise)
    return promise
  }

  /**
   * Collect (or reuse) the aggregate payload.
   * @param {number} days - trailing day window.
   * @param {boolean} force - ignore the freshness window.
   * @returns {Promise<{payload: object, stats: object}>} payload and accounting.
   */
  const ensure = async (days, force) => {
    if (!force && cached !== null && cached.days === days && Date.now() - cached.at < STALE_MS) return cached.value
    if (inflight !== null) return inflight
    inflight = collectWorkbench({ dshHome, timeZone, days, cachePath: config.cachePath, insights: insightsOptions })
      .then((value) => {
        // The panel renders summaries from the same payload as the charts, so a
        // single request and a single repaint cover the whole page.
        value.payload.summaries = summariesPayload()
        cached = { at: Date.now(), days, value }
        lastStats = value.stats
        lastError = null
        return value
      })
      .catch((error) => {
        lastError = String(error?.message ?? error)
        if (cached !== null) return cached.value
        throw error
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  /**
   * Write a JSON response.
   * @param {import('node:http').ServerResponse} res - response sink.
   * @param {number} status - HTTP status.
   * @param {unknown} body - JSON-serializable body.
   */
  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /**
   * Read a small JSON request body.
   * @param {import('node:http').IncomingMessage} req - request.
   * @returns {Promise<object>} parsed body; an empty body yields `{}`.
   */
  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 10_000) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`invalid JSON body: ${String(error?.message ?? error)}`))
        }
      })
      req.on('error', reject)
    })

  ctx.webServer.register({
    name: 'dsh-workbench-summary',
    kind: 'exact',
    path: `${BASE_PATH}/api/summary`,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const url = new URL(req.url ?? BASE_PATH, 'http://localhost')
        const { payload } = await ensure(daysFrom(url, defaultDays), url.searchParams.get('refresh') === '1')
        json(res, 200, payload)
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    name: 'dsh-workbench-active',
    kind: 'exact',
    path: `${BASE_PATH}/api/active`,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? BASE_PATH, 'http://localhost')
      const idleMinutes = clampInt(url.searchParams.get('idleMinutes'), activeIdleMinutes, 1, 120)
      if (!activeEnabled) {
        json(res, 200, {
          enabled: false,
          refreshMs: activeRefreshMs,
          generatedAt: Date.now(),
          idleMinutes,
          counts: emptyActiveCounts(),
          sessions: [],
          jobs: [],
          warnings: [],
        })
        return
      }
      try {
        const payload = await ensureActive(idleMinutes)
        json(res, 200, { enabled: true, refreshMs: activeRefreshMs, ...payload })
      } catch (error) {
        // A live-status failure must never surface as a panel error toast; it
        // degrades to an empty section with the reason attached.
        json(res, 200, {
          enabled: true,
          refreshMs: activeRefreshMs,
          generatedAt: Date.now(),
          idleMinutes,
          counts: emptyActiveCounts(),
          sessions: [],
          jobs: [],
          warnings: [{ sessionId: null, message: String(error?.message ?? error) }],
        })
      }
    },
  })

  ctx.webServer.register({
    name: 'dsh-workbench-summaries',
    kind: 'exact',
    path: `${BASE_PATH}/api/summaries`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        json(res, 200, summariesPayload())
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    name: 'dsh-workbench-summaries-generate',
    kind: 'exact',
    path: `${BASE_PATH}/api/summaries/generate`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const kind = body.kind === 'weekly' ? 'weekly' : 'daily'
        const dateKey = typeof body.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(body.dateKey) ? body.dateKey : undefined
        const result = await runSummary(kind, dateKey)
        if (result?.skipped === true) {
          lastSummaryError = skipMessage(result.reason)
          // A missing service or route is a configuration problem, not an empty
          // period: answer with a non-2xx error so the panel can explain it.
          if (ENVIRONMENT_SKIP_REASONS.has(result.reason)) {
            json(res, 503, { error: lastSummaryError })
            return
          }
          json(res, 200, { skipped: true, reason: result.reason, kind })
          return
        }
        lastSummaryError = null
        json(res, 200, { entry: result, summaries: summariesPayload() })
      } catch (error) {
        lastSummaryError = String(error?.message ?? error)
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    name: 'dsh-workbench-health',
    kind: 'exact',
    path: `${BASE_PATH}/api/health`,
    handler: (req, res) => {
      const trackerStats = [...trackers.values()].map((tracker) => tracker.stats())
      json(res, 200, {
        ok: lastError === null,
        dshHome,
        timeZone,
        defaultDays,
        cached: cached === null ? null : { ageMs: Date.now() - cached.at, days: cached.days },
        lastStats,
        lastError,
        active: {
          enabled: activeEnabled,
          refreshMs: activeRefreshMs,
          idleMinutes: activeIdleMinutes,
          maxSessions: activeMaxSessions,
          showToolTarget,
          trackers: trackerStats,
          lastError: activeError,
        },
        insights: {
          windows: insightWindows,
          contextWarnTokens,
          latencyEnabled,
          pricesConfigured: Object.keys(prices ?? {}).length,
        },
        summaries: {
          enabled: summaryEnabled,
          dailyTime: summaryDailyTime,
          weeklyTime: summaryWeeklyTime,
          provider: summaryProvider === '' ? null : summaryProvider,
          model: summaryModel === '' ? null : summaryModel,
          route: summaryTarget(),
          maxChars: summaryMaxChars,
          maxOutputTokens: summaryMaxTokens,
          attempts: [...summaryAttempts],
          lastError: lastSummaryError,
          lastGeneratedAt: lastSummaryAt,
        },
      })
    },
  })

  ctx.webServer.register({
    name: 'dsh-workbench-dashboard',
    kind: 'exact',
    path: `${BASE_PATH}/dashboard.html`,
    handler: (req, res) => {
      try {
        const html = readFileSync(join(dshHome, 'workbench', 'out', 'dsh-workbench.html'))
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': html.length,
        })
        res.end(html)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('独立仪表盘尚未生成：运行 node ~/.dsh/workbench/tools/build.mjs')
      }
    },
  })

  // Warm the aggregate once so the first panel open is instant.
  ensure(defaultDays, false).catch(() => {})

  // Keep it warm on a slow timer; the timer dies with the plugin fiber.
  const timer = setInterval(() => {
    ensure(defaultDays, true).catch(() => {})
  }, REFRESH_MS)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'dsh-workbench: refresh timer')

  // Auto-generate daily/weekly summaries. A one-off check shortly after boot
  // catches up on a summary missed while the service was down.
  const summaryTimer = setInterval(() => {
    checkSummaries().catch(() => {})
  }, 5 * 60 * 1000)
  summaryTimer.unref?.()
  const summaryBootTimer = setTimeout(() => {
    checkSummaries().catch(() => {})
  }, 20 * 1000)
  summaryBootTimer.unref?.()
  ctx.effect(() => () => {
    clearInterval(summaryTimer)
    clearTimeout(summaryBootTimer)
  }, 'dsh-workbench: summary timer')
}

/**
 * Plugin entry point.
 * @param {object} ctx - host plugin context.
 * @param {object} [config] - plugin row configuration.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    try {
      registerRoutes(scope, config)
    } catch (error) {
      console.error(`[dsh-workbench] routes skipped: ${String(error?.message ?? error)}`)
    }
  })
}

/** No service is required for activation. */
export const inject = []
