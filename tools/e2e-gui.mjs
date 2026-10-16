/**
 * End-to-end check of the running DSH GUI over the Chrome DevTools Protocol.
 *
 * Loads the Web GUI with the current token, waits for the app shell, opens the
 * workbench panel by clicking its sidebar entry, and reports the panel's state,
 * the HTTP requests it made, and every console error. This is the only check
 * that exercises the real client-plugin loader, the real slot registry, and the
 * real host routes together.
 *
 * Usage: node tools/e2e-gui.mjs [--timeout 60000] [--keep]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const timeoutMs = Number.parseInt(argv[argv.indexOf('--timeout') + 1] ?? '60000', 10)

/**
 * Read the token the running server printed.
 * @returns {string} token from the launcher log.
 */
function currentToken() {
  const log = readFileSync(join(homedir(), '.dsh', 'launchd-dsh.out.log'), 'utf8')
  const matches = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)]
  if (matches.length === 0) throw new Error('no token in launchd-dsh.out.log; is dsh web running?')
  return matches.at(-1)[1]
}

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
  throw new Error('no chrome-headless-shell found')
}

/** Minimal Chrome DevTools Protocol client over one WebSocket. */
class Cdp {
  /**
   * @param {string} url - DevTools WebSocket URL.
   */
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry !== undefined) {
          this.pending.delete(message.id)
          message.error === undefined ? entry.resolve(message.result) : entry.reject(new Error(JSON.stringify(message.error)))
        }
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  /** @returns {Promise<void>} resolves once the socket is open. */
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', (event) => reject(new Error(`websocket error: ${event.message ?? ''}`)))
    })
  }

  /**
   * Send one CDP method call.
   * @param {string} method - CDP method.
   * @param {object} [params] - method parameters.
   * @returns {Promise<any>} method result.
   */
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Subscribe to CDP events.
   * @param {(message: object) => void} listener - event listener.
   */
  on(listener) {
    this.listeners.push(listener)
  }

  /** Close the socket. */
  close() {
    this.socket.close()
  }
}

/**
 * Wait for a page-side predicate to hold.
 * @param {Cdp} cdp - client.
 * @param {string} expression - boolean expression evaluated in the page.
 * @param {number} timeout - maximum wait in milliseconds.
 * @returns {Promise<any>} the first truthy value.
 */
async function waitFor(cdp, expression, timeout) {
  const deadline = Date.now() + timeout
  for (;;) {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page expression failed: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '')}`)
    }
    if (result.result.value) return result.result.value
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

const token = currentToken()
const profile = mkdtempSync(join(tmpdir(), 'wb-cdp-'))
const port = 9411 + Math.floor(Math.random() * 200)
const chrome = spawn(
  headlessShell(),
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,1000',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const consoleErrors = []
const requests = []
let exitCode = 1
try {
  /** Wait for the DevTools endpoint to answer. */
  let version = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (version === null) throw new Error('DevTools endpoint never answered')
  console.log(`chrome: ${version['Browser']}`)

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready()
  cdp.on((message) => {
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    }
    if (message.method === 'Network.responseReceived') {
      const { url, status } = message.params.response
      if (url.includes('dsh-workbench') || url.includes('/plugins/')) requests.push({ url, status })
    }
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Page.enable')

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:3080/?token=${token}` })
  await waitFor(cdp, 'Boolean(document.querySelector("nav, aside, [class*=sidebar]"))', timeoutMs)
  console.log('app shell loaded')
  // Give the module loader time to fetch and apply every client plugin.
  await new Promise((resolve) => setTimeout(resolve, 6000))

  const shell = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const boot = globalThis.__DSH_BOOT__ || null
      const entries = boot ? boot.entries.map((entry) => entry.id) : []
      const aside = document.querySelector('aside') || document.querySelector('[class*=sidebar]')
      const sidebarText = (aside ? aside.textContent : '').replace(/\\s+/g, ' ').trim()
      const buttons = aside ? [...aside.querySelectorAll('button')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim()).filter(Boolean) : []
      return {
        title: document.title,
        bodyText: document.body.textContent.replace(/\\s+/g, ' ').slice(0, 200),
        bodyTextLength: document.body.textContent.length,
        elementCount: document.querySelectorAll('*').length,
        bootEntries: entries.length,
        workbenchInBoot: entries.includes('@dsh-workbench/panel'),
        panelLabels: [...document.querySelectorAll('*')].filter((node) => node.children.length === 0 && node.textContent.trim() === '工作台').length,
        sidebarText: sidebarText.slice(0, 400),
        sidebarButtons: buttons.slice(0, 20),
        requested: performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('workbench')),
      }
    })()`,
    returnByValue: true,
  })
  console.log('shell:', JSON.stringify(shell.result.value, null, 2))
  if (consoleErrors.length > 0) {
    console.log('console errors so far:')
    for (const error of consoleErrors.slice(0, 10)) console.log('  -', String(error).split('\n')[0].slice(0, 300))
  }

  // The workbench row is the last entry in the panel list; shipped rows precede
  // it, so match the exact translated label first and only then fall back.
  const clicked = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const buttons = [...document.querySelectorAll('button')]
      const labels = buttons.map((node) => (node.getAttribute('aria-label') || '').trim())
      const hit = buttons[labels.indexOf('panel')] ||
        buttons.find((node) => (node.textContent || '').trim() === '工作台')
      if (!hit) return ''
      hit.click()
      return (hit.getAttribute('aria-label') || hit.textContent || '').trim()
    })()`,
    returnByValue: true,
  })
  const clickedHtml = clicked.result.value
  console.log(clickedHtml === '' ? 'sidebar entry NOT found' : `clicked sidebar entry: ${clickedHtml}`)
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const panelState = await waitFor(
    cdp,
    `(() => {
      const root = document.querySelector('.wb-panel') ?? [...document.querySelectorAll('.wb-root')].pop()
      if (!root) return ''
      const cells = root.querySelectorAll('.wb-heat-cell').length
      const bars = root.querySelectorAll('.wb-bar').length
      if (cells > 0 && bars > 0) return 'ready: heat ' + cells + ' bars ' + bars
      return root.textContent.includes('正在读取') ? 'loading' : ''
    })()`,
    timeoutMs,
  )
  console.log(`panel: ${panelState}`)

  const details = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const root = document.querySelector('.wb-panel') ?? [...document.querySelectorAll('.wb-root')].pop()
      if (!root) return { found: false }
      return {
        found: true,
        kpis: [...root.querySelectorAll('.wb-kpi-value')].map((node) => node.textContent),
        status: (root.querySelector('.wb-status') || {}).textContent || '',
        heatMaxCells: root.querySelectorAll('.wb-heat-cell').length,
        bars: root.querySelectorAll('.wb-bar').length,
        legend: [...root.querySelectorAll('.wb-legend-item')].length,
      }
    })()`,
    returnByValue: true,
  })
  console.log(JSON.stringify(details.result.value, null, 2))
  console.log('workbench requests:', JSON.stringify(requests.filter((entry) => entry.url.includes('dsh-workbench'))))
  if (consoleErrors.length > 0) {
    console.log('console errors:')
    for (const error of consoleErrors.slice(0, 10)) console.log('  -', String(error).split('\n')[0].slice(0, 300))
  } else {
    console.log('console errors: none')
  }
  exitCode = String(panelState).startsWith('ready') ? 0 : 1
  cdp.close()
} catch (error) {
  console.log(`FAILED: ${String(error?.message ?? error)}`)
  if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 10).join('\n'))
} finally {
  chrome.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true })
}
process.exit(exitCode)
