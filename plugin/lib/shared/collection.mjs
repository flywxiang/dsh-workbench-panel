/**
 * Collect every DSH session log into the workbench payload, with a per-session
 * parse cache so a re-collect only re-reads logs whose bytes changed.
 *
 * Cache key: artifact path -> { size, mtimeMs, digest }. `digest` is a cheap
 * content fingerprint (length + first/last bytes) so an append that keeps the
 * same size still invalidates.
 *
 * Imports are Node built-ins only, so this module is equally usable from the
 * standalone dashboard build and from the host plugin.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readZstdJsonl } from './zstd-frames.mjs'
import { extractSessionCalls } from './session-calls.mjs'
import { buildWorkbenchPayload } from './workbench-data.mjs'

/** Session artifacts match the persistence backend's naming for both formats. */
const ARTIFACT_PATTERN = /^session.*\.jsonl(\.zstd)?$/

/**
 * Resolve the DSH home directory.
 * @returns {string} absolute path.
 */
export function resolveDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Enumerate session artifacts under a DSH home.
 * @param {string} dshHome - DSH home directory.
 * @returns {{sessionId: string, workspace: string, path: string, size: number, mtimeMs: number}[]}
 */
export function listSessionArtifacts(dshHome) {
  const root = join(dshHome, 'sessions')
  const out = []
  let workspaces
  try {
    workspaces = readdirSync(root)
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace)
    if (!statSafe(workspaceDir)?.isDirectory()) continue
    for (const sessionId of readdirSync(workspaceDir)) {
      const sessionDir = join(workspaceDir, sessionId)
      if (!statSafe(sessionDir)?.isDirectory()) continue
      for (const file of readdirSync(sessionDir)) {
        if (!ARTIFACT_PATTERN.test(file)) continue
        const path = join(sessionDir, file)
        const stat = statSafe(path)
        if (stat === undefined || !stat.isFile()) continue
        out.push({ sessionId, workspace, path, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }
  return out.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/**
 * Stat a path without throwing.
 * @param {string} path - filesystem path.
 * @returns {import('node:fs').Stats | undefined}
 */
function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * Build a cheap content fingerprint for cache invalidation.
 * @param {Buffer} buffer - artifact bytes.
 * @returns {string} fingerprint.
 */
function digestOf(buffer) {
  const head = buffer.subarray(0, 32).toString('hex')
  const tail = buffer.subarray(Math.max(0, buffer.length - 32)).toString('hex')
  return `${buffer.length}:${head}:${tail}`
}

/**
 * Load the parse cache from disk.
 * @param {string} cachePath - cache file path.
 * @returns {{version: number, sessions: Record<string, object>}}
 */
function loadCache(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (parsed?.version === 1 && parsed.sessions !== null && typeof parsed.sessions === 'object') return parsed
  } catch {
    // A missing or unreadable cache is a cold start, never a failure.
  }
  return { version: 1, sessions: {} }
}

/**
 * Persist the parse cache atomically.
 * @param {string} cachePath - cache file path.
 * @param {object} cache - cache document.
 */
function saveCache(cachePath, cache) {
  mkdirSync(dirname(cachePath), { recursive: true })
  const temporary = `${cachePath}.tmp`
  writeFileSync(temporary, JSON.stringify(cache))
  renameSync(temporary, cachePath)
}

/**
 * Collect the workbench payload over every session artifact.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - DSH home directory.
 * @param {string} [options.timeZone] - IANA zone for calendar buckets.
 * @param {number} [options.days] - trailing day window; 0 means all days.
 * @param {boolean} [options.useCache] - reuse and refresh the parse cache.
 * @param {string} [options.cachePath] - cache file location.
 * @param {number} [options.now] - reference instant.
 * @returns {Promise<{payload: object, stats: object}>} payload plus collection accounting.
 */
export async function collectWorkbench(options = {}) {
  const dshHome = options.dshHome ?? resolveDshHome()
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  const cachePath = options.cachePath ?? join(dshHome, 'workbench', 'cache', 'sessions.json')
  const useCache = options.useCache !== false
  const startedAt = Date.now()
  const cache = useCache ? loadCache(cachePath) : { version: 1, sessions: {} }
  const nextCache = { version: 1, sessions: {} }
  const artifacts = listSessionArtifacts(dshHome)
  const sessions = []
  const calls = []
  let failures = 0
  let tornFrames = 0
  let parsedSessions = 0
  let cachedSessions = 0
  const failureList = []

  for (const artifact of artifacts) {
    const entry = cache.sessions[artifact.path]
    if (
      entry !== undefined &&
      entry.size === artifact.size &&
      entry.mtimeMs === artifact.mtimeMs &&
      typeof entry.digest === 'string'
    ) {
      nextCache.sessions[artifact.path] = entry
      calls.push(...entry.calls)
      sessions.push(entry.session)
      cachedSessions += 1
      continue
    }
    try {
      const buffer = readFileSync(artifact.path)
      const digest = digestOf(buffer)
      const events = []
      const accounting = readZstdJsonl(buffer, (event) => events.push(event))
      if (accounting.truncated) tornFrames += 1
      const header = events.find((event) => event?.type === 'session')
      const extracted = extractSessionCalls({
        sessionId: artifact.sessionId,
        cwd: header?.cwd,
        createdAt: header?.createdAt,
        events,
      })
      const record = {
        size: artifact.size,
        mtimeMs: artifact.mtimeMs,
        digest,
        calls: extracted.calls,
        session: {
          ...extracted.session,
          workspace: artifact.workspace,
          artifact: artifact.path,
          events: events.length,
          frames: accounting.frames,
          bytes: artifact.size,
        },
      }
      nextCache.sessions[artifact.path] = record
      calls.push(...extracted.calls)
      sessions.push(record.session)
      parsedSessions += 1
    } catch (error) {
      failures += 1
      failureList.push({ path: artifact.path, message: String(error?.message ?? error) })
    }
  }

  const parseMs = Date.now() - startedAt
  const deterministicMetadata = artifacts.length === Object.keys(cache.sessions).length
  if (useCache && (parsedSessions > 0 || failures > 0 || !deterministicMetadata)) {
    saveCache(cachePath, nextCache)
  }

  const payload = buildWorkbenchPayload({
    calls,
    sessions,
    scan: {
      artifacts: artifacts.length,
      sessions: sessions.length,
      bytes: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
      decodeMs: parseMs,
      failures,
      tornFrames,
    },
    timeZone,
    days: options.days ?? 30,
    now: options.now ?? Date.now(),
  })

  return {
    payload,
    stats: {
      artifacts: artifacts.length,
      parsedSessions,
      cachedSessions,
      failures,
      tornFrames,
      parseMs,
      cachePath: useCache ? cachePath : null,
      failuresDetail: failureList,
    },
  }
}
