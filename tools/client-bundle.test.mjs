/**
 * Contract tests for the generated DSH client bundle.
 *
 * The bundle loads through the host's `window.__ModuleLoader__.load` protocol,
 * needs `react`, and registers into DSH's slot registry. This harness supplies
 * those three things, then drives the registered page component with a stub
 * React implementation, so a wrong slot name, a missing export, or a broken
 * fetch path fails here instead of silently leaving the GUI without a panel.
 *
 * The bundle is rebuilt in memory from `src/` (see `readBundleSource`), so the
 * shipped concatenation — engine plus panel in one script — is what runs here.
 *
 * Run: node --test "tools/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClientBundle } from './bundler.mjs'
import { WORKBENCH_CSS, renderWorkbench } from '../src/workbench-render.mjs'
import { ShimDocument } from './dom-shim.mjs'

/**
 * Rewind the stub renderer's hook cursor for the next render pass.
 * @param {object} react - stub React.
 */
function resetCursor(react) {
  react.renderCursor()
}

const here = dirname(fileURLToPath(import.meta.url))
/** Cached bundle text; the sources do not change while one test run is going. */
let bundleSource = null

/**
 * Return the client bundle source this file tests.
 *
 * By default the bundle is built in memory from `src/` with the same transform
 * `tools/build.mjs` uses. Testing the sources keeps the checks honest: the
 * concatenation step itself runs here, so a syntax error or a helper name
 * declared twice in the engine fails this file instead of surfacing as a bare
 * "import failed" in the host page — and no generated artifact has to be
 * regenerated first. `WB_BUNDLE` still points the harness at a real artifact (an
 * unpacked tarball, say), so the shipped file can be tested exactly as shipped.
 * @returns {string} client bundle script text.
 */
function readBundleSource() {
  if (bundleSource !== null) return bundleSource
  const artifact = process.env.WB_BUNDLE
  if (artifact !== undefined && artifact !== '') {
    bundleSource = readFileSync(artifact, 'utf8')
    return bundleSource
  }
  // Same substitution `tools/build.mjs` performs before bundling the panel.
  const clientSource = readFileSync(join(here, '..', 'src', 'client-panel.js'), 'utf8').replace(
    '__WB_CSS__',
    'WB_ENGINE.WORKBENCH_CSS',
  )
  bundleSource = buildClientBundle(clientSource)
  return bundleSource
}

