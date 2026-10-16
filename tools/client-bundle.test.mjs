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
  const fetchStub = async (url) => {
    calls.push(url)
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
})

test('the page falls back to the embedded snapshot when the route fails', async () => {
  const html = readFileSync(join(here, '..', 'out', 'dsh-workbench.html'), 'utf8')
  const fetchStub = async (url) => {
    if (url.endsWith('/api/summary')) return { ok: false, status: 500, json: async () => ({}) }
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
