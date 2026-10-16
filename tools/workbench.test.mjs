/**
 * Tests for the workbench data fold and chart engine.
 *
 * Run: node --test tools/
 *
 * Two layers are covered: pure aggregation over synthetic session logs (so the
 * numbers can be checked by hand), and a full engine render against the DOM shim
 * (so a ReferenceError or a missing control fails here rather than in the GUI).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { extractSessionCalls } from '../src/session-calls.mjs'
import { buildWorkbenchPayload, heatLevel, dayKey } from '../src/workbench-data.mjs'
import { renderWorkbench } from '../src/workbench-render.mjs'
import { ShimDocument } from './dom-shim.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TZ = 'Asia/Shanghai'

/**
 * Build a synthetic session log that exercises every branch of the fold.
 * @returns {object[]} raw events in ascending order.
 */
function syntheticLog() {
  return [
    { type: 'session', seq: 1, time: Date.parse('2026-10-14T01:00:00Z'), cwd: '/tmp/demo' },
    { type: 'turn/start', seq: 2, time: Date.parse('2026-10-14T01:00:01Z'), data: { turn: 1 } },
    { type: 'step/start', seq: 3, time: Date.parse('2026-10-14T01:00:02Z'), data: { turn: 1, step: 1 } },
    {
      type: 'request/context',
      seq: 4,
      time: Date.parse('2026-10-14T01:00:02Z'),
      data: { provider: 'provider-a', model: 'model-x' },
    },
    { type: 'assistant/chunk', seq: 5, time: Date.parse('2026-10-14T01:00:03Z'), data: { chunk: { type: 'reasoning-delta', text: 'hmm' } } },
    { type: 'assistant/chunk', seq: 6, time: Date.parse('2026-10-14T01:00:04Z'), data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, reasoningTokens: 5 } } } },
    { type: 'assistant/message', seq: 7, time: Date.parse('2026-10-14T01:00:05Z'), data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } } },
    { type: 'tool/call', seq: 8, time: Date.parse('2026-10-14T01:00:05Z'), data: { callId: 'c1' } },
    { type: 'tool/result', seq: 9, time: Date.parse('2026-10-14T01:00:35Z'), data: { callId: 'c1' } },
    { type: 'step/end', seq: 10, time: Date.parse('2026-10-14T01:00:36Z'), data: { turn: 1, step: 1 } },
    // Second step switches provider/model and retries once with a wait.
    { type: 'step/start', seq: 11, time: Date.parse('2026-10-14T02:00:00Z'), data: { turn: 1, step: 2 } },
    {
      type: 'request/context',
      seq: 12,
      time: Date.parse('2026-10-14T02:00:00Z'),
      data: { provider: 'provider-b', model: 'model-y' },
    },
    { type: 'llm/retry', seq: 13, time: Date.parse('2026-10-14T02:00:01Z'), data: { retryId: 'r1', delayMs: 2000 } },
    { type: 'assistant/chunk', seq: 14, time: Date.parse('2026-10-14T02:00:04Z'), data: { chunk: { type: 'text-delta', text: 'hi' } } },
    { type: 'assistant/message', seq: 15, time: Date.parse('2026-10-14T02:00:10Z'), data: { turn: 1, step: 2, message: { role: 'assistant', content: [] } } },
    { type: 'step/end', seq: 16, time: Date.parse('2026-10-14T02:00:11Z'), data: { turn: 1, step: 2 } },
    // A trailing step with no usage chunk must still be counted.
    { type: 'step/start', seq: 17, time: Date.parse('2026-10-15T03:00:00Z'), data: { turn: 2, step: 1 } },
    { type: 'assistant/chunk', seq: 18, time: Date.parse('2026-10-15T03:00:02Z'), data: { chunk: { type: 'tool-call-delta', text: 'x' } } },
    { type: 'assistant/message', seq: 19, time: Date.parse('2026-10-15T03:00:06Z'), data: { turn: 2, step: 1, message: { role: 'assistant', content: [] } } },
    { type: 'step/end', seq: 20, time: Date.parse('2026-10-15T03:00:07Z'), data: { turn: 2, step: 1 } },
    // Auxiliary model work outside any step.
    { type: 'session/title-llm-request', seq: 21, time: Date.parse('2026-10-15T03:00:08Z'), data: { route: { provider: 'provider-a', model: 'model-x' } } },
    // A non-model event that must never become a call.
    { type: 'todo/write', seq: 22, time: Date.parse('2026-10-15T03:00:09Z'), data: { todos: [] } },
  ]
}

