/**
 * Tests for the work-summary data layer and the summary generator.
 *
 * Two layers are covered: pure functions over synthetic session events (filters,
 * folding, time windows, due-time rules), and the generator end to end against a
 * temporary DSH home whose session logs are written as real Zstandard frames.
 * No test touches the real `$DSH_HOME`.
 *
 * Run: node --test tools/summaries.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  addDays,
  cleanUserText,
  collectSummaryMaterial,
  dayKeyOf,
  dayWindow,
  foldSessionForSummary,
  isSubstantive,
  isoWeekdayOfKey,
  localTimeOf,
  startOfLocalDay,
  weekWindow,
  workWeekKeys,
} from '../src/summary-data.mjs'
import {
  callSummaryModel,
  dueSummaryJobs,
  formatDateLabel,
  generateDailySummary,
  generateWeeklySummary,
  loadSummaryStore,
  saveSummaryEntry,
  summaryKey,
  summariesPath,
} from '../src/summaries.mjs'

const TZ = 'Asia/Shanghai'

/**
 * Create a throwaway DSH home.
 * @returns {string} absolute path.
 */
function makeHome() {
  return mkdtempSync(join(tmpdir(), 'wb-summaries-'))
}

/**
 * Remove a throwaway DSH home.
 * @param {string} home - path from {@link makeHome}.
 * @returns {void}
 */
function dropHome(home) {
  rmSync(home, { recursive: true, force: true })
}

/**
 * Write one session artifact as a single Zstandard frame of JSONL lines.
 * @param {string} home - DSH home.
 * @param {object[]} events - raw events.
 * @param {string} [sessionId] - session folder name.
 * @returns {void}
 */
function writeSessionLog(home, events, sessionId = 'session-test') {
  const dir = join(home, 'sessions', '--E-demo--', sessionId)
  mkdirSync(dir, { recursive: true })
  const jsonl = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(jsonl)))
}

/**
 * A human message event in the persisted shape.
 * @param {string} text - message text.
 * @param {number} time - epoch ms.
 * @returns {object} event.
 */
function humanMessage(text, time) {
  return { type: 'user/message', seq: 1, time, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

/**
 * An injected context message event in the persisted shape.
 * @param {string} text - message text.
 * @param {number} time - epoch ms.
 * @param {string} [kind] - producer kind.
 * @returns {object} event.
 */
function injectedMessage(text, time, kind = 'runtime-context') {
  return { type: 'user/message', seq: 2, time, data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } }
}

/**
 * A tool call event.
 * @param {number} time - epoch ms.
 * @returns {object} event.
 */
function toolCall(time) {
  return { type: 'tool/call', seq: 3, time, data: { callId: 'c1' } }
}

/**
 * A fake host `llm` service that yields the given chunks.
 * @param {object[]} chunks - stream chunks.
 * @returns {{calls: object[], stream: (options: object) => AsyncIterable<object>}} fake service.
 */
function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* iterate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/**
 * A fake `llm` service whose stream fails on iteration.
 * @param {Error} error - thrown error.
 * @returns {{calls: object[], stream: (options: object) => AsyncIterable<object>}} fake service.
 */
function failingLlm(error) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* iterate() {
        throw error
      })()
    },
  }
}

