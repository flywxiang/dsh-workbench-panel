/**
 * Tests for the recent-window insights: price resolution, cost estimation,
 * deliverables / todos / waiting / context aggregation, report text, and the
 * session-log extraction that feeds all of it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PRICES, buildInsights, estimateCost, formatMoney, formatTokens, resolvePrice } from '../src/insights.mjs'
import { extractSessionCalls } from '../src/session-calls.mjs'
import { buildWorkbenchPayload } from '../src/workbench-data.mjs'

/** Fixed reference instant: 2026-10-22T08:00:00Z. */
const NOW = Date.UTC(2026, 9, 22, 8, 0, 0)
const DAY = 86_400_000
const HOUR = 3_600_000

/**
 * Build one synthetic language-model call record.
 * @param {object} [overrides] - field overrides.
 * @returns {object} call record.
 */
function call(overrides = {}) {
  return {
    sessionId: 'session-a',
    kind: 'conversation',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    startTime: NOW - 2 * HOUR,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    responseMs: 1000,
    ttftMs: 100,
    ...overrides,
  }
}

/**
 * Build one synthetic session record with insight fields.
 * @param {object} [overrides] - field overrides.
 * @returns {object} session record.
 */
function session(overrides = {}) {
  return {
    id: 'session-a',
    cwd: 'E:\\项目',
    title: '慢查询治理',
    lastEventAt: NOW - HOUR,
    models: [{ provider: 'deepseek-official', model: 'deepseek-flash', calls: 2, input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }],
    ...overrides,
  }
}

test('resolvePrice prefers exact routes, then model names, then families', () => {
  assert.deepEqual(resolvePrice(DEFAULT_PRICES, 'deepseek-official', 'deepseek-flash'), DEFAULT_PRICES['deepseek-flash'])
  assert.deepEqual(resolvePrice({ 'p/m': { input: 1, cacheRead: 0, output: 1 } }, 'p', 'm'), { input: 1, cacheRead: 0, output: 1 })
  assert.deepEqual(resolvePrice(DEFAULT_PRICES, 'x', 'my-flash-model'), DEFAULT_PRICES['deepseek-v4-flash'])
  assert.deepEqual(resolvePrice(DEFAULT_PRICES, 'x', 'some-reasoner'), DEFAULT_PRICES['deepseek-v4-pro'])
  assert.equal(resolvePrice(DEFAULT_PRICES, 'kimi-coding', 'k3'), null)
})

test('estimateCost prices input, cache reads and output separately', () => {
  const estimate = estimateCost({ input: 2, cacheRead: 0.5, output: 8 }, {
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 0,
    output: 1_000_000,
  })
  assert.equal(estimate.cost, 10.5)
  assert.equal(estimate.saved, 1.5)
})

test('formatTokens and formatMoney stay compact and readable', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(12_345), '12.3K')
  assert.equal(formatTokens(12_345_678), '12.3M')
  assert.equal(formatMoney(0), '¥0.00')
  assert.equal(formatMoney(9.876), '¥9.88')
  assert.equal(formatMoney(1234), '¥1.23K')
})

test('buildInsights aggregates cost, lists and the weekly report', () => {
  const sessions = [
    session({
      waiting: { kind: 'approval', toolName: 'pwsh', reason: 'escalate token=github_pat_abcdefghijklmnop', since: NOW - 60_000 },
      todos: {
        total: 3,
        completed: 1,
        items: [
          { content: '跑测试', status: 'in_progress' },
          { content: '打包', status: 'pending' },
          { content: '写文档', status: 'completed' },
        ],
      },
      deliverables: [
        { path: 'E:\\项目\\季度报告.md', description: '季度报告', at: NOW - 2 * HOUR },
        { path: 'E:\\项目\\太旧了.md', description: null, at: NOW - 30 * DAY },
      ],
      context: {
        inputTokens: 200_000,
        cacheReadTokens: 16_000,
        cacheWriteTokens: 0,
        maxTokens: 256_000,
        model: 'deepseek-official/deepseek-flash',
        at: NOW - HOUR,
      },
    }),
  ]
  const insights = buildInsights({
    calls: [call()],
    sessions,
    options: { now: NOW, timeZone: 'Asia/Shanghai', windows: { cost: 7, todo: 14, deliverable: 14, waiting: 3, context: 2 } },
  })

  assert.equal(insights.cost.calls, 1)
  assert.equal(insights.cost.pricedCalls, 1)
  assert.equal(insights.cost.total, 10.5)
  assert.equal(insights.cost.saved, 1.5)
  assert.equal(insights.counts.waiting, 1)
  assert.ok(!insights.waiting[0].reason.includes('abcdefghijklmnop'), 'waiting reasons are masked')
  assert.equal(insights.counts.todos, 1)
  assert.equal(insights.todos[0].items.length, 2, 'completed todo items are dropped from the list')
  assert.equal(insights.counts.deliverables, 1, 'deliverables outside the window are dropped')
  assert.equal(insights.deliverables[0].name, '季度报告.md')
  assert.equal(insights.counts.context, 1)
  assert.equal(insights.context[0].usedTokens, 216_000)
  assert.equal(insights.context[0].warnTokens, 200_000)

  const report = insights.reportText
  assert.ok(report.includes('AI 使用周报'), 'report has a header')
  assert.ok(report.includes('调用 1 次'), 'report counts calls')
  assert.ok(report.includes('¥10.5'), 'report includes the estimate')
  assert.ok(report.includes('慢查询治理'), 'report names the most expensive session')
  assert.ok(!report.includes('abcdefghijklmnop'), 'report never leaks credentials')
  assert.ok(!JSON.stringify(insights).includes('abcdefghijklmnop'), 'the whole payload is masked')
})

