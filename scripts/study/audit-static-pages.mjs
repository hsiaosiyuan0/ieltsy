import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve('dist')
const SCREENSHOT_DIR = join(ROOT, '.audit')
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const chromePath = chromeCandidates.find((path) => existsSync(path))
if (!chromePath) throw new Error('Chrome/Chromium not found. Set CHROME_PATH to run design:audit.')
if (!existsSync(join(ROOT, 'index.html'))) throw new Error('dist/index.html not found. Run pnpm pages:build first.')

const latestLesson = readdirSync(join(ROOT, 'days'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .at(-1)
if (!latestLesson) throw new Error('No generated lesson page found in dist/days.')
const latestLessonPath = `/days/${latestLesson}/`

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.mp3': 'audio/mpeg',
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

function startStaticServer() {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)
    const requested = pathname.endsWith('/') ? pathname + 'index.html' : pathname
    const relativePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '')
    let file = resolve(ROOT, relativePath)

    if (!file.startsWith(ROOT)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    if (!existsSync(file) || !statSync(file).isFile()) file = join(ROOT, '404.html')

    response.writeHead(file.endsWith('404.html') && relativePath !== '404.html' ? 404 : 200, {
      'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    createReadStream(file).pipe(response)
  })

  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveServer({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.socket = new WebSocket(url)
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }

      const listeners = this.listeners.get(message.method) || []
      for (const listener of listeners) listener(message.params)
    })
  }

  send(method, params = {}) {
    return new Promise((resolveResult, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve: resolveResult, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method, timeoutMs = 10000) {
    return new Promise((resolveEvent, reject) => {
      const timeout = setTimeout(() => {
        this.off(method, handler)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      const handler = (params) => {
        clearTimeout(timeout)
        this.off(method, handler)
        resolveEvent(params)
      }
      this.on(method, handler)
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  off(method, listener) {
    const listeners = this.listeners.get(method) || []
    this.listeners.set(method, listeners.filter((item) => item !== listener))
  }

  close() {
    this.socket.close()
  }
}

async function waitForChrome(port) {
  const endpoint = `http://127.0.0.1:${port}/json/version`
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(endpoint)
      if (response.ok) return response.json()
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('Chrome debugging endpoint did not start')
}

async function openPage(debugPort, url, width, height) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
  if (!response.ok) throw new Error(`Unable to create Chrome target: ${response.status}`)
  const target = await response.json()
  const cdp = new CdpClient(target.webSocketDebuggerUrl)
  await cdp.open()
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Log.enable'),
    cdp.send('Network.enable'),
  ])
  const errors = []
  cdp.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails?.text || 'Runtime exception'))
  cdp.on('Log.entryAdded', (event) => {
    if (event.entry?.level === 'error') errors.push(event.entry.text)
  })
  cdp.on('Network.loadingFailed', (event) => {
    if (!event.canceled) errors.push(`Network failed: ${event.errorText}`)
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 768,
    screenWidth: width,
    screenHeight: height,
  })
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url })
  await loaded
  return { cdp, targetId: target.id, errors }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed')
  return result.result?.value
}

const auditExpression = String.raw`(() => {
  const root = document.documentElement
  const controls = [...document.querySelectorAll('button, a.button, .nav-tab')]
  const clippedControls = controls.filter((control) =>
    control.scrollWidth > control.clientWidth + 1 || control.scrollHeight > control.clientHeight + 1
  ).map((control) => ({
    tag: control.tagName.toLowerCase(),
    className: control.className,
    text: control.textContent.trim().replace(/\s+/g, ' ').slice(0, 80),
    client: [control.clientWidth, control.clientHeight],
    scroll: [control.scrollWidth, control.scrollHeight],
  }))

  const outsideElements = [...document.querySelectorAll('body *')].filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1)
  }).slice(0, 12).map((element) => {
    const rect = element.getBoundingClientRect()
    return {
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === 'string' ? element.className : '',
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
    }
  })

  const wideScrollBoxes = [...document.querySelectorAll('body *')].filter((element) =>
    element.scrollWidth > element.clientWidth + 1
  ).slice(0, 12).map((element) => ({
    tag: element.tagName.toLowerCase(),
    className: typeof element.className === 'string' ? element.className : '',
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }))

  const bodyPage = document.body.dataset.page || ''
  const vocabEntries = document.querySelectorAll('.vocab-entry').length
  const definitions = document.querySelectorAll('.vocab-definition').length
  const missingDefinitions = document.querySelectorAll('.definition-missing').length
  const targetWords = document.querySelectorAll('.target').length
  const translations = document.querySelectorAll('.sentence__translation').length
  const main = document.querySelector('main#content')
  const readingSheet = document.querySelector('.reading-sheet')
  const annotationRail = document.querySelector('.annotation-rail')

  return {
    page: bodyPage,
    title: document.title,
    viewport: [innerWidth, innerHeight],
    documentWidth: root.scrollWidth,
    horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
    outsideElements,
    wideScrollBoxes,
    clippedControls,
    landmarks: {
      masthead: Boolean(document.querySelector('.masthead')),
      main: Boolean(main),
      footer: Boolean(document.querySelector('.site-footer')),
    },
    lesson: {
      vocabEntries,
      definitions,
      missingDefinitions,
      targetWords,
      translations,
      translationHidden: document.body.classList.contains('hide-zh'),
      readingWidth: readingSheet ? Math.round(readingSheet.getBoundingClientRect().width) : 0,
      annotationWidth: annotationRail ? Math.round(annotationRail.getBoundingClientRect().width) : 0,
    },
  }
})()`

