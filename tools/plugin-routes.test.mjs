/**
 * Tests for the plugin host half: the route table it claims and the responses
 * it writes, driven through a fake context and fake request/response objects.
 *
 * Run: node --test "tools/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import { BASE_PATH, registerRoutes } from '../plugin/lib/index.mjs'
import { resolveDshHome } from '../src/collect.mjs'

/**
 * One temporary parse cache per test run, so route tests never contend over the
 * shared cache file the dashboard build uses.
 */
const testCache = join(mkdtempSync(join(tmpdir(), 'wb-routes-')), 'sessions.json')
process.on('exit', () => rmSync(join(testCache, '..'), { recursive: true, force: true }))

/**
 * Collect the routes a plugin registers.
 * @param {Record<string, any>} [services] - host services `ctx.get` resolves.
 * @returns {object} fake context.
 */
function fakeContext(services = {}) {
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
    /** @param {string} name - service name. */
    get(name) {
      return services[name]
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

/**
 * Build a fake POST request carrying a JSON body.
 * @param {string} url - request URL.
 * @param {object} body - parsed body to send.
 * @returns {import('node:stream').Readable} request.
 */
function fakePost(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  return req
}

/**
 * Create a throwaway DSH home.
 * @returns {string} path.
 */
function makeHome() {
  return mkdtempSync(join(tmpdir(), 'wb-routes-home-'))
}

/**
 * Write a session log with one human message and one tool call, so the summary
 * generator has material.
 * @param {string} home - DSH home.
 * @returns {void}
 */
function writeMaterial(home) {
  const now = Date.now()
  const events = [
    { type: 'session', seq: 0, time: now - 60_000, data: { cwd: 'E:\\项目\\dsh-workbench-panel' } },
    {
      type: 'user/message',
      seq: 1,
      time: now - 50_000,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把工作台总结接口补完' }] },
    },
    { type: 'tool/call', seq: 2, time: now - 40_000, data: { callId: 'c1' } },
  ]
  const dir = join(home, 'sessions', '--E-demo--', 'session-routes')
  mkdirSync(dir, { recursive: true })
  const jsonl = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(jsonl)))
}

/**
 * Fake host `llm` service yielding a fixed answer.
 * @returns {any} service.
 */
function fakeLlm() {
  return {
    stream() {
      return (async function* iterate() {
        yield { type: 'text-delta', index: 0, text: '今天完成了总结接口。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('registerRoutes claims the six exact routes under the plugin prefix', () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: resolveDshHome(), timeZone: 'Asia/Shanghai', days: 60, cachePath: testCache })
  const paths = ctx.routes.map((route) => `${route.kind} ${route.path}`)
  assert.deepEqual(paths, [
    `exact ${BASE_PATH}/api/summary`,
    `exact ${BASE_PATH}/api/active`,
    `exact ${BASE_PATH}/api/summaries`,
    `exact ${BASE_PATH}/api/summaries/generate`,
    `exact ${BASE_PATH}/api/health`,
    `exact ${BASE_PATH}/dashboard.html`,
  ])
  assert.equal(ctx.effects.length, 2, 'refresh timer and summary timer are disposable effects')
  for (const factory of ctx.effects) {
    const dispose = factory
    assert.equal(typeof dispose, 'function')
    dispose()
  }
})

test('the summary route answers with the aggregated payload', async (t) => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: resolveDshHome(), timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
  const summary = ctx.routes.find((route) => route.path.endsWith('/api/summary'))
  const res = fakeResponse()
  await summary.handler({ method: 'GET', url: `${BASE_PATH}/api/summary?days=7` }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  const payload = JSON.parse(res.body)
  assert.equal(payload.window.days, 7)
  assert.equal(payload.timeZone, 'Asia/Shanghai')
  assert.ok(payload.summaries !== undefined, 'the payload carries the summaries section')
  if (payload.scan.artifacts === 0) {
    t.skip('本机没有可用的会话日志（DSH_HOME 未指向数据目录），跳过图表断言')
    return
  }
  assert.ok(payload.totals.calls > 0, 'the local corpus has calls to chart')
  assert.ok(Array.isArray(payload.heatmap.grid))
  assert.equal(payload.heatmap.grid.length, 7)
  assert.equal(payload.heatmap.grid[0].length, 24)
  assert.ok(payload.models.length > 0)
})

test('the summary route rejects other methods', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: resolveDshHome(), days: 7, cachePath: testCache })
  const summary = ctx.routes.find((route) => route.path.endsWith('/api/summary'))
  const res = fakeResponse()
  await summary.handler({ method: 'POST', url: `${BASE_PATH}/api/summary` }, res)
  assert.equal(res.status, 405)
})

test('the health route reports collection accounting and summary configuration', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: resolveDshHome(), timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
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
  assert.equal(body.summaries.enabled, true)
  assert.equal(body.summaries.dailyTime, '18:30')
  assert.equal(body.summaries.weeklyTime, '18:30')
  assert.equal(body.summaries.maxChars, 60000)
  assert.equal(body.summaries.maxOutputTokens, 4000)
  assert.equal(body.summaries.backfillDays, 7)
  assert.equal(body.summaries.route, null, 'no default-model service in the fake context')
})

