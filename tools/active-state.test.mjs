/**
 * Tests for the live "正在处理" state layer.
 *
 * Two kinds of coverage:
 *   1. pure machine folds and display derivation (no filesystem),
 *   2. a real temporary session tree read through the incremental tracker, so
 *      cold start, append-only tailing, torn frames, rewrites and privacy are
 *      exercised against actual Zstandard frames.
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  createActiveTracker,
  createMachine,
  deriveSession,
  describeToolTarget,
  foldEvent,
  maskText,
  summarizeTodos,
} from '../src/active-state.mjs'

const WORKSPACE = '--E-test--'

/**
 * Encode one appended batch as a Zstandard frame of JSON lines.
 * @param {object[]} events - batch events.
 * @returns {Buffer} frame bytes.
 */
function frameOf(events) {
  const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

/**
 * Write a session artifact from batches.
 * @param {string} home - temporary DSH home.
 * @param {string} sessionId - session id.
 * @param {object[][]} batches - one frame per batch.
 * @returns {string} artifact path.
 */
function writeSession(home, sessionId, batches) {
  const path = join(home, 'sessions', WORKSPACE, sessionId, 'session.v4.jsonl.zstd')
  mkdirSync(dirname(path), { recursive: true })
  const chunks = batches.map((batch) => frameOf(batch))
  writeFileSync(path, Buffer.concat(chunks))
  return path
}

/**
 * Append one batch to an existing artifact.
 * @param {string} path - artifact path.
 * @param {object[]} events - batch events.
 * @returns {void}
 */
function appendBatch(path, events) {
  appendFileSync(path, frameOf(events))
}

/**
 * Make a temporary DSH home and clean it up after the test.
 * @param {(home: string) => void | Promise<void>} run - test body.
 * @returns {Promise<void>} test promise.
 */
async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'wb-active-'))
  try {
    await run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Base instant for synthetic events (one minute ago). */
const BASE = Date.now() - 60_000

/**
 * Build a session header event.
 * @param {string} cwd - working directory.
 * @returns {object} event.
 */
function header(cwd = 'E:\\项目') {
  return { type: 'session', seq: 0, time: BASE, cwd, createdAt: BASE }
}

test('foldEvent tracks an open turn, step, tool call and todo list', () => {
  const machine = createMachine()
  foldEvent(machine, header())
  foldEvent(machine, { type: 'session/title', seq: 1, time: BASE + 1, data: { title: '测试会话' } })
  foldEvent(machine, { type: 'turn/start', seq: 2, time: BASE + 10, data: { turn: 7 } })
  foldEvent(machine, { type: 'step/start', seq: 3, time: BASE + 11, data: { turn: 7, step: 1 } })
  foldEvent(machine, { type: 'assistant/message', seq: 4, time: BASE + 100, data: { turn: 7, step: 1 } })
  foldEvent(machine, { type: 'tool/call', seq: 5, time: BASE + 120, data: { turn: 7, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' } })
  foldEvent(machine, { type: 'todo/write', seq: 6, time: BASE + 130, data: { todos: [{ content: '写代码', status: 'completed' }, { content: '跑测试', status: 'in_progress' }, { content: '打包', status: 'pending' }] } })

  assert.equal(machine.cwd, 'E:\\项目')
  assert.equal(machine.title, '测试会话')
  assert.deepEqual(machine.turn, { number: 7, startedAt: BASE + 10 })
  assert.equal(machine.step.number, 1)
  assert.equal(machine.step.hasMessage, true)
  assert.equal(machine.pendingTools.size, 1)
  assert.deepEqual(machine.todos, { total: 3, completed: 1, inProgress: '跑测试' })

  const row = deriveSession(machine, { sessionId: 's1', workspace: WORKSPACE, now: BASE + 1_000 })
  assert.equal(row.status, 'tool')
  assert.equal(row.action.tool, 'pwsh')
  assert.equal(row.action.toolLabel, '运行命令')
  assert.equal(row.action.target, null, 'tool target stays hidden unless the privacy switch is on')
  assert.equal(row.turn, 7)
  assert.equal(row.elapsedMs, 990)
  assert.deepEqual(row.todos, { total: 3, completed: 1, inProgress: '跑测试' })
})

test('deriveSession prefers approvals, then retries, then model work', () => {
  const machine = createMachine()
  foldEvent(machine, { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } })
  foldEvent(machine, { type: 'step/start', seq: 2, time: BASE + 5, data: { turn: 1, step: 1 } })

  let row = deriveSession(machine, { sessionId: 's', workspace: WORKSPACE, now: BASE + 10 })
  assert.equal(row.status, 'model')

  foldEvent(machine, { type: 'llm/retry', seq: 3, time: BASE + 20, data: { retryId: 'r1', retry: 1, maxRetries: 5, failure: { code: 'rate_limit' } } })
  row = deriveSession(machine, { sessionId: 's', workspace: WORKSPACE, now: BASE + 30 })
  assert.equal(row.status, 'retry')
  assert.deepEqual(row.action.retry, { attempt: 1, maxRetries: 5, failureCode: 'rate_limit' })

  foldEvent(machine, { type: 'llm/retry-started', seq: 4, time: BASE + 40, data: { retryId: 'r1' } })
  row = deriveSession(machine, { sessionId: 's', workspace: WORKSPACE, now: BASE + 50 })
  assert.equal(row.status, 'model')

  foldEvent(machine, { type: 'approval/asked', seq: 5, time: BASE + 60, data: { id: 'a1', toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access' } })
  row = deriveSession(machine, { sessionId: 's', workspace: WORKSPACE, now: BASE + 70 })
  assert.equal(row.status, 'approval')
  assert.equal(row.action.toolLabel, '运行命令')
  assert.ok(row.action.reason.includes('escalate'))

  foldEvent(machine, { type: 'approval/decided', seq: 6, time: BASE + 80, data: { id: 'a1', outcome: 'allowed-once' } })
  row = deriveSession(machine, { sessionId: 's', workspace: WORKSPACE, now: BASE + 90 })
  assert.equal(row.status, 'model')
})

test('closing a turn returns the session to idle', () => {
  const machine = createMachine()
  foldEvent(machine, { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } })
  foldEvent(machine, { type: 'step/start', seq: 2, time: BASE + 1, data: { turn: 1, step: 1 } })
  foldEvent(machine, { type: 'step/end', seq: 3, time: BASE + 2, data: { turn: 1, step: 1 } })
  foldEvent(machine, { type: 'turn/end', seq: 4, time: BASE + 3, data: { turn: 1, reason: { kind: 'completed' } } })
  const row = deriveSession(machine, { sessionId: 's', workspace: WORKSPACE, now: BASE + 100 })
  assert.equal(row.status, 'idle')
  assert.equal(row.elapsedMs, null)
  assert.equal(row.turn, null)
})

test('summarizeTodos handles empty and missing lists', () => {
  assert.equal(summarizeTodos(null), null)
  assert.deepEqual(summarizeTodos([]), { total: 0, completed: 0, inProgress: null })
  assert.deepEqual(summarizeTodos([{ content: 'a', status: 'in_progress' }]), { total: 1, completed: 0, inProgress: 'a' })
})

test('maskText strips credential shapes and truncates', () => {
  assert.equal(maskText('token=github_pat_abcdefghijklmnop', 60), 'token=github_pat_***')
  assert.ok(!maskText('Authorization: Bearer sk-abcdefghijklmnopqrstuvwx', 60).includes('abcdefghijklmnopqrstuvwx'))
  assert.ok(maskText('a'.repeat(200), 20).length <= 20)
})

test('describeToolTarget only emits a masked preview when enabled', () => {
  const args = JSON.stringify({ command: 'git push https://github_pat_1234567890abcdef@github.com/x/y.git' })
  assert.equal(describeToolTarget('pwsh', args, false), null)
  const preview = describeToolTarget('pwsh', args, true)
  assert.ok(preview !== null)
  assert.ok(!preview.includes('github_pat_1234567890abcdef'))
  const pathPreview = describeToolTarget('read', JSON.stringify({ path: 'E:\\项目\\医付通\\secret.sql' }), true)
  assert.equal(pathPreview, 'secret.sql', 'file paths collapse to the basename')
})

test('tracker reports a running session, then idle after the turn closes', async () => {
  await withHome((home) => {
    const path = writeSession(home, 'session-a', [
      [header(), { type: 'turn/start', seq: 1, time: BASE + 10, data: { turn: 1 } }],
      [{ type: 'step/start', seq: 2, time: BASE + 20, data: { turn: 1, step: 1 } }, { type: 'assistant/message', seq: 3, time: BASE + 30, data: { turn: 1, step: 1 } }, { type: 'tool/call', seq: 4, time: BASE + 40, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } }],
    ])
    const tracker = createActiveTracker({ dshHome: home, idleMinutes: 10, maxSessions: 10 })

    const first = tracker.collect(BASE + 1_000)
    assert.equal(first.sessions.length, 1)
    assert.equal(first.sessions[0].status, 'tool')
    assert.equal(first.counts.runningTurns, 1)
    assert.equal(first.sessions[0].title, '项目', 'falls back to the cwd basename without a title event')

    appendBatch(path, [
      { type: 'tool/result', seq: 5, time: BASE + 50, data: { turn: 1, step: 1, message: { toolCallId: 'c1' } } },
      { type: 'step/end', seq: 6, time: BASE + 60, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 7, time: BASE + 70, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const second = tracker.collect(BASE + 2_000)
    assert.equal(second.sessions.length, 1, 'idle-but-recent sessions stay listed')
    assert.equal(second.sessions[0].status, 'idle')
    assert.equal(second.counts.runningTurns, 0)
    assert.equal(tracker.stats().coldStarts, 1, 'the append is read incrementally')
  })
})

test('tracker tolerates a torn trailing frame', async () => {
  await withHome((home) => {
    const path = writeSession(home, 'session-torn', [
      [header(), { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } }],
    ])
    const tracker = createActiveTracker({ dshHome: home, idleMinutes: 10 })
    assert.equal(tracker.collect(BASE + 100).sessions[0].status, 'model')

    const nextFrame = frameOf([{ type: 'step/start', seq: 2, time: BASE + 10, data: { turn: 1, step: 1 } }])
    appendFileSync(path, nextFrame.subarray(0, Math.floor(nextFrame.length / 2)))
    const midway = tracker.collect(BASE + 200)
    assert.equal(midway.sessions.length, 1, 'a half-written frame does not break collection')

    appendFileSync(path, nextFrame.subarray(Math.floor(nextFrame.length / 2)))
    const finished = tracker.collect(BASE + 300)
    assert.equal(finished.sessions[0].status, 'model')
    assert.equal(tracker.stats().coldStarts, 1)
  })
})

test('tracker cold-starts again when a log is rewritten smaller', async () => {
  await withHome((home) => {
    const path = writeSession(home, 'session-rewrite', [
      [header(), { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } }],
    ])
    const tracker = createActiveTracker({ dshHome: home, idleMinutes: 10 })
    assert.equal(tracker.collect(BASE + 100).sessions[0].status, 'model')

    writeFileSync(path, frameOf([header(), { type: 'turn/start', seq: 1, time: BASE + 5, data: { turn: 2 } }, { type: 'turn/end', seq: 2, time: BASE + 6, data: { turn: 2, reason: { kind: 'completed' } } }]))
    const after = tracker.collect(BASE + 200)
    assert.equal(after.sessions[0].status, 'idle')
    assert.equal(after.sessions[0].turn, null)
    assert.equal(tracker.stats().coldStarts, 2)
  })
})

test('tracker lists running sessions first and honours maxSessions', async () => {
  await withHome((home) => {
    // Write order decides mtime order: the running session is the newest one.
    writeSession(home, 'session-third', [
      [header(), { type: 'turn/start', seq: 1, time: BASE + 5, data: { turn: 1 } }, { type: 'turn/end', seq: 2, time: BASE + 6, data: { turn: 1, reason: { kind: 'completed' } } }],
    ])
    writeSession(home, 'session-idle', [
      [header(), { type: 'turn/start', seq: 1, time: BASE + 10, data: { turn: 1 } }, { type: 'turn/end', seq: 2, time: BASE + 20, data: { turn: 1, reason: { kind: 'completed' } } }],
    ])
    writeSession(home, 'session-running', [
      [header(), { type: 'turn/start', seq: 1, time: BASE + 30, data: { turn: 1 } }, { type: 'step/start', seq: 2, time: BASE + 31, data: { turn: 1, step: 1 } }],
    ])
    const tracker = createActiveTracker({ dshHome: home, idleMinutes: 10, maxSessions: 2 })
    const payload = tracker.collect(BASE + 500)
    assert.equal(payload.sessions.length, 2)
    assert.equal(payload.sessions[0].sessionId, 'session-running', 'running sessions sort first')
    assert.equal(payload.sessions[0].status, 'model')
    assert.equal(payload.sessions[1].sessionId, 'session-idle')
  })
})

test('tracker reports running jobs without exposing their command text', async () => {
  await withHome((home) => {
    writeSession(home, 'session-job', [
      [header(), { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } }],
      [{ type: 'job/registered', seq: 2, time: BASE + 10, data: { jobId: 'job-1', kind: 'pwsh', label: 'pwsh: git push https://github_pat_secret@github.com', startedAt: BASE + 10 } }],
    ])
    const tracker = createActiveTracker({ dshHome: home, idleMinutes: 10 })
    const payload = tracker.collect(BASE + 1_000)
    assert.equal(payload.jobs.length, 1)
    assert.equal(payload.jobs[0].kind, 'pwsh')
    assert.equal(payload.jobs[0].label, null, 'job labels stay hidden by default')
    assert.equal(payload.counts.runningJobs, 1)
  })
})

test('tracker never leaks tool arguments in the default payload', async () => {
  await withHome((home) => {
    writeSession(home, 'session-secret', [
      [header(), { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } }, { type: 'step/start', seq: 2, time: BASE + 1, data: { turn: 1, step: 1 } }],
      [{ type: 'assistant/message', seq: 3, time: BASE + 2, data: { turn: 1, step: 1 } }, { type: 'tool/call', seq: 4, time: BASE + 3, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"curl -H \\"Authorization: Bearer github_pat_abcdefghijklmnop\\" https://api"}' } }],
    ])
    const payload = createActiveTracker({ dshHome: home, idleMinutes: 10 }).collect(BASE + 1_000)
    const text = JSON.stringify(payload)
    assert.ok(!text.includes('github_pat_'), 'no credential shape may appear anywhere')
    assert.equal(payload.sessions[0].action.target, null)

    const preview = createActiveTracker({ dshHome: home, idleMinutes: 10, showTarget: true }).collect(BASE + 1_000)
    assert.ok(!JSON.stringify(preview).includes('github_pat_'), 'masking still applies with previews on')
  })
})