test('extractSessionCalls: one record per step, route inherited and switched', () => {
  const { calls, session } = extractSessionCalls({ sessionId: 's1', cwd: '/tmp/demo', createdAt: 1, events: syntheticLog() })
  assert.equal(session.callCount, 4)
  const conversation = calls.filter((call) => call.kind === 'conversation')
  assert.equal(conversation.length, 3)

  const [first, second, third] = conversation
  assert.deepEqual([first.provider, first.model], ['provider-a', 'model-x'])
  assert.deepEqual([second.provider, second.model], ['provider-b', 'model-y'])
  assert.deepEqual([third.provider, third.model], ['provider-b', 'model-y'], 'route inherits without a new request/context')

  // Response time stops at the assistant message, so tool time is excluded.
  assert.equal(first.responseMs, 3000)
  assert.equal(first.stepDurationMs, 34_000)
  assert.equal(first.ttftMs, 1000)
  assert.equal(first.inputTokens, 100)
  assert.equal(first.cacheReadTokens, 900)
  assert.equal(first.hasUsage, true)

  // The retry wait is subtracted from the second call's response time.
  assert.equal(second.responseMs, 8000, '10000 - 2000 retry wait')
  assert.equal(second.retries, 1)
  assert.equal(second.ttftMs, 4000)

  // A step with no usage chunk reports null tokens instead of zero.
  assert.equal(third.inputTokens, null)
  assert.equal(third.hasUsage, false)
  assert.equal(third.ttftMs, 2000)

  const auxiliary = calls.filter((call) => call.kind === 'auxiliary')
  assert.equal(auxiliary.length, 1)
  assert.equal(auxiliary[0].auxKind, 'session-title')
})

test('buildWorkbenchPayload: language-model calls only, bucketed by local day', () => {
  const { calls } = extractSessionCalls({ sessionId: 's1', cwd: '/tmp/demo', createdAt: 1, events: syntheticLog() })
  const conversation = calls.filter((call) => call.kind === 'conversation')
  const payload = buildWorkbenchPayload({
    calls: conversation,
    sessions: [{ id: 's1', cwd: '/tmp/demo', createdAt: 1 }],
    scan: { artifacts: 1, bytes: 10, decodeMs: 1 },
    timeZone: TZ,
    days: 3,
    now: Date.parse('2026-10-15T12:00:00+08:00'),
  })

  assert.equal(payload.totals.calls, 3)
  assert.deepEqual(payload.models.map((model) => model.label), ['provider-b/model-y', 'provider-a/model-x'])
  assert.equal(payload.window.from, '2026-10-13')
  assert.equal(payload.window.to, '2026-10-15')

  const callsTrend = payload.trends.calls.buckets
  assert.equal(callsTrend.at(-1).day, '2026-10-15')
  assert.equal(callsTrend.at(-1).total, 1)
  const day14 = callsTrend.find((bucket) => bucket.day === '2026-10-14')
  assert.equal(day14.total, 2, '01:00Z and 02:00Z both land on 14 Oct in Shanghai')
  assert.equal(day14.values.calls['provider-a/model-x'], 1)
  assert.equal(day14.values.calls['provider-b/model-y'], 1)

  assert.equal(payload.trends.tokens.keyMax.inputTokens, 100)
  assert.equal(payload.trends.tokens.keyMax.cacheReadTokens, 900)
  assert.equal(payload.usage.inputTokens, 100)
  assert.equal(payload.latency.p50ResponseMs, 6000, 'median of 3000/8000/6000')
  assert.equal(payload.usage.llmMs, 17_000)
  // Coverage counts the samples that exist instead of assuming them: one of the
  // three synthetic steps carries no usage chunk, and all three stream content.
  assert.equal(payload.coverage.usage, +(1 / 3).toFixed(3))
  assert.equal(payload.coverage.ttft, 1)
  assert.equal(payload.coverage.response, 1)

  // Heatmap rows are Monday-first: 14 Oct 2026 is a Wednesday (row 2).
  assert.equal(payload.heatmap.grid[2][9], 1, '01:00Z is 09:00 in Shanghai')
  assert.equal(payload.heatmap.grid[2][10], 1)
  assert.equal(payload.heatmap.grid[3][11], 1, '15 Oct 03:00Z is 11:00 Shanghai')
  assert.equal(payload.heatmap.max, 1)
  assert.equal(payload.heatmap.byModel['provider-a/model-x'].max, 1)
})

