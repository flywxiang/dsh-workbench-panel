/**
 * Live "what is happening right now" state for the workbench panel.
 *
 * The workbench already reads the persisted session logs for its historical
 * charts. This module reads the same artifacts, but only what it needs to answer
 * "what is being processed right now":
 *
 *   - which sessions still have an open turn or step,
 *   - which tool call or approval is pending,
 *   - which background jobs are still running,
 *   - the agent's current todo list.
 *
 * Cost matters here because the panel polls this every few seconds, so the
 * reader is incremental: each session keeps a per-log cursor and only the newly
 * appended Zstandard frames are decoded. A cold start (first sighting, or a log
 * that was rewritten) walks backwards from the tail in growing windows, which
 * avoids decompressing a multi-megabyte log just to show its last few events.
 *
 * Everything is derived from documented session events only; unknown events are
 * ignored, and a log that cannot be decoded degrades to an `unavailable` entry
 * instead of failing the whole collection.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from './zstd-frames.mjs'
import { listSessionArtifacts } from './collect.mjs'

/** Zstandard frame magic number, little endian on disk. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Tail windows tried during a cold start, smallest first (bytes). */
const COLD_WINDOWS = [64 * 1024, 256 * 1024, 1024 * 1024]

/** Bytes read from the head to recover the session header (cwd/createdAt). */
const HEAD_WINDOWS = [64 * 1024, 512 * 1024]

/** How many magic candidates a tail window may try before giving up. */
const MAX_CANDIDATES = 64

/** States kept in memory; older ones are pruned. */
const MAX_TRACKED = 64

/** Chinese labels for the tools the panel can report. */
export const TOOL_LABELS = {
  pwsh: '运行命令',
  bash: '运行命令',
  read: '读取文件',
  write: '写文件',
  edit: '修改文件',
  glob: '查找文件',
  grep: '搜索内容',
  web_fetch: '抓取网页',
  web_search: '联网搜索',
  todo_write: '更新计划',
  todo: '更新计划',
  skill: '加载技能',
  present: '交付文件',
  subagent: '启动子任务',
  subagent_fork: '启动子任务',
  job_output: '读取任务输出',
  job_kill: '结束任务',
  job_list: '查看任务',
  ask_user_question: '征求意见',
  schedule_create: '创建提醒',
  schedule_update: '修改提醒',
  schedule_list: '查看提醒',
  schedule_delete: '删除提醒',
  workflow: '运行工作流',
  goal: '设定目标',
  session_search: '检索会话',
  session_event_search: '检索事件',
  team_task_create: '建团队任务',
  team_task_update: '更新团队任务',
  team_task_list: '查看团队任务',
}

/** Secret shapes that must never reach the browser, even when previews are on. */
const SECRET_PATTERNS = [
  [/github_pat_[A-Za-z0-9_]{10,}/g, 'github_pat_***'],
  [/gh[pousr]_[A-Za-z0-9_]{10,}/g, 'gh*_***'],
  [/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***'],
  [/AKIA[0-9A-Z]{12,}/g, 'AKIA***'],
  [/\b[A-Za-z0-9_+/=-]{40,}\b/g, '***'],
]

/**
 * Read a byte range without loading the whole file.
 * @param {string} path - file path.
 * @param {number} start - first byte.
 * @param {number} length - bytes to read.
 * @returns {Buffer} the bytes actually read.
 */
function readRange(path, start, length) {
  if (length <= 0) return Buffer.alloc(0)
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * Decode every complete Zstandard frame at the start of a buffer.
 * @param {Buffer} buffer - bytes that begin on a frame boundary.
 * @returns {{events: object[], completeEnd: number, frames: number, torn: boolean}}
 *   decoded events, bytes covered by complete frames, frame count, trailing-torn flag.
 */
export function decodeFrames(buffer) {
  let scan
  try {
    scan = scanZstdFrames(buffer)
  } catch {
    return { events: [], completeEnd: 0, frames: 0, torn: false }
  }
  const events = []
  for (const frame of scan.frames) {
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      return { events, completeEnd: frame.start, frames: scan.frames.indexOf(frame), torn: true }
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A malformed line is skipped; the rest of the frame still counts.
      }
    }
  }
  const completeEnd = scan.frames.length === 0 ? 0 : scan.frames[scan.frames.length - 1].end
  return { events, completeEnd, frames: scan.frames.length, torn: scan.tornStart !== undefined }
}

