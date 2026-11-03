/**
 * Render a picture of the 工作总结 tab from the built dashboard page.
 *
 * The real tab needs the running host to write summaries, so a preview is made
 * by injecting an example `summaries` block into the built page's embedded
 * payload, clicking the tab, and screenshotting it with a headless Chrome.
 *
 * Usage: node tools/preview-summaries.mjs [--html <built page>] [--png <output>]
 *
 * The picture is a layout preview only: its text is an example, not a summary
 * the model wrote.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')

/**
 * Read a `--flag value` argument.
 * @param {string} flag - flag name including dashes.
 * @param {string} fallback - value when absent.
 * @returns {string} the flag value.
 */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const htmlPath = resolve(arg('--html', join(dshHome, 'workbench', 'out', 'dsh-workbench.html')))
const pngPath = resolve(arg('--png', join(projectRoot, 'out', '工作台-工作总结-示例.png')))

if (!existsSync(htmlPath)) throw new Error(`找不到已构建的页面：${htmlPath}\n先跑 node tools/build.mjs`)

/** Example daily reports, newest first. */
const DAILY = [
  {
    kind: 'daily',
    key: 'daily:2026-11-03',
    fromKey: '2026-11-03',
    toKey: '2026-11-03',
    title: '11月3日（周二） 日报',
    generatedAt: Date.parse('2026-11-03T18:32:00+08:00'),
    model: 'huoshanyinqing/deepseek-v4-1-flash-261017',
    sessions: 4,
    messageCount: 23,
    materialChars: 8342,
    text: [
      '一、今日主要工作',
      '1. 完成「工作台」插件每日/每周工作总结功能：从会话日志提取当天对话，过滤闲聊与系统注入内容后交给模型写成书面总结。',
      '2. 补齐面板「工作总结」标签页：日报/周报切换、历史期数翻看、一键复制，空数据与失败都有中文提示。',
      '3. 修复面板挂载即报错的问题，补 14 项前端渲染测试，全部通过。',
      '',
      '二、完成情况',
      '1. 已完成：面板渲染、生成接口接线、本地总结存档与自动定时规则。',
      '2. 进行中：后端模型调用契约核对与测试补全。',
      '',
      '三、问题与风险',
      '本机 DSH 以 Windows 服务方式运行，改完后端代码需要重启一次服务才会生效。',
      '',
      '四、明日计划',
      '1. 重启服务并真实生成一份日报，核对内容质量。',
      '2. 根据实际效果调整自动生成时间与字数。',
    ].join('\n'),
  },
  {
    kind: 'daily',
    key: 'daily:2026-11-02',
    fromKey: '2026-11-02',
    toKey: '2026-11-02',
    title: '11月2日（周一） 日报',
    generatedAt: Date.parse('2026-11-02T18:31:00+08:00'),
    model: 'huoshanyinqing/deepseek-v4-1-flash-261017',
    sessions: 3,
    messageCount: 17,
    materialChars: 6120,
    text: '（11月2日的日报示例正文：整理发版公告、核对医保钱包 2.0 升级说明……）',
  },
]
const WEEKLY = [
  {
    kind: 'weekly',
    key: 'weekly:2026-10-27~2026-10-31',
    fromKey: '2026-10-27',
    toKey: '2026-10-31',
    title: '10月27日（周一） – 10月31日（周五） 周报',
    generatedAt: Date.parse('2026-10-31T18:34:00+08:00'),
    model: 'huoshanyinqing/deepseek-v4-1-flash-261017',
    sessions: 0,
    messageCount: 0,
    materialChars: 4210,
    dailyCount: 5,
    text: [
      '一、本周重点',
      '1. 完成工作台插件 1.3.3 版本：拆成「概览」「花费与产出」两个标签页。',
      '2. 开始每日/每周工作总结功能，打通从会话日志到模型写作再到本地存档的链路。',
      '',
      '二、进展与产出',
      '1. 工作台插件：新增工作总结标签页、日报/周报生成、自动定时与历史期数翻看。',
      '2. 发版公告：整理医保钱包 2.0 升级公告并生成为可直接发布的 HTML 页面。',
      '',
      '三、问题与风险',
      '无（示例文本）。',
      '',
      '四、下周计划',
      '1. 重启服务验证自动生成，按真实效果调整提示词。',
      '2. 补充总结的导出方式（复制到钉钉文档）。',
    ].join('\n'),
  },
]

const summaries = {
  enabled: true,
  dailyTime: '18:30',
  weeklyTime: '18:30',
  generatedAt: Date.parse('2026-11-03T18:32:00+08:00'),
  lastError: null,
  daily: DAILY,
  weekly: WEEKLY,
}

const page = readFileSync(htmlPath, 'utf8')
const pattern = /(<script type="application\/json" id="wb-payload">)([\s\S]*?)(<\/script>)/
const match = pattern.exec(page)
if (match === null) throw new Error('已构建的页面里找不到数据载荷')

const payload = JSON.parse(match[2])
payload.summaries = summaries
const embedded = JSON.stringify(payload).replace(/</g, '\\u003c')
const injected = page.replace(pattern, (_all, open, _body, close) => open + embedded + close)

// Click the summary tab once the engine has painted, then hold still for the shot.
const clickScript = `
<script>
(function () {
  var tries = 0;
  var timer = setInterval(function () {
    var tabs = [].slice.call(document.querySelectorAll('.wb-tab'));
    var target = tabs.filter(function (tab) { return tab.textContent.indexOf('工作总结') >= 0; })[0];
    if (target) {
      clearInterval(timer);
      target.click();
    } else if (++tries > 40) {
      clearInterval(timer);
    }
  }, 50);
})();
</script>
</body>`

const previewHtml = injected.replace('</body>', clickScript)
const workDir = join(tmpdir(), 'wb-summary-preview')
mkdirSync(workDir, { recursive: true })
const previewPath = join(workDir, 'preview.html')
writeFileSync(previewPath, previewHtml)

/**
 * Locate an installed Chromium-family browser.
 * @returns {string | undefined} executable path.
 */
function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

const browser = findBrowser()
if (browser === undefined) throw new Error('没找到 Chrome 或 Edge，无法截图')

mkdirSync(dirname(pngPath), { recursive: true })
const result = spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1280,1500',
    '--virtual-time-budget=5000',
    `--screenshot=${pngPath}`,
    `file:///${previewPath.replace(/\\/g, '/')}`,
  ],
  { encoding: 'utf8', timeout: 120_000 },
)
if (!existsSync(pngPath)) {
  throw new Error(`截图失败：${result.stderr ?? ''}${result.stdout ?? ''}`)
}
console.log(`预览页 → ${previewPath}`)
console.log(`截图   → ${pngPath}`)
