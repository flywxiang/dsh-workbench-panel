/**
 * DSH host half of the workbench plugin.
 *
 * Serves the language-model call statistics over HTTP and keeps one warm
 * aggregate in memory:
 *
 *   GET /dsh-workbench/api/summary   aggregated payload (what the panel fetches)
 *   GET /dsh-workbench/api/health    collection accounting, for troubleshooting
 *   GET /dsh-workbench/dashboard.html  the generated standalone page
 *
 * Collection reads the session logs under `$DSH_HOME/sessions` directly with a
 * per-session parse cache, so it needs no host service and cannot be broken by
 * another plugin changing the query API. A background refresh keeps the payload
 * current; a request only pays for a collect when the cached payload is stale.
 *
 * The web server exists only under browser-facing profiles, so the routes ride a
 * scoped `ctx.inject(['webServer'])`: the closure runs where the service appears
 * and never runs where it does not.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectWorkbench, resolveDshHome } from './shared/collect.mjs'

/** Route prefix owned by this plugin. */
export const BASE_PATH = '/dsh-workbench'

/** Refresh interval for the warm aggregate. */
const REFRESH_MS = 5 * 60 * 1000

/** A payload older than this triggers a collect on request. */
const STALE_MS = 60 * 1000

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

  /**
   * Collect (or reuse) the aggregate payload.
   * @param {number} days - trailing day window.
   * @param {boolean} force - ignore the freshness window.
   * @returns {Promise<{payload: object, stats: object}>} payload and accounting.
   */
  const ensure = async (days, force) => {
    if (!force && cached !== null && cached.days === days && Date.now() - cached.at < STALE_MS) return cached.value
    if (inflight !== null) return inflight
    inflight = collectWorkbench({ dshHome, timeZone, days, cachePath: config.cachePath })
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
    name: 'dsh-workbench-health',
    kind: 'exact',
    path: `${BASE_PATH}/api/health`,
    handler: (req, res) => {
      json(res, 200, {
        ok: lastError === null,
        dshHome,
        timeZone,
        defaultDays,
        cached: cached === null ? null : { ageMs: Date.now() - cached.at, days: cached.days },
        lastStats,
        lastError,
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