/**
 * Fresh per-session machine state.
 * @returns {object} empty state.
 */
export function createMachine() {
  return {
    title: null,
    cwd: null,
    createdAt: null,
    model: null,
    turn: null,
    step: null,
    pendingTools: new Map(),
    pendingApprovals: new Map(),
    retry: null,
    jobs: new Map(),
    todos: null,
    lastEventAt: 0,
    lastEventType: null,
    events: 0,
    sawTurnStart: false,
    sawTurnEnd: false,
  }
}

/**
 * Fold one session event into the machine.
 * @param {object} machine - state to mutate.
 * @param {object} event - raw session event.
 * @returns {void}
 */
export function foldEvent(machine, event) {
  const type = event?.type
  if (typeof type !== 'string') return
  const data = event?.data ?? {}
  const time = typeof event?.time === 'number' ? event.time : machine.lastEventAt
  machine.events += 1
  machine.lastEventType = type
  if (time > 0) machine.lastEventAt = time

  switch (type) {
    case 'session':
      machine.cwd = typeof event.cwd === 'string' ? event.cwd : (typeof data.cwd === 'string' ? data.cwd : machine.cwd)
      machine.createdAt = typeof event.createdAt === 'number' ? event.createdAt : (typeof data.createdAt === 'number' ? data.createdAt : machine.createdAt)
      return
    case 'session/title':
      if (typeof data.title === 'string') machine.title = data.title
      return
    case 'request/header': {
      const config = data.header?.config ?? data.config ?? data
      if (config?.provider !== undefined && config?.model !== undefined) {
        machine.model = { provider: String(config.provider), model: String(config.model) }
      }
      return
    }
    case 'model/selection':
    case 'request/context':
      if (data.provider !== undefined && data.model !== undefined) {
        machine.model = { provider: String(data.provider), model: String(data.model) }
      }
      return
    case 'turn/start':
      machine.sawTurnStart = true
      machine.turn = { number: data.turn ?? null, startedAt: time }
      machine.step = null
      machine.retry = null
      machine.pendingApprovals.clear()
      return
    case 'turn/end':
      machine.sawTurnEnd = true
      machine.turn = null
      machine.step = null
      machine.retry = null
      machine.pendingTools.clear()
      machine.pendingApprovals.clear()
      return
    case 'step/start':
      machine.step = { number: data.step ?? null, startedAt: time, hasMessage: false }
      machine.retry = null
      return
    case 'step/end':
      machine.step = null
      machine.retry = null
      machine.pendingTools.clear()
      machine.pendingApprovals.clear()
      return
    case 'assistant/message':
      if (machine.step !== null) machine.step.hasMessage = true
      machine.retry = null
      return
    case 'tool/call':
      if (typeof data.callId === 'string') {
        machine.pendingTools.set(data.callId, {
          callId: data.callId,
          name: typeof data.name === 'string' ? data.name : '?',
          arguments: typeof data.arguments === 'string' ? data.arguments : '',
          startedAt: time,
        })
      }
      return
    case 'tool/result': {
      const callId = data.message?.toolCallId ?? data.toolCallId ?? data.callId
      if (typeof callId === 'string') machine.pendingTools.delete(callId)
      return
    }
    case 'approval/asked':
      if (typeof data.id === 'string') {
        machine.pendingApprovals.set(data.id, {
          id: data.id,
          toolName: typeof data.toolName === 'string' ? data.toolName : '?',
          callId: typeof data.callId === 'string' ? data.callId : null,
          reason: typeof data.reason === 'string' ? data.reason : '',
          askedAt: time,
        })
      }
      return
    case 'approval/decided':
      if (typeof data.id === 'string') machine.pendingApprovals.delete(data.id)
      return
    case 'job/registered':
      if (typeof data.jobId === 'string') {
        machine.jobs.set(data.jobId, {
          jobId: data.jobId,
          kind: typeof data.kind === 'string' ? data.kind : 'job',
          label: typeof data.label === 'string' ? data.label : '',
          startedAt: typeof data.startedAt === 'number' ? data.startedAt : time,
        })
      }
      return
    case 'job/settled':
      if (typeof data.jobId === 'string') machine.jobs.delete(data.jobId)
      return
    case 'llm/retry':
      machine.retry = {
        retryId: typeof data.retryId === 'string' ? data.retryId : null,
        attempt: typeof data.retry === 'number' ? data.retry : null,
        maxRetries: typeof data.maxRetries === 'number' ? data.maxRetries : null,
        failureCode: typeof data.failure?.code === 'string' ? data.failure.code : null,
        at: time,
      }
      return
    case 'llm/retry-started':
      if (machine.retry !== null && machine.retry.retryId === (data.retryId ?? null)) machine.retry = null
      return
    case 'todo/write':
      machine.todos = summarizeTodos(Array.isArray(data.todos) ? data.todos : null)
      return
    default:
  }
}

