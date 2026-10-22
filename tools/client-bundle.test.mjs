/**
 * Contract tests for the generated DSH client bundle.
 *
 * The bundle loads through the host's `window.__ModuleLoader__.load` protocol,
 * needs `react`, and registers into DSH's slot registry. This harness supplies
 * those three things, then drives the registered page component with a stub
 * React implementation, so a wrong slot name, a missing export, or a broken
 * fetch path fails here instead of silently leaving the GUI without a panel.
 *
 * Run: node --test "tools/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ShimDocument } from './dom-shim.mjs'

/**
 * Rewind the stub renderer's hook cursor for the next render pass.
 * @param {object} react - stub React.
 */
function resetCursor(react) {
  react.renderCursor()
}

const here = dirname(fileURLToPath(import.meta.url))
// `WB_BUNDLE` lets the package test point at an unpacked tarball instead of the
// working tree, so the artifact we hand out is the artifact we test.
const bundlePath =
  process.env.WB_BUNDLE ?? join(here, '..', 'plugin', 'lib', 'client', 'index.js')

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
  const source = readFileSync(bundlePath, 'utf8')
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
 * @returns {Promise<{container: object, headings: () => string[], tabs: object[], clickTab: (label: string) => void, buttons: object[]}>} rendered page facts.
 */
async function renderPanel(payload) {
  const activeStub = { enabled: true, refreshMs: 10000, generatedAt: Date.now(), counts: {}, sessions: [], jobs: [], warnings: [] }
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
  return { container, headings, tabs, tabFor, clickTab, buttons: container.querySelectorAll('.wb-btn') }
}

test('insight sections live on the second tab and show a badge for alerts', async () => {
  const payload = JSON.parse(readFileSync(join(here, '..', 'out', 'workbench.json'), 'utf8'))
  payload.insights = sampleInsights()
  const { container, headings, clickTab, tabFor, buttons } = await renderPanel(payload)

  assert.ok(headings().includes('调用热力图'), 'the charts tab is shown first')
  assert.ok(headings().includes('每日趋势'))
  assert.ok(!headings().includes('近 7 天概览'), 'insight sections stay on the second tab')
  const insightsPanel = container.querySelector('[data-wb-tab="insights"]')
  assert.equal(insightsPanel.hidden, true, 'the insights panel starts hidden')

  clickTab('花费与产出')
  const secondTab = headings()
  assert.ok(secondTab.includes('等你确认'), 'waiting section is shown')
  assert.ok(secondTab.includes('上下文提醒'), 'context section is shown')
  assert.ok(secondTab.includes('近 7 天概览'), 'overview section is shown')
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
  clickTab('花费与产出')
  assert.ok(headings().includes('近 7 天概览'), 'second tab shows insights')
  clickTab('概览')
  assert.ok(headings().includes('调用热力图'), 'switching back restores the charts tab')
  assert.ok(!headings().includes('近 7 天概览'))
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
  empty.clickTab('花费与产出')
  assert.ok(empty.headings().includes('近 7 天概览'), 'the overview still renders with zero counts')
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

