/**
 * Generate the workbench artifacts: the standalone dashboard page and the DSH
 * plugin client bundle.
 *
 * Usage:
 *   node tools/build.mjs [--days 60] [--tz Asia/Shanghai] [--no-collect]
 *                        [--html out/dsh-workbench.html] [--payload out/workbench.json]
 *                        [--plugin-dir DIR]
 *
 * The HTML embeds the payload and the engine, so it opens offline with no
 * server, no build step, and no network. The client bundle embeds the same
 * engine so the in-GUI panel cannot drift from the page.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Script } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildClientBundle, buildEngineBundle } from './bundler.mjs'
import { collectWorkbench, resolveDshHome } from '../src/collect.mjs'

const argv = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')

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
const days = Number.parseInt(arg('--days', '60'), 10)
const timeZone = arg('--tz', Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
const htmlOut = arg('--html', join(dshHome, 'workbench', 'out', 'dsh-workbench.html'))
const payloadOut = arg('--payload', join(dshHome, 'workbench', 'out', 'workbench.json'))
const pluginDir = arg('--plugin-dir', join(dshHome, 'workbench', 'plugin'))

let payload
if (argv.includes('--no-collect')) {
  payload = JSON.parse(readFileSync(payloadOut, 'utf8'))
} else {
  const collected = await collectWorkbench({ dshHome, timeZone, days })
  payload = collected.payload
  mkdirSync(dirname(payloadOut), { recursive: true })
  writeFileSync(payloadOut, JSON.stringify(payload))
}

/**
 * Fail the build when a generated script does not parse.
 *
 * The browser half of the plugin ships as a pre-built bundle, so a syntax error
 * in the sources only surfaces when the host page tries to import it — reported
 * as a bare "import failed". Compiling here turns that into a build failure.
 * @param {string} code - generated script text.
 * @param {string} label - artifact name for the error message.
 */
function assertParses(code, label) {
  try {
    new Script(code, { filename: label })
  } catch (error) {
    throw new Error(`${label} 生成结果无法解析: ${error.message}\n先修源码，再重新构建。`)
  }
}

const engine = buildEngineBundle()
assertParses(engine.body, '引擎 bundle')
// `\r?` because a Windows checkout with core.autocrlf hands us CRLF line endings,
// and the extraction below anchors on the newline after the template literal.
const css = new RegExp('const WORKBENCH_CSS = `([\\s\\S]*?)`\\r?\\n').exec(engine.body)
if (css === null) throw new Error('WORKBENCH_CSS not found in the bundled engine')
const embeddedJson = JSON.stringify(payload).replace(/</g, '\\u003c')

// The plugin package must be self-contained, so refresh its copy of the shared
// modules from src/ (the client bundle embeds them separately). The plugin host
// imports `collection.mjs`, a thin alias of the collector.
mkdirSync(join(pluginDir, 'lib', 'shared'), { recursive: true })
for (const file of ['zstd-frames.mjs', 'session-calls.mjs', 'workbench-data.mjs', 'collect.mjs', 'active-state.mjs']) {
  writeFileSync(join(pluginDir, 'lib', 'shared', file), readFileSync(join(projectRoot, 'src', file), 'utf8'))
}
writeFileSync(
  join(pluginDir, 'lib', 'shared', 'collection.mjs'),
  readFileSync(join(pluginDir, 'lib', 'shared', 'collect.mjs')),
)

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 工作台 · 语言模型调用趋势与热力图</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; background: #ffffff; }
@media (prefers-color-scheme: dark) { body { background: #16181d; } }
.wb-page-head { max-width: 1180px; margin: 0 auto; padding: 18px 20px 0; display: flex; align-items: baseline; gap: 12px; color: #6b7280; font: 12px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
#wb-app { max-width: 1180px; margin: 0 auto; }
${css[1]}
</style>
</head>
<body>
<div class="wb-page-head"><strong>DSH 工作台</strong><span id="wb-stamp"></span></div>
<div id="wb-app" class="wb-root"></div>
<script type="application/json" id="wb-payload">${embeddedJson}</script>
<script>
(function () {
  'use strict';
  var app = document.getElementById('wb-app');
  var payload;
  try {
    payload = JSON.parse(document.getElementById('wb-payload').textContent);
  } catch (error) {
    app.textContent = '载荷解析失败: ' + error.message;
    return;
  }
  var ENGINE = (function () {
${engine.body.replace(/^/gm, '    ')}
    return { renderWorkbench: renderWorkbench, renderActiveSection: renderActiveSection };
  })();
  ENGINE.renderWorkbench(app, payload, {});
  var stamp = document.getElementById('wb-stamp');
  stamp.textContent = '数据生成于 ' + new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(payload.generatedAt)) + ' · 时区 ' + payload.timeZone;
})();
</script>
</body>
</html>
`

mkdirSync(dirname(htmlOut), { recursive: true })
writeFileSync(htmlOut, html)

const clientTemplate = readFileSync(join(projectRoot, 'src', 'client-panel.js'), 'utf8')
const clientSource = clientTemplate.replace('__WB_CSS__', 'WB_ENGINE.WORKBENCH_CSS')
mkdirSync(join(pluginDir, 'lib', 'client'), { recursive: true })
const clientBundle = buildClientBundle(clientSource)
assertParses(clientBundle, '客户端插件 bundle')
writeFileSync(join(pluginDir, 'lib', 'client', 'index.js'), clientBundle)

console.log(`独立仪表盘 → ${htmlOut}（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB，内嵌 ${payload.totals.calls} 次调用）`)
console.log(`客户端插件包 → ${join(pluginDir, 'lib', 'client', 'index.js')}`)