test('the active route answers with live state and degrades safely', async () => {
  const ctx = fakeContext()
  registerRoutes(ctx, { dshHome: resolveDshHome(), timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
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
  registerRoutes(ctx, { dshHome: resolveDshHome(), days: 7, cachePath: testCache, activeEnabled: false })
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
  const emptyHome = makeHome()
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

test('GET /api/summaries answers with the documented shape', async () => {
  const home = makeHome()
  try {
    const ctx = fakeContext()
    registerRoutes(ctx, { dshHome: home, timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
    const route = ctx.routes.find((item) => item.path.endsWith('/api/summaries'))
    const res = fakeResponse()
    await route.handler({ method: 'GET', url: `${BASE_PATH}/api/summaries` }, res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.enabled, true)
    assert.equal(body.dailyTime, '18:30')
    assert.equal(body.weeklyTime, '18:30')
    assert.equal(typeof body.generatedAt, 'number')
    assert.equal(body.lastError, null)
    assert.deepEqual(body.daily, [])
    assert.deepEqual(body.weekly, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('GET /api/summaries honours a disabled configuration and rejects other methods', async () => {
  const home = makeHome()
  try {
    const ctx = fakeContext()
    registerRoutes(ctx, { dshHome: home, timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache, summaryEnabled: false })
    const route = ctx.routes.find((item) => item.path.endsWith('/api/summaries'))
    const res = fakeResponse()
    await route.handler({ method: 'GET', url: `${BASE_PATH}/api/summaries` }, res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).enabled, false)

    const rejected = fakeResponse()
    await route.handler({ method: 'POST', url: `${BASE_PATH}/api/summaries` }, rejected)
    assert.equal(rejected.status, 405)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /api/summaries/generate reports a missing model service as a clear error', async () => {
  const home = makeHome()
  try {
    const ctx = fakeContext()
    registerRoutes(ctx, { dshHome: home, timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
    const route = ctx.routes.find((item) => item.path.endsWith('/api/summaries/generate'))
    const res = fakeResponse()
    await route.handler(fakePost(`${BASE_PATH}/api/summaries/generate`, { kind: 'daily' }), res)
    assert.equal(res.status, 503)
    const body = JSON.parse(res.body)
    assert.match(body.error, /模型服务/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /api/summaries/generate reports a missing model route as a clear error', async () => {
  const home = makeHome()
  try {
    const ctx = fakeContext({ llm: fakeLlm() })
    registerRoutes(ctx, { dshHome: home, timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
    const route = ctx.routes.find((item) => item.path.endsWith('/api/summaries/generate'))
    const res = fakeResponse()
    await route.handler(fakePost(`${BASE_PATH}/api/summaries/generate`, { kind: 'weekly' }), res)
    assert.equal(res.status, 503)
    assert.match(JSON.parse(res.body).error, /模型路由/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /api/summaries/generate skips an empty period', async () => {
  const home = makeHome()
  try {
    const ctx = fakeContext({
      llm: fakeLlm(),
      agentDefaultModel: { currentSelection: () => ({ provider: 'provider-a', model: 'model-x' }) },
    })
    registerRoutes(ctx, { dshHome: home, timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
    const route = ctx.routes.find((item) => item.path.endsWith('/api/summaries/generate'))
    for (const kind of ['daily', 'weekly']) {
      const res = fakeResponse()
      await route.handler(fakePost(`${BASE_PATH}/api/summaries/generate`, { kind }), res)
      assert.equal(res.status, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.skipped, true)
      assert.equal(body.reason, 'no-material')
      assert.equal(body.kind, kind)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /api/summaries/generate writes one entry and returns the fresh payload', async () => {
  const home = makeHome()
  try {
    writeMaterial(home)
    const ctx = fakeContext({
      llm: fakeLlm(),
      agentDefaultModel: { currentSelection: () => ({ provider: 'provider-a', model: 'model-x' }) },
    })
    registerRoutes(ctx, { dshHome: home, timeZone: 'Asia/Shanghai', days: 7, cachePath: testCache })
    const route = ctx.routes.find((item) => item.path.endsWith('/api/summaries/generate'))
    const res = fakeResponse()
    await route.handler(fakePost(`${BASE_PATH}/api/summaries/generate`, { kind: 'daily' }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.entry.kind, 'daily')
    assert.equal(body.entry.text, '今天完成了总结接口。')
    assert.equal(body.entry.model, 'provider-a/model-x')
    assert.equal(body.summaries.daily.length, 1)
    assert.equal(body.summaries.daily[0].key, body.entry.key)
    assert.equal(body.summaries.lastError, null)

    const rejected = fakeResponse()
    await route.handler({ method: 'GET', url: `${BASE_PATH}/api/summaries/generate` }, rejected)
    assert.equal(rejected.status, 405)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
