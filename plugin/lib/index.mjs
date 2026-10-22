/**
 * DSH host half of the workbench plugin.
 *
 * Serves the language-model call statistics over HTTP and keeps one warm
 * aggregate in memory:
 *
 *   GET /dsh-workbench/api/summary   aggregated payload (what the panel fetches)
 *   GET /dsh-workbench/api/active    what is being processed right now
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
