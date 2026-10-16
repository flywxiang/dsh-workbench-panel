/**
 * Census + benchmark over the local DSH session corpus.
 *
 * Reads every session artifact under $DSH_HOME/sessions, folds it through the
 * language-model-call extractor, and reports corpus shape, per-model coverage,
 * data-quality gaps, and wall-clock cost. Run it before trusting the charts.
 *
 * Usage: node tools/census.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readZstdJsonl } from '../src/zstd-frames.mjs'
import { extractSessionCalls } from '../src/session-calls.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const asJson = process.argv.includes('--json')

/**
 * List every session artifact under the sessions root.
 * @returns {{workspace: string, sessionId: string, path: string, size: number}[]}
 */
function listArtifacts() {
  const out = []
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    const workspaceDir = join(SESSIONS_ROOT, workspace)
    if (!statSync(workspaceDir).isDirectory()) continue
    for (const sessionId of readdirSync(workspaceDir)) {
      const sessionDir = join(workspaceDir, sessionId)
      if (!statSync(sessionDir).isDirectory()) continue
      for (const file of readdirSync(sessionDir)) {
        if (!/^session.*\.jsonl(\.zstd)?$/.test(file)) continue
        const path = join(sessionDir, file)
        out.push({ workspace, sessionId, path, size: statSync(path).size })
      }
    }
  }
  return out
}

const started = Date.now()
const artifacts = listArtifacts()
const allCalls = []
const perSession = []
let decodeFailures = 0
let tornFrames = 0

for (const artifact of artifacts) {
  try {
    const events = []
    const accounting = readZstdJsonl(readFileSync(artifact.path), (event) => events.push(event))
    if (accounting.truncated) tornFrames += 1
    const header = events.find((event) => event?.type === 'session')
    const { calls, session } = extractSessionCalls({
      sessionId: artifact.sessionId,
      cwd: header?.cwd,
      createdAt: header?.createdAt,
      events,
    })
    allCalls.push(...calls)
    perSession.push({
      ...session,
      bytes: artifact.size,
      events: events.length,
      frames: accounting.frames,
      calls: calls.length,
      workspace: artifact.workspace,
    })
  } catch (error) {
    decodeFailures += 1
    perSession.push({ id: artifact.sessionId, error: String(error?.message ?? error), bytes: artifact.size })
  }
}
const decodeMs = Date.now() - started

const conversation = allCalls.filter((call) => call.kind === 'conversation')
const auxiliary = allCalls.filter((call) => call.kind === 'auxiliary')
const byModel = new Map()
const byDay = new Map()
for (const call of conversation) {
  const key = `${call.provider}/${call.model}`
  byModel.set(key, (byModel.get(key) ?? 0) + 1)
  if (call.startTime) {
    const day = new Date(call.startTime).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
}

const withUsage = conversation.filter((call) => call.hasUsage).length
const withTtft = conversation.filter((call) => call.ttftMs !== null).length
const withDuration = conversation.filter((call) => call.durationMs !== null).length
const withMessage = conversation.filter((call) => call.emitsMessage).length
const zeroDuration = conversation.filter((call) => call.durationMs === 0).length

const report = {
  dshHome: DSH_HOME,
  artifacts: artifacts.length,
  totalBytes: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
  decodeFailures,
  tornFrames,
  decodeMs,
  calls: {
    total: allCalls.length,
    conversation: conversation.length,
    auxiliary: auxiliary.length,
    auxiliaryKinds: auxiliary.reduce((acc, call) => {
      acc[call.auxKind] = (acc[call.auxKind] ?? 0) + 1
      return acc
    }, {}),
  },
  quality: {
    withUsage,
    usageCoverage: +((withUsage / Math.max(conversation.length, 1)) * 100).toFixed(1),
    withTtft,
    ttftCoverage: +((withTtft / Math.max(conversation.length, 1)) * 100).toFixed(1),
    withDuration,
    withMessage,
    zeroDuration,
  },
  models: [...byModel.entries()].sort((a, b) => b[1] - a[1]),
  days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  sessionsWithoutCalls: perSession.filter((session) => !session.error && session.calls === 0).length,
}

if (asJson) {
  console.log(JSON.stringify({ ...report, perSession }, null, 2))
} else {
  console.log(JSON.stringify(report, null, 2))
}