const interactionExpression = String.raw`(() => {
  const zh = document.querySelector('[data-action="toggle-zh"]')
  const practice = document.querySelector('[data-action="toggle-practice"]')
  const done = document.querySelector('[data-action="mark-done"]')
  const grammarTab = document.querySelector('[data-tab="grammar"]')
  zh?.click()
  practice?.click()
  done?.click()
  grammarTab?.click()

  return {
    translationVisible: !document.body.classList.contains('hide-zh') && zh?.getAttribute('aria-pressed') === 'true',
    practiceActive: document.body.classList.contains('practice') && practice?.getAttribute('aria-pressed') === 'true',
    doneActive: done?.getAttribute('aria-pressed') === 'true',
    grammarSelected: grammarTab?.getAttribute('aria-selected') === 'true',
    grammarPanelVisible: !document.querySelector('[data-panel="grammar"]')?.hidden,
    wordsPanelHidden: Boolean(document.querySelector('[data-panel="words"]')?.hidden),
  }
})()`

const cases = [
  { name: 'home-1440', path: '/', page: 'home', width: 1440, height: 1000 },
  { name: 'home-1024', path: '/', page: 'home', width: 1024, height: 900 },
  { name: 'home-375', path: '/', page: 'home', width: 375, height: 812 },
  { name: 'lesson-1440', path: latestLessonPath, page: 'lesson', width: 1440, height: 1050 },
  { name: 'lesson-768', path: latestLessonPath, page: 'lesson', width: 768, height: 1024 },
  { name: 'lesson-375', path: latestLessonPath, page: 'lesson', width: 375, height: 812 },
  { name: 'mistakes-1440', path: '/mistakes/', page: 'mistakes', width: 1440, height: 900 },
  { name: 'mistakes-375', path: '/mistakes/', page: 'mistakes', width: 375, height: 812 },
  { name: 'mistake-detail-1024', path: '/mistakes/words.html', page: 'mistake-detail', width: 1024, height: 900 },
  { name: 'mistake-detail-375', path: '/mistakes/words.html', page: 'mistake-detail', width: 375, height: 812 },
  { name: 'not-found-1024', path: '/404.html', page: 'not-found', width: 1024, height: 800 },
  { name: 'not-found-375', path: '/404.html', page: 'not-found', width: 375, height: 812 },
]

const failures = []
const results = []
let chrome
let staticServer
let userDataDir

function assert(condition, message) {
  if (!condition) failures.push(message)
}

try {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true })
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  staticServer = await startStaticServer()
  const debugPort = await availablePort()
  userDataDir = mkdtempSync(join(tmpdir(), 'ieltsy-chrome-'))
  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' })

  await waitForChrome(debugPort)

  for (const testCase of cases) {
    const { cdp, targetId, errors } = await openPage(
      debugPort,
      staticServer.baseUrl + testCase.path,
      testCase.width,
      testCase.height,
    )
    const metrics = await evaluate(cdp, auditExpression)
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    const screenshotPath = join(SCREENSHOT_DIR, testCase.name + '.png')
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

    assert(metrics.page === testCase.page, `${testCase.name}: expected data-page ${testCase.page}, got ${metrics.page}`)
    assert(!metrics.horizontalOverflow, `${testCase.name}: document width ${metrics.documentWidth} exceeds viewport ${testCase.width}; outside=${JSON.stringify(metrics.outsideElements)}; scroll=${JSON.stringify(metrics.wideScrollBoxes)}`)
    assert(metrics.clippedControls.length === 0, `${testCase.name}: clipped controls ${JSON.stringify(metrics.clippedControls)}`)
    assert(Object.values(metrics.landmarks).every(Boolean), `${testCase.name}: missing page landmark`)
    assert(errors.length === 0, `${testCase.name}: ${errors.join('; ')}`)
    assert(readFileSync(screenshotPath).length > 10000, `${testCase.name}: screenshot appears blank`)

    if (testCase.page === 'lesson') {
      assert(metrics.lesson.targetWords > 0, `${testCase.name}: target words are missing`)
      assert(metrics.lesson.vocabEntries === metrics.lesson.definitions, `${testCase.name}: vocabulary/definition mismatch`)
      assert(metrics.lesson.missingDefinitions === 0, `${testCase.name}: unresolved Chinese definition`)
      assert(metrics.lesson.translations > 0 && metrics.lesson.translationHidden, `${testCase.name}: translations must exist and start hidden`)
    }

    results.push({ name: testCase.name, screenshotPath, metrics })
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    cdp.close()
  }

  const interactionPage = await openPage(debugPort, staticServer.baseUrl + latestLessonPath, 1280, 900)
  const interactions = await evaluate(interactionPage.cdp, interactionExpression)
  assert(Object.values(interactions).every(Boolean), `lesson-interactions: ${JSON.stringify(interactions)}`)
  await interactionPage.cdp.send('Target.closeTarget', { targetId: interactionPage.targetId }).catch(() => {})
  interactionPage.cdp.close()

  for (const result of results) {
    const { metrics } = result
    console.log(
      `✓ ${result.name.padEnd(22)} ${String(metrics.documentWidth).padStart(4)}px document · ${result.screenshotPath}`
    )
  }

  if (failures.length > 0) {
    console.error(`\nDesign browser audit failed (${failures.length})`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log(`\n✓ Browser audit: ${results.length} viewport renders and lesson interactions passed`)
  }
} finally {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolveExit) => chrome.once('exit', resolveExit))
    chrome.kill('SIGTERM')
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))])
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
  }
  if (staticServer?.server) await new Promise((resolveClose) => staticServer.server.close(resolveClose))
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