test('day boundaries follow the requested zone, not UTC', () => {
  const epochMs = Date.parse('2026-10-14T16:30:00Z')
  assert.equal(dayKey(epochMs, 'UTC'), '2026-10-14')
  assert.equal(dayKey(epochMs, TZ), '2026-10-15')
})

test('heatLevel quantizes against the map maximum', () => {
  assert.equal(heatLevel(0, 10), 0)
  assert.equal(heatLevel(1, 10), 1)
  assert.equal(heatLevel(3, 10), 2)
  assert.equal(heatLevel(9, 10), 4)
  assert.equal(heatLevel(5, 0), 0)
})

test('renderWorkbench draws every control and survives interaction', () => {
  const doc = new ShimDocument()
  const host = doc.createElement('div')
  host.clientWidth = 900

  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  const dispose = renderWorkbench(host, payload, {})

  const text = host.descendants().map((node) => node.textContent).join('')
  for (const label of ['工作台', '每日趋势', '延迟趋势', '调用热力图', 'LLM 调用']) {
    assert.ok(text.includes(label), `header/control "${label}" is rendered`)
  }
  assert.equal(host.querySelectorAll('svg').length, 3, 'trend, latency, and heatmap SVGs')
  // The heatmap is now a daily calendar (one cell per day, weeks in columns),
  // so we count calendar cells instead of weekday×hour cells.
  const calCells = host.querySelectorAll('.wb-heat-cell')
  assert.ok(calCells.length > 0, 'daily calendar cells exist')
  assert.equal(calCells.length, payload.heatmapDaily.length, 'one cell per day in the heatmap window')
  assert.ok(host.querySelectorAll('.wb-heat-month').length >= 1, 'at least one month label is rendered')
  assert.equal(host.querySelectorAll('.wb-heat-wday').length, 3, 'weekday labels on every other row')
  assert.equal(host.querySelectorAll('.wb-heat-swatch').length, 5, 'legend shows all five levels')
  assert.ok(host.querySelectorAll('.wb-bar').length > 0, 'stacked bars exist')
  assert.ok(host.querySelectorAll('.wb-line').length > 0, 'latency lines exist')

  // Switch metric and heat scope through the same handlers the GUI uses.
  const buttons = host.querySelectorAll('button')
  const tokenButton = buttons.find((button) => button.textContent === 'Token 用量')
  assert.ok(tokenButton !== undefined, 'token metric button exists')
  tokenButton.dispatch('click')
  assert.ok(tokenButton.classList.contains('wb-btn-active'))

  const select = host.querySelectorAll('select')[0]
  assert.ok(select.children.length > 1, 'heatmap scope options include every model')
  select.value = payload.models[0].label
  select.dispatch('change')
  // The calendar view is all-models only; switching scope keeps the same cell count.
  assert.equal(
    host.querySelectorAll('.wb-heat-cell').length,
    payload.heatmapDaily.length,
    'calendar grid keeps its full cell count when scope changes',
  )

  const segments = host.querySelectorAll('.wb-bar').length
  const secondButton = buttons.find((button) => button.textContent === '模型响应时间')
  secondButton.dispatch('click')
  assert.notEqual(host.querySelectorAll('.wb-bar').length, segments, 'response-time metric redraws the bars')

  dispose()
})

test('renderWorkbench tolerates an empty payload', () => {
  const doc = new ShimDocument()
  const host = doc.createElement('div')
  const empty = buildWorkbenchPayload({
    calls: [],
    sessions: [],
    scan: {},
    timeZone: TZ,
    days: 7,
    now: Date.parse('2026-10-15T12:00:00+08:00'),
  })
  const dispose = renderWorkbench(host, empty, {})
  // The calendar renders one cell per day in the window (zero-calls days still
  // get a white cell), and no bars are drawn when there are no calls.
  assert.equal(host.querySelectorAll('.wb-heat-cell').length, empty.heatmapDaily.length)
  assert.equal(host.querySelectorAll('.wb-bar').length, 0, 'no calls means no bars')
  assert.equal(empty.totals.calls, 0)
  dispose()
})