/**
 * Reduce a todo array to the numbers the panel shows.
 * @param {object[] | null} todos - raw `todo/write` payload.
 * @returns {{total: number, completed: number, inProgress: string | null} | null}
 *   summary, or null when the list is absent.
 */
export function summarizeTodos(todos) {
  if (todos === null) return null
  let completed = 0
  let inProgress = null
  for (const item of todos) {
    const status = typeof item?.status === 'string' ? item.status : ''
    if (status === 'completed') completed += 1
    else if (status === 'in_progress' && inProgress === null && typeof item?.content === 'string') {
      inProgress = truncate(item.content, 80)
    }
  }
  return { total: todos.length, completed, inProgress }
}

/**
 * Truncate text for display.
 * @param {string} text - input text.
 * @param {number} max - maximum length.
 * @returns {string} truncated text.
 */
function truncate(text, max) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Remove credential-shaped substrings from free text.
 * @param {string} text - raw text.
 * @param {number} max - maximum output length.
 * @returns {string} masked text.
 */
export function maskText(text, max = 60) {
  let masked = String(text)
  for (const [pattern, replacement] of SECRET_PATTERNS) masked = masked.replace(pattern, replacement)
  return truncate(masked, max)
}

/**
 * Summarize one pending tool call for display, honouring the privacy switch.
 * @param {string} name - tool name.
 * @param {string} rawArguments - raw JSON argument string.
 * @param {boolean} showTarget - whether a masked target may be emitted.
 * @returns {string | null} display label or null when previews are off.
 */
export function describeToolTarget(name, rawArguments, showTarget) {
  if (!showTarget) return null
  let args
  try {
    args = JSON.parse(rawArguments)
  } catch {
    return maskText(rawArguments, 60)
  }
  const candidates = [args?.command, args?.cmd, args?.path, args?.file_path, args?.filePath, args?.pattern, args?.description]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const oneLine = candidate.split('\n')[0]
    return maskText(oneLine.includes('/') || oneLine.includes('\\') ? basename(oneLine) : oneLine, 60)
  }
  return null
}

/**
 * Derive the display row for one session machine.
 * @param {object} machine - folded state.
 * @param {object} context - `{ sessionId, workspace, now, showTarget }`.
 * @returns {object} session row for the API payload.
 */
export function deriveSession(machine, context) {
  const { sessionId, workspace, now, showTarget = false } = context
  const pendingApproval = [...machine.pendingApprovals.values()].sort((a, b) => b.askedAt - a.askedAt)[0]
  const pendingTool = [...machine.pendingTools.values()].sort((a, b) => b.startedAt - a.startedAt)[0]

  let status = 'idle'
  let action = { kind: 'idle', tool: null, toolLabel: null, target: null, reason: null, retry: null }
  if (pendingApproval !== undefined) {
    status = 'approval'
    action = {
      kind: 'approval',
      tool: pendingApproval.toolName,
      toolLabel: TOOL_LABELS[pendingApproval.toolName] ?? '执行工具',
      target: null,
      reason: maskText(pendingApproval.reason, 80),
      retry: null,
    }
  } else if (machine.retry !== null) {
    status = 'retry'
    action = {
      kind: 'retry',
      tool: null,
      toolLabel: null,
      target: null,
      reason: null,
      retry: {
        attempt: machine.retry.attempt,
        maxRetries: machine.retry.maxRetries,
        failureCode: machine.retry.failureCode,
      },
    }
  } else if (machine.turn !== null) {
    if (machine.step !== null && machine.step.hasMessage === false) {
      status = 'model'
      action = { kind: 'model', tool: null, toolLabel: null, target: null, reason: null, retry: null }
    } else if (pendingTool !== undefined) {
      status = 'tool'
      action = {
        kind: 'tool',
        tool: pendingTool.name,
        toolLabel: TOOL_LABELS[pendingTool.name] ?? '执行工具',
        target: describeToolTarget(pendingTool.name, pendingTool.arguments, showTarget),
        reason: null,
        retry: null,
      }
    } else {
      status = 'model'
      action = { kind: 'model', tool: null, toolLabel: null, target: null, reason: null, retry: null }
    }
  }

  const running = status !== 'idle'
  const startedAt = running ? (machine.turn?.startedAt ?? machine.step?.startedAt ?? machine.lastEventAt) : null
  const title = machine.title ?? (machine.cwd === null ? sessionId.replace(/^session-/u, '').slice(0, 12) : basename(machine.cwd))
  return {
    sessionId,
    workspace,
    title,
    cwd: machine.cwd,
    status,
    turn: machine.turn?.number ?? null,
    step: machine.step?.number ?? (machine.turn === null ? null : (machine.step?.number ?? null)),
    startedAt,
    elapsedMs: startedAt === null ? null : Math.max(0, now - startedAt),
    model: machine.model,
    action,
    todos: machine.todos,
    lastEventAt: machine.lastEventAt,
    dataAgeMs: machine.lastEventAt === 0 ? null : Math.max(0, now - machine.lastEventAt),
    events: machine.events,
  }
}

