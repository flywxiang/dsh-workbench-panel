/**
 * Reduce one DSH session log to the language-model call records the workbench
 * charts, plus the recent-window facts the insights block needs (titles,
 * deliverables, todos, context-window usage, and whether the session is waiting
 * on the user).
 *
 * A "call" is one model invocation by one agent step. The agent loop appends
 * `step/start` when a step begins, publishes the served route through
 * `request/context` only when that route changes (so it inherits forward),
 * streams the answer as `assistant/chunk` records, assembles the reply into an
 * `assistant/message`, and closes the step with `step/end`. Token usage arrives
 * as a `usage` chunk inside `assistant/chunk`.
 *
 * Timing discipline: `step/start` to `step/end` spans the model call *and* every
 * tool the step ran, so it is not model time. The model-response figure is
 * `step/start` to the step's first `assistant/message`; the step span is carried
 * separately as `stepDurationMs`. Retry waits (rate limits, transport backoff)
 * are subtracted from the response figure, because that wall time sits between
 * retries rather than inside a served model call.
 *
 * Only language-model work is counted as a call: tool calls and results,
 * todo/approval traffic, and every other non-model event are ignored because
 * they never open a step. Auxiliary model work — session titling and the
 * web-search helper — runs outside any step and is classified `auxiliary` with
 * an `auxKind`, so the UI can exclude or separate it.
 *
 * Insight fields are side products of the same pass:
 *   - `title` / `lastEventAt` for naming sessions in lists;
 *   - `deliverables` from `deliverables/presented`;
 *   - `todos` from the last `todo/write`;
 *   - `models` and `tokens` so cost can be attributed per session;
 *   - `context` from the latest usage plus the request's `maxTokens`;
 *   - `waiting` when an open turn is blocked on an approval or a question.
 */
import { maskText } from './redact.mjs'

/** Classify auxiliary (outside-step) model events. */
const AUXILIARY_KINDS = new Map([
  ['session/title-llm-request', 'session-title'],
  ['web/deepseek-search-llm-request', 'web-search'],
])

/** Tool names whose pending call means the session is waiting for the user. */
const WAITING_TOOLS = new Set(['ask_user_question'])

/**
 * Read the served route out of an auxiliary request event.
 * @param {any} event - auxiliary request event.
 * @returns {{provider: string, model: string}} route with `?` fallbacks.
 */
function auxiliaryRoute(event) {
  const body = event?.data?.body
  const route = event?.data?.route
  const provider = body?.provider ?? route?.provider ?? event?.data?.provider ?? '?'
  const model = body?.model ?? route?.model ?? event?.data?.model ?? '?'
  return { provider: String(provider), model: String(model) }
}

/**
 * Fold the language-model-call subset (and insight facts) out of one session's
 * raw event log.
 *
 * @param {object} input
 * @param {string} input.sessionId - logical session id.
 * @param {string | undefined} input.cwd - session working directory.
 * @param {number | undefined} input.createdAt - header creation time (epoch ms).
 * @param {readonly any[]} input.events - contiguous raw events, ascending seq.
 * @returns {{calls: object[], session: object}} call records plus session facts.
 */