/** Chunks for a successful model answer. */
const STOP_CHUNKS = [
  { type: 'text-delta', index: 0, text: '今日完成了' },
  { type: 'text-delta', index: 0, text: '总结后端。' },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('cleanUserText strips injected blocks and keeps human text', () => {
  const withReminder = '帮我修复日报接口\n<system-reminder>\nInstructions from: $DSH_HOME/AGENTS.md\n# 全局要求\n</system-reminder>'
  assert.equal(cleanUserText(withReminder), '帮我修复日报接口')

  // A runtime-context snapshot has no wrapper tag: its first line drops it whole.
  const snapshot = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "E:\\\\项目".\n\nYou are a delegated subagent: ...'
  assert.equal(cleanUserText(snapshot), '')

  const timeContext = 'Time sampled while preparing turn 1, step 1: 2026-11-03T16:05:18+08:00[Asia/Shanghai]\nBrowser time zone for this request: unavailable.'
  assert.equal(cleanUserText(timeContext), '')

  // Line-level prefixes are dropped while the human sentence survives.
  assert.equal(cleanUserText('Current working directory: E:\\项目\n帮我跑一遍测试'), '帮我跑一遍测试')
})

test('isSubstantive filters small talk and keeps work requests', () => {
  for (const ack of ['好的', '嗯', '继续', '收到', 'ok', 'OK', '谢谢']) {
    assert.equal(isSubstantive(ack), false, `"${ack}" is small talk`)
  }
  assert.equal(isSubstantive('   '), false)
  assert.equal(isSubstantive('好'), false)
  assert.equal(isSubstantive('帮我把周报兜底补上'), true)
  assert.equal(isSubstantive('E:\\项目\\dsh-workbench-panel\\src\\summaries.mjs'), true, 'a bare path is work')
})

test('foldSessionForSummary takes work signals only from the window', () => {
  const dayStart = Date.parse('2026-11-03T00:00:00+08:00')
  const events = [
    // Identity events predate the window and still describe the session.
    { type: 'session', seq: 0, time: dayStart - 5 * 86_400_000, data: { cwd: 'E:\\项目\\dsh-workbench-panel' } },
    { type: 'session/title', seq: 1, time: dayStart - 5 * 86_400_000, data: { title: '工作总结后端' } },
    // Outside the window: must not count.
    humanMessage('昨天做的事', dayStart - 1000),
    toolCall(dayStart - 500),
    // Inside the window.
    humanMessage('把周报兜底做掉', dayStart + 1000),
    injectedMessage('Current runtime context. injected', dayStart + 2000),
    { type: 'assistant/message', seq: 4, time: dayStart + 3000, data: { content: [{ type: 'text', text: '已经补上原始材料兜底路径。' }] } },
    { type: 'tool/call', seq: 5, time: dayStart + 4000, data: { callId: 'c2' } },
    { type: 'approval/asked', seq: 6, time: dayStart + 4500, data: {} },
    { type: 'deliverables/presented', seq: 7, time: dayStart + 5000, data: { files: [{ path: 'E:\\项目\\out\\周报.md', description: '周报样例' }] } },
    { type: 'todo/write', seq: 8, time: dayStart + 6000, data: { todos: [{ content: '补测试', status: 'completed' }, { content: '发版', status: 'pending' }] } },
  ]
  const folded = foldSessionForSummary({
    events,
    from: dayStart,
    to: dayStart + 86_400_000,
  })
  assert.equal(folded.title, '工作总结后端', 'title comes from the whole log')
  assert.equal(folded.cwd, 'E:\\项目\\dsh-workbench-panel', 'cwd comes from the whole log')
  assert.deepEqual(folded.points, ['把周报兜底做掉'], 'only in-window human messages')
  assert.equal(folded.tools, 1, 'only the in-window tool call counts')
  assert.equal(folded.waitApprovals, 1)
  assert.equal(folded.files.length, 1)
  assert.equal(folded.todos.total, 2)
  assert.equal(folded.todos.completed, 1)
  assert.ok(folded.assistants.length >= 1)
  assert.equal(folded.firstAt, dayStart + 1000)
  assert.equal(folded.lastAt, dayStart + 6000)
})

test('foldSessionForSummary drops injected user-message kinds', () => {
  const base = Date.parse('2026-11-03T00:00:00+08:00')
  const events = [
    humanMessage('真实提问', base + 1000),
    injectedMessage('<system-reminder>injected</system-reminder>', base + 2000, 'agent-instructions'),
    injectedMessage('Current runtime context. injected', base + 3000, 'time-context'),
    injectedMessage('You are teammate x\n用 list_agents 查看', base + 4000),
    { type: 'tool/call', seq: 5, time: base + 5000, data: { callId: 'c' } },
  ]
  const folded = foldSessionForSummary({ events, from: base, to: base + 86_400_000 })
  assert.deepEqual(folded.points, ['真实提问'])
})

test('dayWindow follows the requested zone, including a DST boundary', () => {
  const shanghai = dayWindow('2026-11-03', TZ)
  assert.equal(shanghai.from, Date.parse('2026-11-02T16:00:00Z'))
  assert.equal(shanghai.to, Date.parse('2026-11-03T16:00:00Z'))
  assert.equal(shanghai.fromKey, '2026-11-03')
  assert.equal(shanghai.toKey, '2026-11-03')

  // 8 March 2026 is the US spring-forward day: that local day is 23 hours long.
  const newYork = dayWindow('2026-03-08', 'America/New_York')
  assert.equal(newYork.from, Date.parse('2026-03-08T05:00:00Z'))
  assert.equal(newYork.to, Date.parse('2026-03-09T04:00:00Z'))
  assert.equal(newYork.to - newYork.from, 23 * 3_600_000)

  assert.equal(dayKeyOf(Date.parse('2026-11-03T15:59:59Z'), TZ), '2026-11-03')
  assert.equal(dayKeyOf(Date.parse('2026-11-03T16:00:00Z'), TZ), '2026-11-04')
  assert.deepEqual(localTimeOf(Date.parse('2026-11-03T16:30:00Z'), TZ), { hour: 0, minute: 30 })
  assert.equal(startOfLocalDay('2026-11-04', TZ), Date.parse('2026-11-03T16:00:00Z'))
})

test('weekWindow covers Monday to Friday only', () => {
  assert.equal(isoWeekdayOfKey('2026-11-01'), 7, 'Sunday is 7')
  assert.deepEqual(workWeekKeys('2026-11-01'), { fromKey: '2026-10-26', toKey: '2026-10-30' })
  assert.deepEqual(workWeekKeys('2026-11-03'), { fromKey: '2026-11-02', toKey: '2026-11-06' })
  assert.deepEqual(workWeekKeys('2026-11-06'), { fromKey: '2026-11-02', toKey: '2026-11-06' })
  assert.deepEqual(workWeekKeys('2026-11-07'), { fromKey: '2026-11-02', toKey: '2026-11-06' })

  const week = weekWindow('2026-11-01', TZ)
  assert.equal(week.fromKey, '2026-10-26')
  assert.equal(week.toKey, '2026-10-30')
  assert.equal(week.from, Date.parse('2026-10-25T16:00:00Z'))
  assert.equal(week.to, Date.parse('2026-10-30T16:00:00Z'), 'ends at Saturday midnight')
  assert.equal(addDays('2026-10-30', 1), '2026-10-31')
})

test('dueSummaryJobs applies the explainable daily and weekly rules', () => {
  const empty = { version: 1, entries: {} }
  const mondayMorning = Date.parse('2026-11-02T09:00:00+08:00')
  assert.deepEqual(dueSummaryJobs({ now: mondayMorning, timeZone: TZ, store: empty }), [], 'before the daily time nothing is due')

  const mondayEvening = Date.parse('2026-11-02T19:00:00+08:00')
  assert.deepEqual(dueSummaryJobs({ now: mondayEvening, timeZone: TZ, store: empty }), [
    { kind: 'daily', dateKey: '2026-11-02' },
    { kind: 'daily', dateKey: '2026-11-01' },
    { kind: 'weekly', dateKey: '2026-10-26' },
  ], 'Monday evening fills today, yesterday, and last week')

  const withDailies = {
    version: 1,
    entries: {
      [summaryKey('daily', '2026-11-02', '2026-11-02')]: { kind: 'daily' },
      [summaryKey('daily', '2026-11-01', '2026-11-01')]: { kind: 'daily' },
    },
  }
  assert.deepEqual(dueSummaryJobs({ now: mondayEvening, timeZone: TZ, store: withDailies }), [
    { kind: 'weekly', dateKey: '2026-10-26' },
  ])
  withDailies.entries[summaryKey('weekly', '2026-10-26', '2026-10-30')] = { kind: 'weekly' }
  assert.deepEqual(dueSummaryJobs({ now: mondayEvening, timeZone: TZ, store: withDailies }), [])

  const fridayEvening = Date.parse('2026-11-06T19:00:00+08:00')
  assert.deepEqual(dueSummaryJobs({ now: fridayEvening, timeZone: TZ, store: empty }), [
    { kind: 'daily', dateKey: '2026-11-06' },
    { kind: 'daily', dateKey: '2026-11-05' },
    { kind: 'weekly', dateKey: '2026-11-06' },
  ], 'Friday evening writes the current week')

  const saturdayEvening = Date.parse('2026-11-07T19:00:00+08:00')
  assert.deepEqual(dueSummaryJobs({ now: saturdayEvening, timeZone: TZ, store: empty }), [
    { kind: 'daily', dateKey: '2026-11-07' },
    { kind: 'daily', dateKey: '2026-11-06' },
    { kind: 'weekly', dateKey: '2026-11-07' },
  ], 'the weekend still guarantees the week that just ended')

  // A custom weekly time can be due while the daily one is not.
  assert.deepEqual(
    dueSummaryJobs({ now: Date.parse('2026-11-02T10:00:00+08:00'), timeZone: TZ, weeklyTime: '09:00', store: empty }),
    [{ kind: 'weekly', dateKey: '2026-10-26' }],
  )
  // An invalid clock falls back to 18:30 instead of throwing.
  assert.deepEqual(
    dueSummaryJobs({ now: Date.parse('2026-11-02T18:00:00+08:00'), timeZone: TZ, dailyTime: '25:99', store: empty }),
    [],
  )
})

test('callSummaryModel joins deltas and sends the documented options', async () => {
  const llm = fakeLlm(STOP_CHUNKS)
  const text = await callSummaryModel({
    llm,
    provider: 'provider-a',
    model: 'model-x',
    system: 'system text',
    text: 'user text',
    maxTokens: 1234,
  })
  assert.equal(text, '今日完成了总结后端。')
  assert.equal(llm.calls.length, 1)
  const options = llm.calls[0]
  assert.equal(options.provider, 'provider-a')
  assert.equal(options.model, 'model-x')
  assert.equal(options.system, 'system text')
  assert.equal(options.maxTokens, 1234)
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'user text' }] }])
})

