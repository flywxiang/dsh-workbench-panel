/**
 * Reduce one DSH session log to the language-model call records the workbench
 * charts.
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
 * Only language-model work is counted: tool calls and results, todo/approval
 * traffic, and every other non-model event are ignored because they never open a
 * step. Auxiliary model work — session titling and the web-search helper — runs
 * outside any step and is classified `auxiliary` with an `auxKind`, so the UI can
 * exclude or separate it.
 */

/** Classify auxiliary (outside-step) model events. */
const AUXILIARY_KINDS = new Map([
  ['session/title-llm-request', 'session-title'],
  ['web/deepseek-search-llm-request', 'web-search'],
])

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
 * Fold the language-model-call subset out of one session's raw event log.
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
    step = undefined
    usage = undefined
  }

  for (const event of events) {
    const type = event?.type
    const time = typeof event?.time === 'number' ? event.time : undefined

    if (type === 'step/start') {
      closeStep(step?.lastActivity)
      step = {
        turn: event.data?.turn ?? null,
        step: event.data?.step ?? null,
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
        provider: String(event.data?.provider ?? route.provider),
        model: String(event.data?.model ?? route.model),
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
      const chunk = event.data?.chunk
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
      continue
    }

    if (type === 'llm/retry') {
      step.retries += 1
      const delay = event.data?.delayMs
      if (typeof delay === 'number' && delay > 0) step.retryWaitMs += delay
      continue
    }
  }

  closeStep(step?.lastActivity)

  return {
    calls,
    session: {
      id: sessionId,
      cwd: cwd ?? null,
      createdAt: createdAt ?? null,
      callCount: calls.length,
    },
  }
}
