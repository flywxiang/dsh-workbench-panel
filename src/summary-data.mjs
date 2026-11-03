/**
 * Build the material a work summary is written from.
 *
 * The summary must be based on what the user actually asked and produced, not on
 * tool output (which is noisy and may contain secrets). This module therefore
 * reads a time window of session logs and keeps only:
 *   - human messages (system reminders and runtime context stripped out),
 *   - short excerpts of the assistant's replies,
 *   - todo lists and delivered files,
 *   - per-session tool counts as a work signal.
 *
 * Sessions without any work signal (no tools, no files, no todos, no file
 * references) are dropped before the model sees them. A prompt still instructs
 * the model to ignore chit-chat, because heuristics alone cannot judge meaning.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { listSessionArtifacts } from './collect.mjs'
import { readZstdJsonl } from './zstd-frames.mjs'
import { truncate } from './redact.mjs'

/** Line prefixes that only ever appear in injected context, never in human text. */
const NOISE_PREFIXES = [
  'Current runtime context.',
  'This snapshot supersedes',
  'Current working directory:',
  'Current DSH file policy:',
  'Approval prompts are disabled',
  'Delegation depth for',
  'You are a delegated subagent:',
  'You are teammate',
  'Your Team Lead is named',
  'To message your Team Lead',
  'To message another teammate',
  'Use list_agents',
  'Current DeepSeek Harness implementation checkout:',
  'Current DeepSeek Harness Web GUI URL:',
  'Time sampled while preparing turn',
  'Browser time zone for this request',
  'Elapsed since the preceding model-visible message',
  'This is an automatically generated checkpoint',
  'The approval policy changed',
  'The following workspace instructions',
  'Workspace instructions',
  'Instructions from:',
  'This conversation is being',
]

/**
 * Leading markers of a whole message that is injected context rather than human
 * input. A runtime-context snapshot is not wrapped in a tag, so matching its
 * first line drops the entire block instead of leaving its later sections behind.
 */
const INJECTED_STARTS = [
  'Current runtime context.',
  'This snapshot supersedes earlier runtime-context snapshots.',
  'Time sampled while preparing turn',
  '<available_skills>',
]

/**
 * Message-source kinds that mean a human typed the message. Injected context
 * uses its own producer-declared kinds (`runtime-context`, `agent-instructions`,
 * `skill-catalog`, `time-context`, …), so anything but `user` is not work input.
 */
const HUMAN_SOURCE_KINDS = new Set(['user'])

/** Short acknowledgements that carry no work content. */
const ACK_TEXTS = new Set([
  '好',
  '好的',
  '嗯',
  '嗯嗯',
  '继续',
  '可以',
  '行',
  '对',
  '是',
  '谢谢',
  '收到',
  '好谢谢',
  '好的谢谢',
  '没问题',
  'ok',
  'okay',
  'yes',
  'no',
  'go',
  '开始',
  '继续吧',
])

/** File-extension shapes that mark a message as work-related. */
const FILE_REF = /(?:[A-Za-z]:\\|\.{1,2}[\\/]|\/)[^\s"'<>|，。；：！？]{1,120}\.(?:[A-Za-z0-9]{1,8})\b/u

/** Cap on the number of sessions, points, and characters in one material. */
const LIMITS = {
  sessions: 40,
  pointsPerSession: 8,
  assistantsPerSession: 3,
  pointChars: 400,
  assistantChars: 220,
  filesPerSession: 8,
  todosPerSession: 5,
}

/** Cached zone formatters and parts, mirroring the chart module. */
const formatters = new Map()
const partsCache = new Map()

/**
 * Resolve local calendar parts for one instant.
 * @param {number} epochMs - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {{year: string, month: string, day: string, hour: number, minute: number, second: number, dayKey: string}} parts.
 */
function zoneParts(epochMs, timeZone) {
  const cacheKey = `${timeZone}|${epochMs}`
  const cached = partsCache.get(cacheKey)
  if (cached !== undefined) return cached
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    formatters.set(timeZone, formatter)
  }
  const values = {}
  for (const part of formatter.formatToParts(new Date(epochMs))) values[part.type] = part.value
  const hour = values.hour === '24' ? 0 : Number.parseInt(values.hour ?? '0', 10)
  const parts = {
    year: values.year ?? '1970',
    month: values.month ?? '01',
    day: values.day ?? '01',
    hour,
    minute: Number.parseInt(values.minute ?? '0', 10),
    second: Number.parseInt(values.second ?? '0', 10),
    dayKey: `${values.year ?? '1970'}-${values.month ?? '01'}-${values.day ?? '01'}`,
  }
  if (partsCache.size >= 100_000) partsCache.clear()
  partsCache.set(cacheKey, parts)
  return parts
}