/** Minimal React stand-in: records element trees and runs hooks immediately. */
function stubReact() {
  const hooks = { states: [], effects: [], refs: [] }
  let cursor = 0
  let pendingEffects = []
  return {
    hooks,
    reset() {
      cursor = 0
      pendingEffects = []
      hooks.states = []
      hooks.effects = []
      hooks.refs = []
    },
    /** @returns {void} */
    /** Rewind the hook index, as a fresh render would. */
    renderCursor() {
      cursor = 0
    },
    flushEffects() {
      const queued = pendingEffects
      pendingEffects = []
      for (const [effect, cleanup] of queued) {
        const result = effect()
        hooks.effects.push({ effect, cleanup, result })
      }
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useRef(initial) {
      const index = cursor++
      if (hooks.refs[index] === undefined) hooks.refs[index] = { current: initial }
      return hooks.refs[index]
    },
    useState(initial) {
      const index = cursor++
      if (hooks.states[index] === undefined) {
        hooks.states[index] = typeof initial === 'function' ? initial() : initial
      }
      const setter = (next) => {
        hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next
      }
      return [hooks.states[index], setter]
    },
    useEffect(effect) {
      cursor += 1
      pendingEffects.push([effect])
    },
  }
}

/**
 * Load the client bundle against a fresh harness.
 * @param {object} options - `fetch` implementation and document override.
 * @returns {{registrations: object[], component: Function, react: object, expose: object}}
 */
function loadClient(options = {}) {
  const source = readBundleSource()
  const registrations = []
  const react = stubReact()
  const doc = options.document ?? new ShimDocument()
  /** Recorded slot registrations, keyed by slot name. */
  const injects = []
  const ctx = {
    effect(factory) {
      factory()
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => (key === 'panel' ? '工作台' : key),
    },
    slots: {
      inject(name, factory) {
        injects.push(name)
        factory()
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  const expose = { doc }
  const windowShim = {
    __ModuleLoader__: {
      load({ id, factory }) {
        expose.id = id
        expose.exports = factory((name) => {
          if (name === 'react') return react
          throw new Error(`unexpected require("${name}")`)
        })
      },
    },
    document: doc,
    fetch: options.fetch,
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const loader = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', source)
  loader(windowShim, doc, options.fetch, windowShim.setInterval, windowShim.clearInterval)
  return { registrations, component: expose.exports, react, ctx, injects, expose }
}

test('client bundle registers into the loader and exposes apply/inject', () => {
  const { component, ctx, injects } = loadClient()
  assert.equal(component.PANEL_ID, 'dsh-workbench')
  assert.deepEqual(component.inject, ['slots', 'locale'])
  assert.equal(typeof component.apply, 'function')
  component.apply(ctx)
  assert.deepEqual(injects, ['main', 'sidebar.panellist'], 'both slots are claimed')
})

test('apply registers the page and its sidebar entry under one id', () => {
  const { component, registrations, ctx } = loadClient()
  component.apply(ctx)
  const page = registrations.find((entry) => entry.spec.name === 'main')
  const row = registrations.find((entry) => entry.spec.name === 'sidebar.panellist')
  assert.ok(page !== undefined, 'main slot registration exists')
  assert.equal(page.spec.key, component.PANEL_ID)
  assert.equal(typeof page.component, 'function', 'page component is a function')
  assert.ok(row !== undefined, 'sidebar list entry exists')
  assert.equal(row.spec.id, component.PANEL_ID, 'sidebar id matches the panel key')
  assert.ok(['工作台', 'Workbench', 'panel'].includes(row.spec.label()), `label resolves to a name, got ${row.spec.label()}`)
  assert.equal(typeof row.component, 'function', 'sidebar icon is a function')
})

test('the page mounts charts from the API payload', async () => {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  const calls = []
  const activeStub = { enabled: true, refreshMs: 10000, generatedAt: Date.now(), counts: {}, sessions: [], jobs: [], warnings: [] }
  const fetchStub = async (url) => {
    calls.push(url)
    if (url.endsWith('/api/active')) return { ok: true, status: 200, json: async () => activeStub }
    return { ok: true, status: 200, json: async () => payload }
  }
  const { component, registrations, react, ctx } = loadClient({ fetch: fetchStub })
  component.apply(ctx)
  const page = registrations.find((entry) => entry.spec.name === 'main')

  const doc = new ShimDocument()
  const container = doc.createElement('div')
  container.clientWidth = 900
  resetCursor(react)
  const element = page.component()
  assert.equal(element.type, 'div', 'loading state renders a container')

  // Run the mount effect exactly the way React would, with the ref populated.
  react.reset()
  resetCursor(react)
  const props = page.component()
  assert.ok(props !== null)
  const refHolder = react.hooks.refs.find((ref) => ref !== undefined)
  assert.ok(refHolder !== undefined, 'the component keeps a container ref')
  refHolder.current = container
  react.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.ok(calls.length >= 1, 'the page fetched the summary route')
  assert.match(calls[0], /\/dsh-workbench\/api\/summary$/)
  assert.ok(
    container.querySelectorAll('.wb-heat-cell').length === payload.heatmapDaily.length,
    'one heatmap cell per day in the window',
  )
  assert.ok(container.querySelectorAll('.wb-bar').length > 0, 'trend bars rendered into the container')
  assert.ok(react.hooks.states.includes('ready'), 'status leaves the loading state')
  assert.ok(container.querySelector('[data-wb-active]') !== null, 'the live section exists')
  assert.ok(calls.some((url) => url.endsWith('/api/active')), 'the live route is polled')
})

test('the live section renders running sessions, jobs and todos', async () => {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  const activeStub = {
    enabled: true,
    refreshMs: 10000,
    generatedAt: Date.now() - 2000,
    idleMinutes: 10,
    counts: { sessions: 1, runningTurns: 1, runningJobs: 1, waitingApproval: 0, retrying: 0 },
    sessions: [
      {
        sessionId: 'session-abc',
        title: '安装工作台插件',
        cwd: 'E:\\项目',
        status: 'tool',
        turn: 7,
        step: 4,
        startedAt: Date.now() - 60000,
        elapsedMs: 60000,
        model: { provider: 'deepseek-official', model: 'deepseek-flash' },
        action: { kind: 'tool', tool: 'pwsh', toolLabel: '运行命令', target: null, reason: null, retry: null },
        todos: { total: 5, completed: 2, inProgress: '写设计说明' },
        lastEventAt: Date.now() - 2000,
        dataAgeMs: 2000,
      },
    ],
    jobs: [{ jobId: 'job-1', sessionId: 'session-abc', kind: 'pwsh', title: '安装工作台插件', startedAt: Date.now() - 30000, elapsedMs: 30000, label: null }],
    warnings: [],
  }
  const fetchStub = async (url) => {
    if (url.endsWith('/api/active')) return { ok: true, status: 200, json: async () => activeStub }
    return { ok: true, status: 200, json: async () => payload }
  }
  const { component, registrations, react, ctx } = loadClient({ fetch: fetchStub })
  component.apply(ctx)
  const page = registrations.find((entry) => entry.spec.name === 'main')
  const doc = new ShimDocument()
  const container = doc.createElement('div')
  container.clientWidth = 900
  react.reset()
  resetCursor(react)
  const props = page.component()
  assert.ok(props !== null)
  const refHolder = react.hooks.refs.find((ref) => ref !== undefined)
  refHolder.current = container
  react.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 30))

  const section = container.querySelector('[data-wb-active]')
  assert.ok(section !== null, 'live section rendered')
  const textOf = (node) => node.querySelectorAll('span').map((span) => span.textContent).join(' ')
  const state = section.querySelector('.wb-active-state')
  const title = section.querySelector('.wb-active-title')
  const todos = section.querySelector('.wb-active-todos')
  const jobs = section.querySelector('.wb-active-jobs')
  const jobsHead = section.querySelector('.wb-active-jobs-head')
  assert.ok(state !== null && state.textContent.includes('正在执行'), `state wording present, got: ${state?.textContent ?? '(none)'}`)
  assert.ok(state.textContent.includes('运行命令'))
  assert.ok(title !== null && textOf(title).includes('安装工作台插件'))
  assert.ok(todos !== null && textOf(todos).includes('待办 2/5'))
  assert.ok(textOf(todos).includes('写设计说明'))
  assert.ok(jobsHead !== null && jobsHead.textContent.includes('后台任务 1 个'))
  assert.ok(jobs !== null && jobs.querySelectorAll('.wb-active-job').length === 1)
})

test('the page falls back to the embedded snapshot when the route fails', async () => {
  const html = readFileSync(join(here, '..', 'out', 'dsh-workbench.html'), 'utf8')
  const fetchStub = async (url) => {
    if (url.endsWith('/api/summary')) return { ok: false, status: 500, json: async () => ({}) }
    if (url.endsWith('/api/active')) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, text: async () => html }
  }
  const { component, registrations, react, ctx } = loadClient({ fetch: fetchStub })
  component.apply(ctx)
  const page = registrations.find((entry) => entry.spec.name === 'main')

  const doc = new ShimDocument()
  const container = doc.createElement('div')
  container.clientWidth = 900
  resetCursor(react)
  const props = page.component()
  assert.ok(props !== null)
  const refHolder = react.hooks.refs.find((ref) => ref !== undefined)
  refHolder.current = container
  react.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.ok(react.hooks.states.includes('ready'), 'fallback still yields a rendered page')
  assert.ok(container.querySelectorAll('.wb-heat-cell').length > 0, 'heatmap rendered from the embedded snapshot')
})

/** Sample insights block with one entry in every list. */
function sampleInsights() {
  const now = Date.now()
  return {
    windowDays: 7,
    currency: 'CNY',
    priceNote: '全部调用均已配置价格',
    cost: {
      total: 12.34,
      saved: 5.6,
      calls: 120,
      pricedCalls: 118,
      unpricedCalls: 2,
      tokens: { input: 100_000, output: 20_000, cacheRead: 1_000_000, cacheWrite: 0 },
      byModel: [],
      unpricedModels: [],
    },
    topSessions: [],
    waiting: [{ sessionId: 's1', title: '发版公告整理', cwd: 'E:\\项目', kind: 'approval', toolName: 'pwsh', reason: 'escalate sandbox', since: now - 60_000, ageMs: 60_000 }],
    todos: [
      {
        sessionId: 's2',
        title: '慢查询治理',
        cwd: 'E:\\项目',
        total: 5,
        completed: 3,
        items: [
          { content: '跑测试', status: 'in_progress' },
          { content: '打包', status: 'pending' },
        ],
        lastEventAt: now - 3_600_000,
      },
    ],
    deliverables: [{ path: 'E:\\项目\\报告.md', name: '报告.md', description: '季度报告', sessionId: 's2', title: '慢查询治理', at: now - 7_200_000 }],
    context: [
      {
        sessionId: 's1',
        title: '发版公告整理',
        cwd: 'E:\\项目',
        usedTokens: 240_000,
        warnTokens: 200_000,
        maxTokens: 256_000,
        ratio: 1.2,
        model: 'deepseek-official/deepseek-flash',
        at: now - 60_000,
      },
    ],
    counts: { waiting: 1, todos: 1, deliverables: 1, context: 1 },
    showLatency: false,
    reportText: '【AI 使用周报】2026-10-15 ~ 2026-10-22\n· 调用 120 次\n· 估算花费 ¥12.3',
  }
}

/**
 * Mount the panel against a payload and expose the visible headings plus tab helpers.
 * @param {object} payload - summary payload (insights included or omitted).
 * @param {object} [options] - test hooks.
 * @param {(init: object, url: string) => Promise<object>} [options.onGenerate] - answer for `POST /api/summaries/generate`.
 * @returns {Promise<{container: object, headings: () => string[], tabs: object[], tabFor: (label: string) => object | undefined, clickTab: (label: string) => void, buttons: object[], calls: {url: string, init: object}[]}>} rendered page facts.
 */
async function renderPanel(payload, options = {}) {
  const activeStub = { enabled: true, refreshMs: 10000, generatedAt: Date.now(), counts: {}, sessions: [], jobs: [], warnings: [] }
  const calls = []
  const fetchStub = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/api/active')) return { ok: true, status: 200, json: async () => activeStub }
    if (url.endsWith('/api/summaries/generate')) {
      if (typeof options.onGenerate === 'function') return options.onGenerate(init ?? {}, url)
      return { ok: false, status: 500, json: async () => ({ error: '测试里没准备生成结果' }) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  const { component, registrations, react, ctx } = loadClient({ fetch: fetchStub })
  component.apply(ctx)
  const page = registrations.find((entry) => entry.spec.name === 'main')
  const doc = new ShimDocument()
  const container = doc.createElement('div')
  container.clientWidth = 900
  react.reset()
  resetCursor(react)
  const props = page.component()
  assert.ok(props !== null)
  const refHolder = react.hooks.refs.find((ref) => ref !== undefined)
  refHolder.current = container
  react.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 30))

  /** Headings of sections that are actually visible (tab and list visibility). */
  const headings = () => {
    const panels = container.querySelectorAll('.wb-tab-panel')
    const sections =
      panels.length > 0
        ? panels.filter((panel) => panel.hidden !== true).flatMap((panel) => panel.querySelectorAll('section'))
        : container.querySelectorAll('section')
    return sections
      .filter((section) => section.hidden !== true)
      .map((section) => section.querySelector('h2')?.textContent)
      .filter((title) => title !== undefined && title !== null)
  }
  const tabs = container.querySelectorAll('.wb-tab')
  /** Full label text (the shim does not aggregate child text into textContent). */
  const labelOf = (node) => [node.textContent, ...node.querySelectorAll('span').map((span) => span.textContent)].join('')
  const tabFor = (label) => tabs.find((tab) => labelOf(tab).includes(label))
  const clickTab = (label) => {
    const button = tabFor(label)
    assert.ok(button !== undefined, `tab "${label}" exists`)
    button.dispatch('click')
  }
  return { container, headings, tabs, tabFor, clickTab, buttons: container.querySelectorAll('.wb-btn'), calls }
}

test('insight sections live on the second tab and show a badge for alerts', async () => {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  payload.insights = sampleInsights()
  const { container, headings, clickTab, tabFor, buttons } = await renderPanel(payload)

  assert.ok(headings().includes('调用热力图'), 'the charts tab is shown first')
  assert.ok(headings().includes('每日趋势'))
  assert.ok(headings().includes('近 7 天概览'), 'the cost cards live on the first tab')
  assert.ok(!headings().includes('一键周报'), 'the weekly report stays on the second tab')
  const insightsPanel = container.querySelector('[data-wb-tab="insights"]')
  assert.equal(insightsPanel.hidden, true, 'the insights panel starts hidden')

  clickTab('花费与产出')
  const secondTab = headings()
  assert.equal(secondTab[0], '一键周报', 'the weekly report comes first on the insights tab')
  assert.ok(secondTab.includes('等你确认'), 'waiting section is shown')
  assert.ok(secondTab.includes('上下文提醒'), 'context section is shown')
  assert.ok(!secondTab.includes('近 7 天概览'), 'the cost cards are not repeated on the second tab')
  assert.ok(secondTab.includes('未完成待办'), 'todo section is shown')
  assert.ok(secondTab.includes('最近交付'), 'deliverables section is shown')
  assert.ok(!secondTab.includes('延迟趋势'), 'the latency chart is hidden by default')
  assert.ok(!secondTab.includes('调用热力图'), 'the charts hide on the second tab')

  const tab = tabFor('花费与产出')
  const badge = tab.querySelector('.wb-tab-badge')
  assert.ok(badge !== null && badge.textContent === '2', `badge counts waiting + context, got ${badge?.textContent}`)
  assert.equal(badge.hidden, false)

  const report = container.querySelector('.wb-report')
  assert.ok(report !== null, 'the weekly report block exists')
  assert.ok(report.textContent.includes('AI 使用周报'))
  assert.ok(buttons.some((button) => button.textContent === '复制周报'), 'the copy button exists')

  const states = container.querySelectorAll('.wb-active-state').map((node) => node.textContent)
  assert.ok(states.some((text) => text.includes('等你批准')), 'waiting wording is rendered')
  assert.ok(states.some((text) => text.includes('上下文 240.0K')), 'context wording is rendered')
  assert.ok(states.some((text) => text.includes('未完成 2/5')), 'todo wording is rendered')

  const titles = container.querySelectorAll('.wb-active-title').map((node) => node.querySelectorAll('span').map((span) => span.textContent).join(' '))
  assert.ok(titles.some((text) => text.includes('报告.md')), 'deliverable name is rendered')
})

test('switching tabs toggles the panels', async () => {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  payload.insights = sampleInsights()
  const { headings, clickTab } = await renderPanel(payload)
  assert.ok(headings().includes('调用热力图'), 'overview first')
  assert.ok(headings().includes('近 7 天概览'), 'cost cards are on the overview tab')
  clickTab('花费与产出')
  assert.ok(headings().includes('一键周报'), 'second tab shows the weekly report')
  assert.ok(!headings().includes('近 7 天概览'), 'cost cards are not on the second tab')
  clickTab('概览')
  assert.ok(headings().includes('调用热力图'), 'switching back restores the charts tab')
  assert.ok(headings().includes('近 7 天概览'))
  assert.ok(!headings().includes('一键周报'))
})

test('empty insight lists hide their sections; missing insights keep the latency chart', async () => {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  const insights = sampleInsights()
  insights.waiting = []
  insights.todos = []
  insights.deliverables = []
  insights.context = []
  insights.counts = { waiting: 0, todos: 0, deliverables: 0, context: 0 }
  payload.insights = insights
  const empty = await renderPanel(payload)
  assert.ok(empty.headings().includes('近 7 天概览'), 'the cost cards still render with zero counts on the overview tab')
  empty.clickTab('花费与产出')
  assert.ok(empty.headings().includes('一键周报'), 'the weekly report still renders')
  assert.ok(!empty.headings().includes('等你确认'), 'empty waiting section is hidden')
  assert.ok(!empty.headings().includes('未完成待办'), 'empty todo section is hidden')
  assert.ok(!empty.headings().includes('最近交付'), 'empty deliverables section is hidden')

  const tab = empty.tabFor('花费与产出')
  const badge = tab.querySelector('.wb-tab-badge')
  assert.equal(badge.hidden, true, 'no alert badge without waiting or context items')

  delete payload.insights
  const legacy = await renderPanel(payload)
  assert.equal(legacy.tabs.length, 0, 'a payload without insights has no tabs')
  assert.ok(legacy.headings().includes('延迟趋势'), 'a payload without insights keeps the latency chart')
  assert.ok(!legacy.headings().includes('近 7 天概览'), 'no overview without insights')
})

/** Sample summaries block with two daily reports and one weekly report. */
function sampleSummaries() {
  const now = Date.now()
  return {
    enabled: true,
    dailyTime: '18:30',
    weeklyTime: '19:00',
    generatedAt: now,
    lastError: null,
    daily: [
      {
        kind: 'daily',
        key: 'daily:2026-11-03',
        fromKey: '2026-11-03',
        toKey: '2026-11-03',
        title: '11月3日（周二） 日报',
        text: '一、今日主要工作\n1. 完成工作总结面板\n2. 补齐日报渲染\n\n二、完成情况\n已完成渲染与生成接口接线。',
        generatedAt: now - 3_600_000,
        model: 'deepseek-official/deepseek-chat',
        sessions: 12,
        messageCount: 86,
        materialChars: 5_200,
      },
      {
        kind: 'daily',
        key: 'daily:2026-11-02',
        fromKey: '2026-11-02',
        toKey: '2026-11-02',
        title: '11月2日（周一） 日报',
        text: '一、今日主要工作\n梳理需求。',
        generatedAt: now - 90_000_000,
        model: 'deepseek-official/deepseek-chat',
        sessions: 4,
        messageCount: 21,
        materialChars: 1_800,
      },
    ],
    weekly: [
      {
        kind: 'weekly',
        key: 'weekly:2026-10-27~2026-10-31',
        fromKey: '2026-10-27',
        toKey: '2026-10-31',
        title: '10月27日（周一） – 10月31日（周五） 周报',
        text: '一、本周重点\n完成工作台面板。\n\n二、进展与产出\n日报与周报均可复制。',
        generatedAt: now - 7_200_000,
        model: 'deepseek-official/deepseek-chat',
        sessions: 0,
        messageCount: 0,
        materialChars: 9_800,
        dailyCount: 4,
      },
    ],
  }
}

/**
 * Concatenated visible text of an element (the shim keeps child text separate).
 * @param {object} node - element to read.
 * @returns {string} visible text.
 */
function visibleText(node) {
  return [node.textContent, ...node.querySelectorAll('span').map((span) => span.textContent)].join(' ')
}

/**
 * Find one button by its exact visible label inside a scope.
 * @param {object} scope - search root.
 * @param {string} label - expected label.
 * @returns {object | undefined} the button, if any.
 */
function findButton(scope, label) {
  return scope.querySelectorAll('.wb-btn').find((button) => button.textContent === label)
}

/**
 * Mount the panel with a summaries block and open the summary tab.
 * @param {object} summaries - summaries payload block.
 * @param {object} [options] - test hooks forwarded to `renderPanel`.
 * @returns {Promise<object>} rendered page facts plus the summary section.
 */
async function renderSummaries(summaries, options = {}) {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  payload.summaries = summaries
  const page = await renderPanel(payload, options)
  page.clickTab('工作总结')
  page.section = page.container.querySelector('[data-wb-summary]')
  return page
}

test('the summaries tab renders the daily report title, body and period switcher', async () => {
  const page = await renderSummaries(sampleSummaries())
  const { container, headings, section } = page
  assert.ok(headings().includes('工作总结'), 'the summary tab shows its section')

  const title = container.querySelector('.wb-summary-title')
  assert.ok(title !== null && title.textContent.includes('11月3日（周二） 日报'), `daily title rendered, got: ${title?.textContent}`)
  const body = container.querySelector('.wb-summary-text')
  assert.ok(body !== null, 'the report body exists')
  assert.ok(body.textContent.includes('一、今日主要工作'), 'the report text is rendered verbatim')
  assert.ok(body.textContent.includes('\n'), 'newlines survive into the line box')
  // The line box that keeps those breaks visible ships in the stylesheet.
  assert.match(WORKBENCH_CSS, /\.wb-summary-text[^}]*white-space:\s*pre-wrap/s, 'the summary body keeps line breaks')
  assert.doesNotMatch(WORKBENCH_CSS, /\ufffd/, 'the stylesheet has no replacement characters')

  const periods = container.querySelectorAll('.wb-summary-period')
  assert.equal(periods.length, 2, 'one period button per stored daily report')
  assert.ok(periods[0].className.includes('wb-summary-period-active'), 'the newest period starts selected')
  assert.equal(periods[0].textContent, '11月3日（周二）')

  const badges = container.querySelector('.wb-summary-badges')
  const badgeText = badges.querySelectorAll('span').map((span) => span.textContent)
  assert.ok(badgeText.some((text) => text.includes('deepseek/deepseek-chat')), `model footnote present, got: ${badgeText}`)
  assert.ok(badgeText.some((text) => text.includes('12 个会话')), 'material size footnote present')
  const foot = section.querySelector('.wb-summary-foot')
  assert.ok(foot.querySelectorAll('span').map((span) => span.textContent).join(' ').includes('19:00'), 'the schedule footnote uses the configured times')
  assert.ok(findButton(container, '复制') !== undefined, 'the copy button exists')

  // Switching period swaps the article and stays on the summary tab.
  periods[1].dispatch('click')
  assert.equal(container.querySelector('.wb-summary-title').textContent, '11月2日（周一） 日报')
  assert.equal(container.querySelector('[data-wb-tab="summaries"]').hidden, false)
})

test('switching to 周报 renders the weekly report and its source count', async () => {
  const page = await renderSummaries(sampleSummaries())
  const { container, section } = page
  const weeklyButton = findButton(section, '周报')
  assert.ok(weeklyButton !== undefined, 'the weekly kind button exists')
  weeklyButton.dispatch('click')

  assert.equal(container.querySelector('.wb-summary-title').textContent, '10月27日（周一） – 10月31日（周五） 周报')
  assert.ok(container.querySelector('.wb-summary-text').textContent.includes('一、本周重点'))
  const badgeText = container.querySelector('.wb-summary-badges').querySelectorAll('span').map((span) => span.textContent)
  assert.ok(badgeText.some((text) => text.includes('4 篇日报')), `weekly footnote counts its source dailies, got: ${badgeText}`)
  assert.equal(container.querySelectorAll('.wb-summary-period').length, 1, 'only the stored weekly period is offered')

  findButton(section, '日报').dispatch('click')
  assert.equal(container.querySelector('.wb-summary-title').textContent, '11月3日（周二） 日报', 'switching back restores the daily view')
})

test('the summaries tab degrades to Chinese hints instead of throwing', async () => {
  // 1) A schedule with no reports yet.
  const empty = await renderSummaries({ ...sampleSummaries(), daily: [], weekly: [] })
  const emptyNotice = empty.container.querySelector('.wb-summary-notice')
  assert.equal(emptyNotice.hidden, false, 'the empty hint is visible')
  assert.ok(emptyNotice.textContent.includes('还没有日报'), `empty wording, got: ${emptyNotice.textContent}`)
  assert.equal(empty.container.querySelector('.wb-summary-article').hidden, true, 'no article without entries')

  // 2) Auto-generation switched off in the plugin config.
  const off = await renderSummaries({ ...sampleSummaries(), enabled: false })
  const offNotice = off.container.querySelector('.wb-summary-notice')
  assert.equal(offNotice.hidden, false)
  assert.ok(offNotice.textContent.includes('自动生成已关闭'), `disabled wording, got: ${offNotice.textContent}`)
  assert.ok(offNotice.textContent.includes('立即生成'), 'the hint still points at the manual button')

  // 3) The last scheduled run failed: the stored report still shows, with a warning.
  const failed = await renderSummaries({ ...sampleSummaries(), lastError: '模型调用失败：超时' })
  const warn = failed.container.querySelector('.wb-summary-notice')
  assert.equal(warn.hidden, false)
  assert.ok(warn.textContent.includes('上次自动生成没有成功') && warn.textContent.includes('超时'), `warning wording, got: ${warn.textContent}`)
  assert.ok(failed.container.querySelector('.wb-summary-title').textContent.includes('11月3日'), 'the stored report still renders')

  // 4) The host could not read its store: a hard error hint, still no throw.
  const broken = await renderSummaries({ enabled: false, daily: [], weekly: [], generatedAt: Date.now(), error: 'EACCES: 读不到 summaries.json' })
  const brokenNotice = broken.container.querySelector('.wb-summary-notice')
  assert.ok(brokenNotice.textContent.includes('读取本地总结失败') && brokenNotice.textContent.includes('EACCES'), `error wording, got: ${brokenNotice.textContent}`)

  // 5) A payload without the block has no summary tab at all.
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  payload.insights = sampleInsights()
  const legacy = await renderPanel(payload)
  const summaryTab = legacy.tabFor('工作总结')
  // Identity is compared as a boolean: handing a DOM node to `assert.equal`
  // makes Node's failure diff walk the whole shim tree (and can exhaust the heap).
  assert.ok(summaryTab === undefined || summaryTab.hidden === true, 'no visible summary tab without a summaries block')
})

test('立即生成 posts the selected kind and repaints only the summary region', async () => {
  const stored = sampleSummaries()
  const fresh = {
    ...stored.daily[0],
    key: 'daily:2026-11-04',
    fromKey: '2026-11-04',
    toKey: '2026-11-04',
    title: '11月4日（周三） 日报',
    text: '一、今日主要工作\n刚生成的日报正文。',
    generatedAt: Date.now(),
  }
  const requests = []
  const page = await renderSummaries(stored, {
    onGenerate(init, url) {
      requests.push({ init, url })
      return { ok: true, status: 200, json: async () => ({ entry: fresh, summaries: { ...stored, daily: [fresh, ...stored.daily] } }) }
    },
  })
  const { container, section } = page
  const overviewBefore = container.querySelector('[data-wb-tab="overview"]')
  const summaryPanelBefore = container.querySelector('[data-wb-tab="summaries"]')
  const generate = findButton(section, '立即生成')
  assert.ok(generate !== undefined, 'the generate button exists when the host wires the hook')
  assert.equal(generate.hidden, false)

  generate.dispatch('click')
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(requests.length, 1, 'one generate request per click')
  assert.match(requests[0].url, /\/api\/summaries\/generate$/, 'the request goes to the generate route')
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].init.body), { kind: 'daily' }, 'the body carries the selected kind')
  assert.equal(container.querySelector('.wb-summary-title').textContent, '11月4日（周三） 日报', 'the new report replaces the view')
  assert.equal(container.querySelectorAll('.wb-summary-period').length, 3, 'the period switcher grew by one')
  assert.equal(generate.disabled, false, 'the button is usable again')
  assert.equal(generate.textContent, '立即生成')
  // Node identity as booleans, for the same reason as above.
  assert.ok(container.querySelector('[data-wb-tab="overview"]') === overviewBefore, 'the overview panel was not rebuilt')
  assert.ok(container.querySelector('[data-wb-tab="summaries"]') === summaryPanelBefore, 'the summary panel kept its nodes')
})