test('callSummaryModel redacts credential-shaped output', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'token sk-abcdefghijklmnop 已配置' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const text = await callSummaryModel({ llm, provider: 'p', model: 'm', system: 's', text: 't', maxTokens: 100 })
  assert.match(text, /sk-\*\*\*/u)
  assert.ok(!text.includes('sk-abcdefghijklmnop'))
})

test('callSummaryModel fails clearly on truncated, failed, and empty output', async () => {
  await assert.rejects(
    callSummaryModel({
      llm: fakeLlm([{ type: 'text-delta', index: 0, text: '半截' }, { type: 'finish', reason: { kind: 'max-tokens' } }]),
      provider: 'p', model: 'm', system: 's', text: 't', maxTokens: 10,
    }),
    /截断/u,
  )
  await assert.rejects(
    callSummaryModel({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } }]),
      provider: 'p', model: 'm', system: 's', text: 't', maxTokens: 10,
    }),
    /rate limited/u,
  )
  await assert.rejects(
    callSummaryModel({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'gone', code: 'ABORTED' } } }]),
      provider: 'p', model: 'm', system: 's', text: 't', maxTokens: 10,
    }),
    /取消/u,
  )
  await assert.rejects(
    callSummaryModel({
      llm: fakeLlm([{ type: 'text-delta', index: 0, text: '   ' }, { type: 'finish', reason: { kind: 'stop' } }]),
      provider: 'p', model: 'm', system: 's', text: 't', maxTokens: 10,
    }),
    /没有返回文字/u,
  )
  await assert.rejects(
    callSummaryModel({ llm: null, provider: 'p', model: 'm', system: 's', text: 't', maxTokens: 10 }),
    /模型服务/u,
  )
  await assert.rejects(
    callSummaryModel({
      llm: failingLlm(new Error('network down')),
      provider: 'p', model: 'm', system: 's', text: 't', maxTokens: 10,
    }),
    /network down/u,
  )
})

