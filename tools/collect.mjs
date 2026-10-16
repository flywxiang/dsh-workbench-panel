/**
 * Collect the workbench payload and write it as JSON.
 *
 * Usage:
 *   node tools/collect.mjs [--days 30] [--tz Asia/Shanghai] [--out path.json]
 *                          [--no-cache] [--quiet]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { collectWorkbench, resolveDshHome } from '../src/collect.mjs'

const argv = process.argv.slice(2)

/**
 * Read a `--flag value` argument.
 * @param {string} flag - flag name including dashes.
 * @param {string} [fallback] - value when absent.
 * @returns {string | undefined} the flag value.
 */
function arg(flag, fallback) {
  const index = argv.indexOf(flag)
  if (index === -1) return fallback
  return argv[index + 1] ?? fallback
}

const dshHome = resolveDshHome()
const days = Number.parseInt(arg('--days', '30'), 10)
const timeZone = arg('--tz', Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
const out = arg('--out', join(dshHome, 'workbench', 'out', 'workbench.json'))
const quiet = argv.includes('--quiet')

const { payload, stats } = await collectWorkbench({
  dshHome,
  timeZone,
  days,
  useCache: !argv.includes('--no-cache'),
})

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(payload))

if (!quiet) {
  const { totals, usage, coverage, scan } = payload
  console.log(`工作台数据 → ${out}`)
  console.log(`  会话 ${scan.sessions}/${scan.artifacts}（新解析 ${stats.parsedSessions}，缓存命中 ${stats.cachedSessions}）`)
  console.log(`  语言模型调用 ${totals.calls} 次，跨 ${totals.activeDays} 天，模型 ${totals.models} 个，耗时 ${(stats.parseMs / 1000).toFixed(2)}s`)
  console.log(`  Token: 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} / 缓存读 ${usage.cacheReadTokens} / 推理 ${usage.reasoningTokens}`)
  console.log(`  数据覆盖: usage ${(coverage.usage * 100).toFixed(1)}% / 首字 ${(coverage.ttft * 100).toFixed(1)}% / 响应时长 ${(coverage.response * 100).toFixed(1)}%`)
  if (stats.failures > 0) console.warn(`  解析失败 ${stats.failures} 个会话: ${JSON.stringify(stats.failuresDetail)}`)
}