/**
 * Track live session state across polls.
 * @param {object} options - tracker options.
 * @param {string} options.dshHome - DSH home directory.
 * @param {number} [options.idleMinutes] - include sessions active within this window.
 * @param {number} [options.maxSessions] - how many sessions to inspect.
 * @param {boolean} [options.showTarget] - allow masked tool targets.
 * @returns {{collect: (now?: number) => object, reset: () => void, stats: () => object}}
 *   tracker with collect/reset/stats.
 */
export function createActiveTracker(options) {
  const dshHome = options.dshHome
  const idleMinutes = clampInt(options.idleMinutes, 10, 1, 120)
  const maxSessions = clampInt(options.maxSessions, 10, 1, 50)
  const showTarget = options.showTarget === true
  /** @type {Map<string, object>} */
  const states = new Map()
  let coldStarts = 0
  let lastCollectAt = 0
  let lastCollectMs = 0

  /**
   * Read one artifact incrementally, cold-starting as needed.
   * @param {object} state - per-artifact state.
   * @param {object} artifact - listing entry.
   * @returns {void}
   */
  const sync = (state, artifact) => {
    const stat = statSync(artifact.path)
    const cold = () => {
      coldStarts += 1
      coldStart(state, artifact.path, stat.size)
      state.size = stat.size
      state.mtimeMs = stat.mtimeMs
    }
    if (!state.seeded || stat.size < state.size) {
      cold()
      return
    }
    if (stat.size <= state.size) {
      state.size = stat.size
      state.mtimeMs = stat.mtimeMs
      return
    }
    const chunk = readRange(artifact.path, state.consumed, stat.size - state.consumed)
    if (chunk.length < 4 || chunk.readUInt32LE(0) !== ZSTD_MAGIC.readUInt32LE(0)) {
      cold()
      return
    }
    const decoded = decodeFrames(chunk)
    for (const event of decoded.events) foldEvent(state.machine, event)
    state.consumed += decoded.completeEnd
    state.size = stat.size
    state.mtimeMs = stat.mtimeMs
  }

  /**
   * Rebuild the machine for one artifact from its tail, widening the window
   * until an open/closed turn marker is found (or the whole file was read).
   * @param {object} state - per-artifact state.
   * @param {string} path - artifact path.
   * @param {number} size - current file size.
   * @returns {void}
   */
  const coldStart = (state, path, size) => {
    const headerMachine = createMachine()
    for (const headBytes of HEAD_WINDOWS) {
      const head = readRange(path, 0, Math.min(size, headBytes))
      if (head.length === 0) break
      for (const event of decodeFrames(head).events) {
        if (event?.type === 'session') foldEvent(headerMachine, event)
      }
      if (headerMachine.cwd !== null || headBytes >= size) break
    }
    let done = false
    for (let index = 0; index < COLD_WINDOWS.length && !done; index += 1) {
      const windowBytes = COLD_WINDOWS[index]
      const start = Math.max(0, size - windowBytes)
      const window = readRange(path, start, size - start)
      const magicOffset = ZSTD_MAGIC.readUInt32LE(0)
      let candidates = 0
      for (let offset = 0; offset + 4 <= window.length && candidates < MAX_CANDIDATES; offset += 1) {
        if (window.readUInt32LE(offset) !== magicOffset) continue
        candidates += 1
        const decoded = decodeFrames(window.subarray(offset))
        if (decoded.events.length === 0) continue
        const machine = createMachine()
        machine.cwd = headerMachine.cwd
        machine.createdAt = headerMachine.createdAt
        for (const event of decoded.events) foldEvent(machine, event)
        const absoluteStart = start + offset
        const complete = machine.sawTurnStart || machine.sawTurnEnd || absoluteStart === 0
        if (!complete && index < COLD_WINDOWS.length - 1) break
        state.machine = machine
        state.consumed = absoluteStart + decoded.completeEnd
        state.seeded = true
        state.error = null
        done = true
        break
      }
    }
    if (!done) {
      const whole = readRange(path, 0, size)
      const machine = createMachine()
      for (const event of decodeFrames(whole).events) foldEvent(machine, event)
      state.machine = machine
      state.consumed = size
      state.seeded = true
      state.error = null
    }
  }

  return {
    /**
     * Collect the live payload.
     * @param {number} [now] - reference instant.
     * @returns {object} active payload.
     */
    collect(now = Date.now()) {
      const startedAt = Date.now()
      const idleMs = idleMinutes * 60 * 1000
      const artifacts = listSessionArtifacts(dshHome)
        .filter((artifact) => now - artifact.mtimeMs <= idleMs)
        .slice(0, maxSessions)
      const sessions = []
      const jobs = []
      const warnings = []
      for (const artifact of artifacts) {
        let state = states.get(artifact.path)
        if (state === undefined) {
          state = {
            path: artifact.path,
            machine: null,
            consumed: 0,
            size: -1,
            mtimeMs: 0,
            seeded: false,
            lastSeen: now,
            error: null,
          }
          states.set(artifact.path, state)
        }
        state.lastSeen = now
        try {
          sync(state, artifact)
        } catch (error) {
          state.error = String(error?.message ?? error)
          warnings.push({ sessionId: artifact.sessionId, message: state.error })
        }
        if (state.machine === null) continue
        const row = deriveSession(state.machine, {
          sessionId: artifact.sessionId,
          workspace: artifact.workspace,
          now,
          showTarget,
        })
        if (row.lastEventAt === 0) continue
        sessions.push(row)
        for (const job of state.machine.jobs.values()) {
          jobs.push({
            sessionId: artifact.sessionId,
            title: row.title,
            jobId: job.jobId,
            kind: job.kind,
            startedAt: job.startedAt,
            elapsedMs: Math.max(0, now - job.startedAt),
            label: showTarget ? maskText(job.label, 60) : null,
          })
        }
      }
      for (const [path, state] of states) {
        if (now - state.lastSeen > 2 * 60 * 60 * 1000 || states.size > MAX_TRACKED) states.delete(path)
      }
      sessions.sort((left, right) => {
        const rank = (status) => (status === 'approval' ? 0 : status === 'retry' ? 1 : status === 'tool' ? 2 : status === 'model' ? 3 : 4)
        const byRank = rank(left.status) - rank(right.status)
        if (byRank !== 0) return byRank
        return (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0)
      })
      jobs.sort((left, right) => right.elapsedMs - left.elapsedMs)
      const counts = {
        sessions: sessions.length,
        runningTurns: sessions.filter((session) => session.status !== 'idle').length,
        runningJobs: jobs.length,
        waitingApproval: sessions.filter((session) => session.status === 'approval').length,
        retrying: sessions.filter((session) => session.status === 'retry').length,
      }
      lastCollectAt = now
      lastCollectMs = Date.now() - startedAt
      return {
        generatedAt: now,
        idleMinutes,
        maxSessions,
        counts,
        sessions,
        jobs,
        warnings,
      }
    },

    /** Drop all tracked state, making the next collect a cold start. */
    reset() {
      states.clear()
    },

    /**
     * Tracker diagnostics for the health route.
     * @returns {object} counters.
     */
    stats() {
      return { trackedSessions: states.size, coldStarts, lastCollectAt, lastCollectMs }
    },
  }
}

/**
 * Clamp an integer option.
 * @param {unknown} value - raw value.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}