export function extractSessionCalls({ sessionId, cwd, createdAt, events }) {
  /** @type {object[]} */
  const calls = []
  /** Route inherited by steps until the next `request/context`. */
  let route = { provider: '?', model: '?' }
  /** Open step accumulator, or undefined outside a step. */
  let step
  /** Latest `usage` chunk of the open step. */
  let usage

  // --- insight-side accumulators ---
  let title = null
  let lastEventAt = null
  let turnOpen = false
  let maxTokens = null
  let context = null
  let todoList = null
  /** @type {Map<string, object>} */
  const pendingApprovals = new Map()
  /** @type {Map<string, object>} */
  const pendingTools = new Map()
  /** @type {object[]} */
  const deliverables = []
  /** @type {Map<string, object>} */
  const sessionModels = new Map()
  const sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  const closeStep = (endTime) => {
    if (step === undefined) return
    const firstMessage = step.firstMessageTime
    const responseEnd = firstMessage ?? endTime
    const responseMs = responseEnd === undefined ? null : Math.max(0, responseEnd - step.startTime - step.retryWaitMs)
    calls.push({
      sessionId,
      kind: 'conversation',
      provider: step.provider,
      model: step.model,
      turn: step.turn,
      step: step.step,
      startTime: step.startTime,
      endTime: endTime ?? null,
      responseMs,
      stepDurationMs: endTime === undefined ? null : Math.max(0, endTime - step.startTime),
      ttftMs: step.ttftTime === undefined ? null : Math.max(0, step.ttftTime - step.startTime),
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      retries: step.retries,
      retryWaitMs: step.retryWaitMs,
      emitsMessage: step.emitsMessage,
      hasUsage: usage !== undefined && usage !== null,
    })
    // Attribute tokens to the served model, so the insights block can price each
    // session without re-reading the log.
    const key = `${step.provider}/${step.model}`
    const bucket = sessionModels.get(key) ?? {
      provider: step.provider,
      model: step.model,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }
    bucket.calls += 1
    bucket.input += usage?.inputTokens ?? 0
    bucket.output += usage?.outputTokens ?? 0
    bucket.cacheRead += usage?.cacheReadTokens ?? 0
    bucket.cacheWrite += usage?.cacheWriteTokens ?? 0
    sessionModels.set(key, bucket)
    sessionTokens.input += usage?.inputTokens ?? 0
    sessionTokens.output += usage?.outputTokens ?? 0
    sessionTokens.cacheRead += usage?.cacheReadTokens ?? 0
    sessionTokens.cacheWrite += usage?.cacheWriteTokens ?? 0
    step = undefined
    usage = undefined
  }

  for (const event of events) {
    const type = event?.type
    const time = typeof event?.time === 'number' ? event.time : undefined
    const data = event?.data ?? {}

    if (time !== undefined && (lastEventAt === null || time > lastEventAt)) lastEventAt = time

    // Insight-only events: they never affect the call accounting.
    switch (type) {
      case 'session/title':
        if (typeof data.title === 'string' && data.title !== '') title = data.title
        break
      case 'request/header': {
        const config = data.header?.config ?? data.config ?? {}
        if (Number.isFinite(config.maxTokens)) maxTokens = config.maxTokens
        if (config.provider !== undefined && config.model !== undefined) {
          route = { provider: String(config.provider), model: String(config.model) }
        }
        break
      }
      case 'turn/start':
        turnOpen = true
        pendingApprovals.clear()
        pendingTools.clear()
        break
      case 'turn/end':
        turnOpen = false
        pendingApprovals.clear()
        pendingTools.clear()
        break
      case 'approval/asked':
        if (typeof data.id === 'string') {
          pendingApprovals.set(data.id, {
            id: data.id,
            toolName: typeof data.toolName === 'string' ? data.toolName : null,
            reason: typeof data.reason === 'string' ? data.reason : null,
            askedAt: time ?? 0,
          })
        }
        break
      case 'approval/decided':
        if (typeof data.id === 'string') pendingApprovals.delete(data.id)
        break
      case 'deliverables/presented':
        for (const file of Array.isArray(data.files) ? data.files : []) {
          if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
          deliverables.push({
            path: file.path,
            description: typeof file.description === 'string' ? file.description : null,
            at: time ?? 0,
          })
        }
        break
      case 'todo/write': {
        const items = Array.isArray(data.todos)
          ? data.todos
              .filter((item) => item !== null && typeof item === 'object' && typeof item.content === 'string')
              .map((item) => ({ content: item.content, status: typeof item.status === 'string' ? item.status : 'pending' }))
          : []
        todoList = {
          total: items.length,
          completed: items.filter((item) => item.status === 'completed').length,
          items,
        }
        break
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.toolCallId ?? data.callId
        if (typeof callId === 'string') pendingTools.delete(callId)
        break
      }
      default:
    }

    if (type === 'step/start') {
      closeStep(step?.lastActivity)
      step = {
        turn: data.turn ?? null,
        step: data.step ?? null,
        startTime: time ?? 0,
        lastActivity: time,
        provider: route.provider,
        model: route.model,
        retries: 0,
        retryWaitMs: 0,
        emitsMessage: false,
        firstMessageTime: undefined,
        ttftTime: undefined,
      }
      continue
    }

    if (type === 'step/end') {
      closeStep(time)
      continue
    }

    if (type === 'request/context') {
      route = {
        provider: String(data.provider ?? route.provider),
        model: String(data.model ?? route.model),
      }
      if (step !== undefined) {
        step.provider = route.provider
        step.model = route.model
      }
      continue
    }

    if (step === undefined) {
      const kind = AUXILIARY_KINDS.get(type)
      if (kind !== undefined) {
        const auxRoute = auxiliaryRoute(event)
        calls.push({
          sessionId,
          kind: 'auxiliary',
          auxKind: kind,
          provider: auxRoute.provider,
          model: auxRoute.model,
          turn: null,
          step: null,
          startTime: time ?? 0,
          endTime: null,
          responseMs: null,
          stepDurationMs: null,
          ttftMs: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          reasoningTokens: null,
          retries: 0,
          retryWaitMs: 0,
          emitsMessage: false,
          hasUsage: false,
        })
      }
      continue
    }

    if (time !== undefined) step.lastActivity = time

    if (type === 'assistant/chunk') {
      const chunk = data.chunk
      if (chunk?.type === 'usage') {
        usage = chunk.usage ?? null
      } else if (step.ttftTime === undefined && typeof chunk?.type === 'string' && chunk.type.endsWith('-delta')) {
        // First streamed content of the step: text, reasoning, or a tool call.
        step.ttftTime = time
      }
      continue
    }

    if (type === 'assistant/message') {
      step.emitsMessage = true
      if (step.firstMessageTime === undefined) step.firstMessageTime = time
      const served = data.message?.source
      const contextProvider = served?.provider ?? step.provider
      const contextModel = served?.model ?? step.model
      const messageUsage = data.usage
      // Real logs deliver usage as a `usage` chunk; some writers only attach it
      // to the assembled message, so fall back to that copy for the step totals.
      if ((usage === null || usage === undefined) && messageUsage !== null && typeof messageUsage === 'object') {
        usage = messageUsage
      }
      if (messageUsage !== null && typeof messageUsage === 'object') {
        // Context-window usage: the prompt side of the call (uncached + cached +
        // cache writes) compared against the request's maxTokens.
        context = {
          inputTokens: messageUsage.inputTokens ?? 0,
          cacheReadTokens: messageUsage.cacheReadTokens ?? 0,
          cacheWriteTokens: messageUsage.cacheWriteTokens ?? 0,
          maxTokens,
          model: typeof contextModel === 'string' ? `${contextProvider}/${contextModel}` : null,
          at: time ?? lastEventAt ?? 0,
        }
      }
      continue
    }

    if (type === 'llm/retry') {
      step.retries += 1
      const delay = data.delayMs
      if (typeof delay === 'number' && delay > 0) step.retryWaitMs += delay
      continue
    }

    if (type === 'tool/call') {
      if (typeof data.callId === 'string') {
        pendingTools.set(data.callId, {
          callId: data.callId,
          name: typeof data.name === 'string' ? data.name : '?',
          at: time ?? 0,
        })
      }
      continue
    }
  }

  closeStep(step?.lastActivity)

  // Waiting only counts while the turn is still open: a closed turn means the
  // user answered, declined, or the session was abandoned.
  let waiting = null
  if (turnOpen) {
    const approvals = [...pendingApprovals.values()].sort((left, right) => left.askedAt - right.askedAt)
    if (approvals.length > 0) {
      const pending = approvals[0]
      waiting = {
        kind: 'approval',
        toolName: pending.toolName,
        reason: pending.reason === null ? null : maskText(pending.reason, 80),
        since: pending.askedAt,
      }
    } else {
      const question = [...pendingTools.values()]
        .filter((tool) => WAITING_TOOLS.has(tool.name))
        .sort((left, right) => left.at - right.at)[0]
      if (question !== undefined) {
        waiting = { kind: 'answer', toolName: question.name, reason: null, since: question.at }
      }
    }
  }

  return {
    calls,
    session: {
      id: sessionId,
      cwd: cwd ?? null,
      createdAt: createdAt ?? null,
      callCount: calls.length,
      title,
      lastEventAt,
      tokens: sessionTokens,
      models: [...sessionModels.values()],
      deliverables,
      todos: todoList,
      context,
      waiting,
    },
  }
}