test('generateDailySummary skips a day with no material', async () => {
  const home = makeHome()
  try {
    const result = await generateDailySummary({
      dshHome: home,
      timeZone: TZ,
      llm: fakeLlm(STOP_CHUNKS),
      provider: 'p',
      model: 'm',
      now: Date.parse('2026-11-03T20:00:00+08:00'),
    })
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'no-material')
    assert.equal(existsSync(summariesPath(home)), false, 'a skip writes nothing')
  } finally {
    dropHome(home)
  }
})

test('generateDailySummary writes one entry from the day material', async () => {
  const home = makeHome()
  try {
    const now = Date.now()
    writeSessionLog(home, [
      { type: 'session', seq: 0, time: now - 60_000, data: { cwd: 'E:\\项目\\dsh-workbench-panel' } },
      humanMessage('把周报兜底补上', now - 50_000),
      humanMessage('好的', now - 40_000),
      injectedMessage('Current runtime context. injected', now - 30_000),
      toolCall(now - 20_000),
    ])
    const dateKey = dayKeyOf(now, TZ)
    const llm = fakeLlm(STOP_CHUNKS)
    const entry = await generateDailySummary({ dshHome: home, timeZone: TZ, llm, provider: 'provider-a', model: 'model-x', now })
    assert.equal(entry.kind, 'daily')
    assert.equal(entry.key, `daily:${dateKey}`)
    assert.equal(entry.fromKey, dateKey)
    assert.equal(entry.title, `${formatDateLabel(dateKey)} 日报`)
    assert.equal(entry.text, '今日完成了总结后端。')
    assert.equal(entry.generatedAt, now)
    assert.equal(entry.model, 'provider-a/model-x')
    assert.equal(entry.sessions, 1)
    assert.equal(entry.messageCount, 1, 'the acknowledgement and the injected message are filtered out')
    assert.ok(entry.materialChars > 0)
    const stored = loadSummaryStore(home)
    assert.ok(stored.entries[entry.key] !== undefined)
    assert.equal(llm.calls.length, 1)
    assert.match(llm.calls[0].messages[0].content[0].text, /今天的工作日报/u)
    assert.match(llm.calls[0].messages[0].content[0].text, /把周报兜底补上/u)
  } finally {
    dropHome(home)
  }
})

