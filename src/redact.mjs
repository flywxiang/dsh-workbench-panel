/**
 * Redaction helpers shared by the live tracker and the insights aggregator.
 *
 * Session logs contain raw tool arguments, which can include API tokens, database
 * URLs, passwords, or SQL text. Anything derived from those fields must pass
 * through these helpers before it can reach the browser, even when a preview
 * switch is on: masking is a server-side guarantee, not a CSS trick.
 */

/** Shapes that must never survive into the payload. */
const SECRET_PATTERNS = [
  [/github_pat_[A-Za-z0-9_]{10,}/g, 'github_pat_***'],
  [/gh[pousr]_[A-Za-z0-9_]{10,}/g, 'gh*_***'],
  [/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***'],
  [/AKIA[0-9A-Z]{12,}/g, 'AKIA***'],
  [/\b[A-Za-z0-9_+/=-]{40,}\b/g, '***'],
]

/**
 * Collapse whitespace and cut text to a display length.
 * @param {string} text - input text.
 * @param {number} max - maximum length.
 * @returns {string} one-line, truncated text.
 */
export function truncate(text, max) {
  const oneLine = String(text).replace(/\s+/gu, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Replace credential-shaped substrings, then truncate.
 * @param {string} text - raw text.
 * @param {number} [max] - maximum output length.
 * @returns {string} masked text.
 */
export function maskText(text, max = 60) {
  let masked = String(text)
  for (const [pattern, replacement] of SECRET_PATTERNS) masked = masked.replace(pattern, replacement)
  return truncate(masked, max)
}

/**
 * Mask a file path for display: keep the basename only.
 * @param {string} path - raw path.
 * @returns {string} basename-ish display text.
 */
export function maskPathName(path) {
  const text = String(path)
  const parts = text.split(/[\\/]/u).filter((part) => part !== '')
  return maskText(parts.length === 0 ? text : parts[parts.length - 1], 80)
}