/**
 * Local offset of a zone at one instant, in milliseconds.
 * @param {number} epochMs - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {number} offset; local time = UTC + offset.
 */
function zoneOffsetMs(epochMs, timeZone) {
  const parts = zoneParts(epochMs, timeZone)
  const asUtc = Date.UTC(
    Number.parseInt(parts.year, 10),
    Number.parseInt(parts.month, 10) - 1,
    Number.parseInt(parts.day, 10),
    parts.hour,
    parts.minute,
    parts.second,
  )
  return asUtc - epochMs
}

/**
 * Local date key of one instant.
 * @param {number} epochMs - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {string} `YYYY-MM-DD` in that zone.
 */
export function dayKeyOf(epochMs, timeZone) {
  return zoneParts(epochMs, timeZone).dayKey
}

/**
 * Local wall-clock time of one instant.
 * @param {number} epochMs - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {{hour: number, minute: number}} local hour and minute.
 */
export function localTimeOf(epochMs, timeZone) {
  const parts = zoneParts(epochMs, timeZone)
  return { hour: parts.hour, minute: parts.minute }
}

/**
 * Epoch of local midnight for a `YYYY-MM-DD` key.
 * @param {string} dayKey - local date key.
 * @param {string} timeZone - IANA zone.
 * @returns {number} epoch milliseconds.
 */
export function startOfLocalDay(dayKey, timeZone) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0)
  const first = zoneOffsetMs(guess, timeZone)
  const start = guess - first
  const refined = zoneOffsetMs(start, timeZone)
  return refined === first ? start : guess - refined
}

/**
 * Add whole days to a date key.
 * @param {string} dayKey - `YYYY-MM-DD`.
 * @param {number} days - days to add (may be negative).
 * @returns {string} resulting date key.
 */