test('generateWeeklySummary prefers that week daily reports', async () => {
  const home = makeHome()
  try {
    const now = Date.parse('2026-11-06T19:00:00+08:00') // Friday
    for (const [day, text] of [['2026-11-02', '周一交付日报后端。'], ['2026-11-03', '周二补齐周报兜底。']]) {
      saveSummaryEntry(home, {
        kind: 'daily',
        key: summaryKey('daily', day, day),
        fromKey: day,
        toKey: day,
        title: `${formatDateLabel(day)} 日报`,
        text,
        generatedAt: now - 3_600_000,
        model: 'p/m',
        sessions: 2,
        messageCount: 3,
        materialChars: 100,
      })
    }
    const llm = fakeLlm(STOP_CHUNKS)
    const entry = await generateWeeklySummary({ dshHome: home, timeZone: TZ, llm, provider: 'p', model: 'm', now })
    assert.equal(entry.kind, 'weekly')
    assert.equal(entry.key, 'weekly:2026-11-02~2026-11-06')
    assert.equal(entry.dailyCount, 2)
    assert.equal(entry.sessions, 4, 'session counts summed from the daily reports')
    assert.equal(entry.messageCount, 6)
    assert.equal(entry.generatedAt, now)
    const prompt = llm.calls[0].messages[0].content[0].text
    assert.match(prompt, /每天的日报/u)
    assert.match(prompt, /周二补齐周报兜底/u)
    assert.doesNotMatch(prompt, /原始工作材料/u)
  } finally {
    dropHome(home)
  }
})

test('generateWeeklySummary falls back to the week raw material', async () => {
  const home = makeHome()
  try {
    const now = Date.now()
    writeSessionLog(home, [
      { type: 'session', seq: 0, time: now - 60_000, data: { cwd: 'E:\\项目\\dsh-workbench-panel' } },
      humanMessage('这周修了总结生成链路', now - 50_000),
      toolCall(now - 40_000),
    ])
    // No daily entry exists for this week: the weekly report must still be written.
    const llm = fakeLlm(STOP_CHUNKS)
    const entry = await generateWeeklySummary({ dshHome: home, timeZone: TZ, llm, provider: 'p', model: 'm', now })
    assert.equal(entry.kind, 'weekly')
    assert.equal(entry.dailyCount, 0)
    assert.equal(entry.sessions, 1)
    assert.ok(entry.messageCount >= 1)
    const prompt = llm.calls[0].messages[0].content[0].text
    assert.match(prompt, /原始工作材料/u)
    assert.match(prompt, /这周修了总结生成链路/u)
    assert.ok(loadSummaryStore(home).entries[entry.key] !== undefined)
  } finally {
    dropHome(home)
  }
})

test('generateWeeklySummary skips only a week with no work material at all', async () => {
  const home = makeHome()
  try {
    const result = await generateWeeklySummary({
      dshHome: home,
      timeZone: TZ,
      llm: fakeLlm(STOP_CHUNKS),
      provider: 'p',
      model: 'm',
      now: Date.parse('2026-11-06T19:00:00+08:00'),
    })
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'no-material')
  } finally {
    dropHome(home)
  }
})

test('collectSummaryMaterial joins sessions that only have tools', () => {
  const home = makeHome()
  try {
    const now = Date.now()
    writeSessionLog(home, [
      { type: 'session', seq: 0, time: now - 60_000, data: { cwd: 'E:\\项目\\dsh-workbench-panel' } },
      toolCall(now - 50_000),
      toolCall(now - 40_000),
    ])
    const material = collectSummaryMaterial({ dshHome: home, from: now - 86_400_000, to: now + 60_000 })
    assert.equal(material.sessions.length, 1, 'tool work marks the session as work even without human text')
    assert.equal(material.sessions[0].tools, 2)
    assert.match(material.materialText, /工具×2/u)
  } finally {
    dropHome(home)
  }
})