test('generation skip and failure both end in a Chinese notice', async () => {
  let mode = 'skip'
  const requests = []
  const page = await renderSummaries(sampleSummaries(), {
    onGenerate(init) {
      requests.push(JSON.parse(init.body))
      if (mode === 'skip') return { ok: true, status: 200, json: async () => ({ skipped: true, reason: 'no-llm-service' }) }
      return { ok: false, status: 500, json: async () => ({ error: '模型调用失败：超时' }) }
    },
  })
  const { container, section } = page
  const generate = findButton(section, '立即生成')
  const notice = container.querySelector('.wb-summary-notice')

  // Weekly first: the body must follow the kind button, not the old state.
  findButton(section, '周报').dispatch('click')
  generate.dispatch('click')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(requests[0], { kind: 'weekly' }, 'the weekly kind reaches the host')
  assert.equal(notice.hidden, false)
  assert.ok(notice.textContent.includes('没有可用的模型服务'), `skip wording, got: ${notice.textContent}`)
  assert.equal(generate.disabled, false, 'a skip re-enables the button')
  assert.equal(generate.textContent, '立即生成')

  mode = 'fail'
  generate.dispatch('click')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(notice.textContent.includes('生成失败') && notice.textContent.includes('超时'), `failure wording, got: ${notice.textContent}`)
  assert.equal(generate.disabled, false, 'a failure re-enables the button')
  assert.equal(generate.textContent, '立即生成')
})

test('the offline snapshot renders stored reports but offers no generate button', () => {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  payload.summaries = sampleSummaries()
  const doc = new ShimDocument()
  const host = doc.createElement('div')
  host.clientWidth = 900
  // No `generateSummary` hook: exactly the standalone dashboard's options.
  assert.doesNotThrow(() => renderWorkbench(host, payload, { compact: true }))
  const tabs = host.querySelectorAll('.wb-tab')
  const summaryTab = tabs.find((tab) => visibleText(tab).includes('工作总结'))
  assert.ok(summaryTab !== undefined, 'the summary tab exists offline')
  summaryTab.dispatch('click')

  assert.ok(host.querySelector('.wb-summary-title').textContent.includes('11月3日'), 'the stored report still renders')
  const generate = findButton(host, '立即生成')
  assert.ok(generate !== undefined, 'the button element exists')
  assert.equal(generate.hidden, true, 'but it is hidden without a host hook')

  // The copy fallback tells the user what to do instead of failing silently.
  const copy = findButton(host, '复制')
  assert.ok(copy !== undefined)
  copy.dispatch('click')
  assert.equal(copy.textContent, '请手动选中复制')
})

