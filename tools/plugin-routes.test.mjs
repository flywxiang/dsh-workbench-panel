/**
 * Tests for the plugin host half: the route table it claims and the responses
 * it writes, driven through a fake context and fake request/response objects.
 *
 * Run: node --test "tools/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_PATH, registerRoutes } from '../plugin/lib/index.mjs'

/**
 * One temporary parse cache per test run, so route tests never contend over the
 * shared cache file the dashboard build uses.
 */
const testCache = join(mkdtempSync(join(tmpdir(), 'wb-routes-')), 'sessions.json')
process.on('exit', () => rmSync(join(testCache, '..'), { recursive: true, force: true }))

/** Collect the routes a plugin registers. */
function fakeContext() {
  const routes = []
  const effects = []
  return {
    routes,
    effects,
    webServer: {
      /** @param {object} route - route registration. */
      register(route) {
        routes.push(route)
      },
    },
    /** @param {Function} factory - effect factory. */
    effect(factory) {
      effects.push(factory())
    },
    /** @param {string[]} _names - injected service names. @param {Function} fn - callback. */
    inject(_names, fn) {
      fn(this)
    },
  }
}

/** Minimal response sink that records status, headers, and body. */
function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
  }
}

test('registerRoutes claims the four exact routes under the plugin prefix', () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: join(homedir(), '.dsh'), timeZone: 'Asia/Shanghai', days: 60, cachePath: testCache })
  const paths = ctx.routes.map((route) => `${route.kind} ${route.path}`)
  assert.deepEqual(paths, [
    `exact ${BASE_PATH}/api/summary`,
    `exact ${BASE_PATH}/api/active`,
    `exact ${BASE_PATH}/api/health`,
    `exact ${BASE_PATH}/dashboard.html`,
  ])
  assert.equal(ctx.effects.length, 1, 'the refresh timer is registered as a disposable effect')
  for (const factory of ctx.effects) {
    const dispose = factory
    assert.equal(typeof dispose, 'function')
    dispose()
  }
})

test('the summary route answers with the aggregated payload', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: join(homedir(), '.dsh'), timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
  const summary = ctx.routes.find((route) => route.path.endsWith('/api/summary'))
  const res = fakeResponse()
  await summary.handler({ method: 'GET', url: `${BASE_PATH}/api/summary?days=7` }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  const payload = JSON.parse(res.body)
  assert.ok(payload.totals.calls > 0, 'the local corpus has calls to chart')
  assert.equal(payload.window.days, 7)
  assert.equal(payload.timeZone, 'Asia/Shanghai')
  assert.ok(Array.isArray(payload.heatmap.grid))
  assert.equal(payload.heatmap.grid.length, 7)
  assert.equal(payload.heatmap.grid[0].length, 24)
  assert.ok(payload.models.length > 0)
})

test('the summary route rejects other methods', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: join(homedir(), '.dsh'), days: 7, cachePath: testCache })
  const summary = ctx.routes.find((route) => route.path.endsWith('/api/summary'))
  const res = fakeResponse()
  await summary.handler({ method: 'POST', url: `${BASE_PATH}/api/summary` }, res)
  assert.equal(res.status, 405)
})

test('the health route reports collection accounting', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: join(homedir(), '.dsh'), timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
  const health = ctx.routes.find((route) => route.path.endsWith('/api/health'))
  const res = fakeResponse()
  health.handler({ method: 'GET', url: `${BASE_PATH}/api/health` }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.timeZone, 'Asia/Shanghai')
  assert.equal(body.defaultDays, 7)
  assert.ok(body.cached === null || typeof body.cached.ageMs === 'number')
  assert.equal(body.active.enabled, true)
  assert.equal(body.active.idleMinutes, 10)
  assert.equal(body.active.refreshMs, 10000)
})

test('the active route answers with live state and degrades safely', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: join(homedir(), '.dsh'), timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
  const active = ctx.routes.find((route) => route.path.endsWith('/api/active'))
  const res = fakeResponse()
  await active.handler({ method: 'GET', url: `${BASE_PATH}/api/active` }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  const body = JSON.parse(res.body)
  assert.equal(body.enabled, true)
  assert.equal(body.refreshMs, 10000)
  assert.ok(Array.isArray(body.sessions))
  assert.ok(Array.isArray(body.jobs))
  assert.ok(Array.isArray(body.warnings))
  assert.equal(typeof body.counts.runningTurns, 'number')
})

test('the active route honours a disabled configuration and rejects other methods', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: join(homedir(), '.dsh'), days: 7, cachePath: testCache, activeEnabled: false })
  const active = ctx.routes.find((route) => route.path.endsWith('/api/active'))
  const res = fakeResponse()
  await active.handler({ method: 'GET', url: `${BASE_PATH}/api/active` }, res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).enabled, false)

  const rejected = fakeResponse()
  await active.handler({ method: 'POST', url: `${BASE_PATH}/api/active` }, rejected)
  assert.equal(rejected.status, 405)
})

test('the active route survives a missing sessions directory', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'wb-empty-home-'))
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: emptyHome, days: 7, cachePath: testCache })
  const active = ctx.routes.find((route) => route.path.endsWith('/api/active'))
  const res = fakeResponse()
  await active.handler({ method: 'GET', url: `${BASE_PATH}/api/active?idleMinutes=5` }, res)
  rmSync(emptyHome, { recursive: true, force: true })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.idleMinutes, 5)
  assert.deepEqual(body.sessions, [])
  assert.deepEqual(body.jobs, [])
})
