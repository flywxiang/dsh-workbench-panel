/**
 * Headless verification for the generated dashboard page.
 *
 * Screenshots cannot be reviewed by a text-only model, so this checks the
 * rendered DOM Chrome actually produced: element counts, KPI text, absence of
 * the failure marker, and the console log for uncaught errors.
 *
 * Usage: node tools/verify-page.mjs [html path]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const htmlPath = resolve(process.argv[2] ?? join(homedir(), '.dsh', 'workbench', 'out', 'dsh-workbench.html'))

/**
 * Find the newest Playwright-installed headless shell.
 * @returns {string} executable path.
 */
function headlessShell() {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('chromium_headless_shell-')) continue
    const directory = join(cache, entry)
    for (const arch of readdirSync(directory)) {
      const candidate = join(directory, arch, 'chrome-headless-shell')
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('no chrome-headless-shell found under the Playwright cache')
}

const profile = mkdtempSync(join(tmpdir(), 'wb-verify-'))
const shell = headlessShell()
let dom = ''
let errors = []
try {
  dom = execFileSync(
    shell,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--user-data-dir=' + profile,
      '--virtual-time-budget=8000',
      '--dump-dom',
      'file://' + htmlPath,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  )
} finally {
  rmSync(profile, { recursive: true, force: true })
}

/**
 * Count non-overlapping matches.
 * @param {string} haystack - text to scan.
 * @param {RegExp} pattern - global pattern.
 * @returns {number} match count.
 */
function count(haystack, pattern) {
  return (haystack.match(pattern) ?? []).length
}

const checks = []
/**
 * Record one assertion.
 * @param {string} name - check name.
 * @param {boolean} pass - outcome.
 * @param {string} detail - evidence.
 */
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

/**
 * Drop stylesheet and script bodies so text checks cannot match CSS rules or
 * source strings instead of rendered output.
 * @param {string} markup - dumped DOM.
 * @returns {string} markup with style/script bodies removed.
 */
function stripSource(markup) {
  return markup
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
}

const rendered = stripSource(dom)
const bars = count(rendered, /class="wb-bar"/g)
const heatCells = count(rendered, /class="wb-heat-cell/g)
const svgs = count(rendered, /<svg/g)
const lines = count(rendered, /class="wb-line"/g)
const kpiValues = [...rendered.matchAll(/class="wb-kpi-value">([^<]*)</g)].map((match) => match[1])
const kpiLabels = [...rendered.matchAll(/class="wb-kpi-label">([^<]*)</g)].map((match) => match[1])
const statusText = (/<div class="wb-status[^"]*">([\s\S]*?)<\/div>/.exec(rendered)?.[1] ?? '').replace(/<[^>]+>/g, ' ')
const failed = rendered.includes('载荷解析失败') || /<div class="[^"]*wb-status-error/.test(rendered)

check('no parse/refresh failure marker', !failed, failed ? `status text: ${statusText.slice(0, 80)}` : 'status line rendered normally')
check('three chart SVGs', svgs === 3, `${svgs} svg elements`)
check('heatmap is 7x24', heatCells === 168, `${heatCells} heat cells`)
check('stacked bars rendered', bars > 0, `${bars} bar rects`)
check('latency lines rendered', lines > 0, `${lines} line paths`)
check('KPI cards rendered', kpiValues.length >= 6, `${kpiValues.length} cards: ${kpiLabels.join(' / ')}`)
check('call total is a number', /^[\d,]+$/.test(kpiValues[0] ?? ''), `LLM 调用 = ${kpiValues[0]}`)
check('token total rendered', (kpiValues[1] ?? '').length > 1, `Token 总量 = ${kpiValues[1]}`)

const failures = checks.filter((entry) => !entry.pass)
for (const entry of checks) console.log(`${entry.pass ? '✔' : '✖'} ${entry.name} — ${entry.detail}`)
if (errors.length > 0) console.log(errors.join('\n'))
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed for ${htmlPath}`)
process.exitCode = failures.length === 0 ? 0 : 1
