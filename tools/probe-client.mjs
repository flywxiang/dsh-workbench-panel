/**
 * Report what happens to the workbench client bundle inside the real app page.
 *
 * The panel sometimes fails to appear even though the boot payload lists it. This
 * script serves the app's own index through `Page.setDocumentContent` — so the
 * page keeps the app origin, cookies, and `__DSH_BOOT__`, while an injected probe
 * reports the module loader state and any error at load time — then dumps the
 * probe text.
 *
 * Usage: node tools/probe-client.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const workbench = join(here, '..')

/** @returns {string} current server token. */
function currentToken() {
  const log = readFileSync(join(homedir(), '.dsh', 'launchd-dsh.out.log'), 'utf8')
  return [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)[1]
}

/** @returns {string} headless shell path. */
function headlessShell() {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('chromium_headless_shell-')) continue
    for (const arch of readdirSync(join(cache, entry))) {
      const candidate = join(cache, entry, arch, 'chrome-headless-shell')
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('no chrome-headless-shell found')
}

const token = currentToken()
const html = readFileSync(join(workbench, 'out', 'index-live.html'), 'utf8')
const probe = `
<script>
(function () {
  var report = [];
  var errors = [];
  window.addEventListener('error', function (event) { errors.push('error: ' + String(event.message)); });
  window.addEventListener('unhandledrejection', function (event) { errors.push('rejection: ' + String(event.reason && event.reason.message || event.reason)); });
  var originalError = console.error;
  console.error = function () { errors.push('console.error: ' + Array.prototype.join.call(arguments, ' ')); originalError.apply(console, arguments); };
  function finish() {
    var node = document.createElement('pre');
    node.id = 'wb-probe';
    node.textContent = 'PROBE ' + report.join(' || ') + ' ###### ERRORS ' + (errors.join(' || ') || 'none');
    document.body.appendChild(node);
  }
  function run() {
    var loader = window.__ModuleLoader__;
    var boot = window.__DSH_BOOT__;
    var entry = boot && boot.entries.filter(function (e) { return e.id === 'dsh-workbench-panel'; })[0];
    report.push('entry=' + JSON.stringify(entry || null));
    report.push('loaderKeys=' + (loader ? Object.keys(loader).join(',') : 'none'));
    report.push('pendingQueue=' + (loader && loader.pendingQueue ? loader.pendingQueue.length : '?'));
    var resources = performance.getEntriesByType('resource')
      .map(function (r) { return r.name; })
      .filter(function (name) { return name.indexOf('workbench') >= 0; });
    report.push('resources=' + JSON.stringify(resources));
    var labels = Array.prototype.slice.call(document.querySelectorAll('button')).map(function (b) { return b.getAttribute('aria-label') || b.textContent.trim(); });
    report.push('buttons=' + JSON.stringify(labels.slice(0, 6)));
    // Load the workbench bundle directly and report whether it runs and applies.
    fetch('plugins/??dsh-workbench-panel/client.js&rev=8069c4647458', { credentials: 'same-origin' })
      .then(function (response) {
        report.push('bundleFetch=' + response.status);
        return response.text();
      })
      .then(function (source) {
        report.push('bundleBytes=' + source.length);
        var registrations = [];
        var fakeCtx = {
          effect: function (factory) { var cleanup = factory(); return function () { if (typeof cleanup === 'function') cleanup(); }; },
          locale: { register: function () { report.push('locale.register called'); }, bind: function () { return function (key) { return 't:' + key; }; } },
          slots: {
            inject: function (name) { report.push('slots.inject ' + name); },
            register: function (spec) { registrations.push(spec && spec.name + ':' + (spec && (spec.id || spec.key))); }
          }
        };
        var previous = window.__ModuleLoader__.load;
        window.__ModuleLoader__.load = function (spec) {
          report.push('load id=' + spec.id);
          var exports = spec.factory(function (name) {
            if (name === 'react') return {};
            report.push('require ' + name);
            return {};
          });
          report.push('exports=' + Object.keys(exports || {}).join(','));
          try {
            exports.apply(fakeCtx);
            report.push('registrations=' + registrations.join(','));
          } catch (error) {
            report.push('apply threw: ' + error.message);
          }
          return exports;
        };
        try {
          (0, eval)(source);
        } catch (error) {
          report.push('eval threw: ' + error.message);
        }
        window.__ModuleLoader__.load = previous;
        finish();
      })
      .catch(function (error) { report.push('bundle fetch failed: ' + error.message); finish(); });
  }
  if (document.readyState === 'complete') setTimeout(run, 4000);
  else window.addEventListener('load', function () { setTimeout(run, 4000); });
})();
</script>
`
const patched = html.replace('</head>', `${probe}</head>`)
const probePath = join(workbench, 'out', 'probe.html')
writeFileSync(probePath, patched)

const profile = mkdtempSync(join(tmpdir(), 'wb-probe-'))
const port = 9611 + Math.floor(Math.random() * 200)
const chrome = spawn(
  headlessShell(),
  ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

/** Tiny CDP client. */
class Cdp {
  /** @param {string} url - websocket url. */
  constructor(url) {
    this.socket = new WebSocket(url)
    this.id = 1
    this.pending = new Map()
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (entry !== undefined) {
        this.pending.delete(message.id)
        message.error === undefined ? entry.resolve(message.result) : entry.reject(new Error(JSON.stringify(message.error)))
      }
    })
  }
  /** @returns {Promise<void>} */
  ready() {
    return new Promise((resolve) => this.socket.addEventListener('open', () => resolve()))
  }
  /**
   * @param {string} method - CDP method.
   * @param {object} [params] - params.
   * @returns {Promise<any>} result.
   */
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
}

let exitCode = 1
try {
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
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:3080/?token=${token}` })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  await cdp.send('Page.setDocumentContent', { frameId: (await cdp.send('Page.getFrameTree')).frameTree.frame.id, html: patched })
  await new Promise((resolve) => setTimeout(resolve, 9000))
  const probeText = await cdp.send('Runtime.evaluate', {
    expression: `(document.getElementById('wb-probe') || {}).textContent || 'no probe output'`,
    returnByValue: true,
  })
  console.log(probeText.result.value)
  exitCode = 0
} catch (error) {
  console.log(`FAILED: ${String(error?.message ?? error)}`)
} finally {
  chrome.kill('SIGKILL')
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* chrome may still hold the profile; the temp dir is harmless */
  }
}
process.exit(exitCode)