test('buildInsights reports unpriced models instead of pretending they are free', () => {
  const insights = buildInsights({
    calls: [call({ provider: 'kimi-coding', model: 'k3' })],
    sessions: [session()],
    options: { now: NOW },
  })
  assert.equal(insights.cost.pricedCalls, 0)
  assert.equal(insights.cost.unpricedCalls, 1)
  assert.equal(insights.cost.total, 0)
  assert.ok(insights.reportText.includes('未配置价格'))
  assert.ok(insights.priceNote.includes('未配置价格'))
})

test('buildInsights hides the context warning below the threshold and respects showLatency', () => {
  const insights = buildInsights({
    calls: [],
    sessions: [
      session({
        context: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 256_000, model: null, at: NOW - HOUR },
      }),
    ],
    options: { now: NOW, showLatency: false },
  })
  assert.equal(insights.counts.context, 0, 'a 4% context use is not a warning')
  assert.equal(insights.showLatency, false)
  assert.equal(insights.reportText.includes('调用 0 次'), true)
})

test('extractSessionCalls surfaces title, tokens, deliverables, todos, context and waiting', () => {
  const events = [
    { type: 'session', seq: 0, time: NOW - 10 * HOUR, cwd: 'E:\\项目' },
    { type: 'session/title', seq: 1, time: NOW - 9 * HOUR, data: { title: '季度报告' } },
    { type: 'request/header', seq: 2, time: NOW - 8 * HOUR, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256_000 } } } },
    { type: 'turn/start', seq: 3, time: NOW - 8 * HOUR, data: { turn: 1 } },
    { type: 'step/start', seq: 4, time: NOW - 8 * HOUR, data: { turn: 1, step: 1 } },
    { type: 'assistant/chunk', seq: 5, time: NOW - 8 * HOUR + 500, data: { chunk: { type: 'text-delta', text: 'hi' } } },
    {
      type: 'assistant/message',
      seq: 6,
      time: NOW - 7 * HOUR,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
        usage: { inputTokens: 220_000, outputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 0, totalTokens: 229_000 },
      },
    },
    { type: 'step/end', seq: 7, time: NOW - 7 * HOUR, data: { turn: 1, step: 1 } },
    { type: 'todo/write', seq: 8, time: NOW - 6 * HOUR, data: { todos: [{ content: '写报告', status: 'in_progress' }, { content: '交付', status: 'pending' }] } },
    { type: 'deliverables/presented', seq: 9, time: NOW - 5 * HOUR, data: { turn: 1, callId: 'c1', files: [{ path: 'E:\\项目\\报告.md', description: '季度报告' }] } },
    { type: 'approval/asked', seq: 10, time: NOW - 4 * HOUR, data: { id: 'a1', toolName: 'pwsh', callId: 'c2', reason: 'escalate sandbox token=github_pat_abcdefghijklmnop' } },
  ]
  const { session: extracted } = extractSessionCalls({ sessionId: 'session-a', cwd: 'E:\\项目', createdAt: NOW - 10 * HOUR, events })

  assert.equal(extracted.title, '季度报告')
  assert.equal(extracted.lastEventAt, NOW - 4 * HOUR)
  assert.equal(extracted.tokens.input, 220_000)
  assert.equal(extracted.models.length, 1)
  assert.equal(extracted.models[0].calls, 1)
  assert.deepEqual(extracted.todos, {
    total: 2,
    completed: 0,
    items: [
      { content: '写报告', status: 'in_progress' },
      { content: '交付', status: 'pending' },
    ],
  })
  assert.equal(extracted.deliverables.length, 1)
  assert.equal(extracted.deliverables[0].path, 'E:\\项目\\报告.md')
  assert.equal(extracted.context.inputTokens, 220_000)
  assert.equal(extracted.context.maxTokens, 256_000)
  assert.equal(extracted.waiting.kind, 'approval')
  assert.ok(!extracted.waiting.reason.includes('abcdefghijklmnop'))
})

test('extractSessionCalls marks a pending question as waiting and clears it on turn end', () => {
  const open = extractSessionCalls({
    sessionId: 'session-b',
    events: [
      { type: 'turn/start', seq: 1, time: NOW - HOUR, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: NOW - HOUR, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 3, time: NOW - 30 * 60_000, data: { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{}' } },
    ],
  })
  assert.equal(open.session.waiting.kind, 'answer')

  const closed = extractSessionCalls({
    sessionId: 'session-c',
    events: [
      { type: 'turn/start', seq: 1, time: NOW - HOUR, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: NOW - HOUR, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 3, time: NOW - 30 * 60_000, data: { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{}' } },
      { type: 'turn/end', seq: 4, time: NOW - 20 * 60_000, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  assert.equal(closed.session.waiting, null, 'a closed turn is no longer waiting on the user')
})

test('buildWorkbenchPayload embeds the insights block', () => {
  const payload = buildWorkbenchPayload({
    calls: [call()],
    sessions: [session()],
    scan: { artifacts: 1, sessions: 1, bytes: 10, decodeMs: 1, failures: 0, tornFrames: 0 },
    timeZone: 'Asia/Shanghai',
    days: 7,
    now: NOW,
    insights: { showLatency: false },
  })
  assert.ok(payload.insights !== undefined, 'payload carries insights')
  assert.equal(payload.insights.showLatency, false)
  assert.ok(typeof payload.insights.reportText === 'string' && payload.insights.reportText.length > 0)
  assert.equal(payload.insights.cost.calls, 1)
})
