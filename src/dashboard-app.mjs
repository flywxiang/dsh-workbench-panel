/**
 * Standalone dashboard entry point, inlined by `tools/build.mjs` into the
 * generated HTML. Expects `window.__WB_PAYLOAD__` and a `#wb-app` host.
 *
 * Kept as ESM source with one regular import so the shared bundler can inline
 * it verbatim; the import line is dropped after concatenation.
 */
import { renderWorkbench } from './workbench-render.mjs'

const host = document.getElementById('wb-app')
const payload = window.__WB_PAYLOAD__

if (host === null || payload === null) {
  document.body.textContent = '工作台数据缺失：请先运行 node tools/build.mjs 重新生成页面。'
} else {
  renderWorkbench(host, payload, {})
  const stamp = document.getElementById('wb-stamp')
  if (stamp !== null) {
    stamp.textContent = `生成于 ${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(payload.generatedAt))}`
  }
}