export function addDays(dayKey, days) {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * ISO weekday of a date key (Monday 1 through Sunday 7).
 * @param {string} dayKey - `YYYY-MM-DD`.
 * @returns {number} ISO weekday.
 */
export function isoWeekdayOfKey(dayKey) {
  const day = new Date(`${dayKey}T12:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * Monday-to-Friday range containing a date key.
 * @param {string} dayKey - any day of the week.
 * @returns {{fromKey: string, toKey: string, from: number, to: number}} range in keys, plus bounds resolved by the caller.
 */
export function workWeekKeys(dayKey) {
  const monday = addDays(dayKey, 1 - isoWeekdayOfKey(dayKey))
  return { fromKey: monday, toKey: addDays(monday, 4) }
}

/**
 * Strip injected system material out of one user message.
 * @param {string} raw - raw text.
 * @returns {string} the human part, possibly empty.
 */
export function cleanUserText(raw) {
  let text = String(raw)
  // Whole injected blocks first (they can be long and multi-line).
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, '\n')
  text = text.replace(/<runtime-context>[\s\S]*?<\/runtime-context>/giu, '\n')
  // A snapshot whose first line says what it is carries no human text after it.
  const head = text.trimStart()
  if (INJECTED_STARTS.some((prefix) => head.startsWith(prefix))) return ''
  // Line-level injected prefixes.
  const lines = text.split(/\r?\n/u)
  const kept = lines.filter((line) => {
    const trimmed = line.trim()
    if (trimmed === '') return true
    return !NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  })
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/**
 * Decide whether a `user/message` event came from the human.
 *
 * Logs from newer sessions record the producer in `data.source.kind`; injected
 * context declares kinds such as `runtime-context` or `agent-instructions`.
 * Older logs carry no source at all, so they keep relying on the text cleanup.
 * @param {any} event - raw `user/message` event.
 * @returns {boolean} true when the event may hold human input.
 */
export function isHumanUserMessage(event) {
  const source = event?.data?.source
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string') return true
  return HUMAN_SOURCE_KINDS.has(source.kind)
}

/**
 * Decide whether a cleaned user message carries content worth summarizing.
 * @param {string} text - cleaned text.
 * @returns {boolean} true when it is not small talk.
 */
export function isSubstantive(text) {
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  if (oneLine.length === 0) return false
  if (ACK_TEXTS.has(oneLine.toLowerCase())) return false
  if (oneLine.length <= 2 && !FILE_REF.test(oneLine)) return false
  return true
}

/**
 * Extract the text blocks of one message event.
 * @param {any} event - raw event.
 * @returns {string} joined text blocks.
 */
function messageText(event) {
  const content = event?.data?.content ?? event?.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Fold one session's events inside a time window into summary material.
 *
 * Only window events contribute work signals; the session title and working
 * directory are read from the whole log because they are written once at
 * session creation and still describe a session that spans several days.
 * @param {object} input
 * @param {any[]} input.events - events of one session.
 * @param {number} input.from - window start (epoch ms, inclusive).
 * @param {number} input.to - window end (epoch ms, exclusive).
 * @returns {{title: string, points: string[], assistants: string[], files: object[], todos: object|null, tools: number, waitApprovals: number, firstAt: number, lastAt: number}} folded facts.
 */
export function foldSessionForSummary({ events, from, to }) {
  let title = null
  let cwd = null
  const points = []
  const assistants = []
  const files = []
  let todos = null
  let tools = 0
  let waitApprovals = 0
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = 0
  for (const event of events) {
    const type = event?.type
    // Session identity is window-independent (see the JSDoc above).
    if (type === 'session') {
      if (typeof event.data?.cwd === 'string' && event.data.cwd !== '') cwd = event.data.cwd
      continue
    }
    if (type === 'session/title') {
      if (typeof event.data?.title === 'string' && event.data.title !== '') title = event.data.title
      continue
    }
    const time = typeof event?.time === 'number' ? event.time : undefined
    if (time === undefined || time < from || time >= to) continue
    firstAt = Math.min(firstAt, time)
    lastAt = Math.max(lastAt, time)
    switch (type) {
      case 'user/message': {
        if (!isHumanUserMessage(event)) break
        const cleaned = cleanUserText(messageText(event))
        if (!isSubstantive(cleaned)) break
        const point = truncate(cleaned, LIMITS.pointChars)
        if (points.length === 0 || points[points.length - 1] !== point) points.push(point)
        break
      }
      case 'assistant/message': {
        const text = cleanUserText(messageText(event))
        if (text.length < 8) break
        const excerpt = truncate(text, LIMITS.assistantChars)
        if (assistants.length === 0 || assistants[assistants.length - 1] !== excerpt) assistants.push(excerpt)
        break
      }
      case 'tool/call':
        tools += 1
        break
      case 'approval/asked':
        waitApprovals += 1
        break
      case 'deliverables/presented': {
        for (const file of Array.isArray(event.data?.files) ? event.data.files : []) {
          if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
          files.push({ path: file.path, description: typeof file.description === 'string' ? file.description : null })
        }
        break
      }
      case 'todo/write': {
        const items = Array.isArray(event.data?.todos) ? event.data.todos : []
        const list = items
          .filter((item) => item !== null && typeof item === 'object' && typeof item.content === 'string')
          .map((item) => ({ content: item.content, status: typeof item.status === 'string' ? item.status : 'pending' }))
        todos = {
          total: list.length,
          completed: list.filter((item) => item.status === 'completed').length,
          items: list,
        }
        break
      }
      default:
    }
  }
  return {
    title,
    cwd,
    points: points.slice(0, LIMITS.pointsPerSession),
    assistants: assistants.slice(-LIMITS.assistantsPerSession),
    files: files.slice(0, LIMITS.filesPerSession),
    todos,
    tools,
    waitApprovals,
    firstAt: Number.isFinite(firstAt) ? firstAt : from,
    lastAt,
  }
}

/**
 * Decide whether folded facts look like work rather than chat.
 * @param {ReturnType<typeof foldSessionForSummary>} folded - folded session facts.
 * @param {string[]} points - cleaned human messages.
 * @returns {boolean} true when the session has a work signal.
 */
function isWorkSession(folded, points) {
  const fileRefs = points.filter((point) => FILE_REF.test(point)).length
  const todoCount = folded.todos === null ? 0 : folded.todos.items.filter((item) => item.status !== 'completed').length
  return folded.tools > 0 || folded.files.length > 0 || todoCount > 0 || fileRefs > 0
}

/**
 * Render one session's facts as material lines.
 * @param {object} input
 * @param {object} input.folded - folded facts.
 * @param {string | null} input.cwd - session working directory.
 * @param {string} input.sessionId - session id, used when no title exists.
 * @returns {string} material text for one session.
 */
export function formatSessionMaterial({ folded, cwd, sessionId }) {
  const title = folded.title ?? (cwd === null ? sessionId.slice(0, 12) : basename(cwd))
  const folder = cwd === null ? '' : ` · 目录：${basename(cwd)}`
  const todoNote = folded.todos === null
    ? ''
    : ` · 待办 ${folded.todos.completed}/${folded.todos.total}`
  const lines = [`【${title}】${folder} · 工具×${folded.tools} · 交付 ${folded.files.length} 个${todoNote}`]
  for (const point of folded.points) lines.push(`- 我：${point}`)
  for (const excerpt of folded.assistants) lines.push(`- AI：${excerpt}`)
  if (folded.files.length > 0) {
    const names = folded.files.map((file) => {
      const name = basename(file.path)
      return file.description === null ? name : `${name}（${truncate(file.description, 60)}）`
    })
    lines.push(`- 交付：${names.join('；')}`)
  }
  if (folded.todos !== null) {
    const open = folded.todos.items.filter((item) => item.status !== 'completed').slice(0, LIMITS.todosPerSession)
    if (open.length > 0) lines.push(`- 未完成待办：${open.map((item) => item.content).join('；')}`)
  }
  return lines.join('\n')
}

/**
 * Read one time window of every session and build the summary material.
 * @param {object} input
 * @param {string} input.dshHome - DSH home directory.
 * @param {number} input.from - window start (epoch ms, inclusive).
 * @param {number} input.to - window end (epoch ms, exclusive).
 * @param {number} [input.maxChars] - material character budget.
 * @param {number} [input.maxSessions] - session budget.
 * @returns {{sessions: object[], materialText: string, messageCount: number, sessionsScanned: number}} material.
 */
export function collectSummaryMaterial({ dshHome, from, to, maxChars = 60_000, maxSessions = LIMITS.sessions }) {
  const artifacts = listSessionArtifacts(dshHome)
  const kept = []
  let messageCount = 0
  for (const artifact of artifacts) {
    // The file must have been written during the window; an old untouched session
    // cannot contain new messages.
    if (artifact.mtimeMs < from) continue
    let events
    try {
      events = []
      readZstdJsonl(readFileSync(artifact.path), (event) => {
        if (typeof event?.time === 'number' && event.time >= from && event.time < to) events.push(event)
      })
    } catch {
      continue
    }
    if (events.length === 0) continue
    const folded = foldSessionForSummary({ events, from, to })
    if (!isWorkSession(folded, folded.points)) continue
    const session = {
      sessionId: artifact.sessionId,
      title: folded.title,
      cwd: folded.cwd,
      files: folded.files.length,
      points: folded.points.length,
      tools: folded.tools,
      firstAt: folded.firstAt,
      text: formatSessionMaterial({ folded, cwd: folded.cwd, sessionId: artifact.sessionId }),
    }
    messageCount += folded.points.length
    kept.push(session)
  }

  kept.sort((left, right) => right.firstAt - left.firstAt)
  let budget = maxChars
  const selected = []
  for (const session of kept) {
    if (selected.length >= maxSessions) break
    if (session.text.length > budget) continue
    budget -= session.text.length + 2
    selected.push(session)
  }
  return {
    sessions: selected.map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      files: session.files,
      points: session.points,
      tools: session.tools,
    })),
    materialText: selected.map((session) => session.text).join('\n\n'),
    messageCount,
    sessionsScanned: kept.length,
  }
}

/**
 * Build the day window for one date key.
 * @param {string} dayKey - local date.
 * @param {string} timeZone - IANA zone.
 * @returns {{from: number, to: number, fromKey: string, toKey: string}} window.
 */
export function dayWindow(dayKey, timeZone) {
  return {
    from: startOfLocalDay(dayKey, timeZone),
    to: startOfLocalDay(addDays(dayKey, 1), timeZone),
    fromKey: dayKey,
    toKey: dayKey,
  }
}

/**
 * Build the Monday-to-Friday window containing one date key.
 * @param {string} dayKey - any date in the week.
 * @param {string} timeZone - IANA zone.
 * @returns {{from: number, to: number, fromKey: string, toKey: string}} window.
 */
export function weekWindow(dayKey, timeZone) {
  const { fromKey, toKey } = workWeekKeys(dayKey)
  return {
    from: startOfLocalDay(fromKey, timeZone),
    to: startOfLocalDay(addDays(toKey, 1), timeZone),
    fromKey,
    toKey,
  }
}
