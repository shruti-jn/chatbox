import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const slug = process.env.TEACHER_FLOW_PLUGIN_SLUG
if (!slug) {
  throw new Error('TEACHER_FLOW_PLUGIN_SLUG is required')
}
const webBaseUrl = 'http://localhost:1212'
const backendApiHost = 'http://localhost:3005'

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve('output/playwright/teacher-registry-flow', runId)
const screenshotDir = path.join(outDir, 'screenshots')
const videoDir = path.join(outDir, 'video')
await mkdir(screenshotDir, { recursive: true })
await mkdir(videoDir, { recursive: true })

const logStep = (message) => {
  console.log(`[teacher-flow] ${message}`)
}

async function seedIndexedDbState(page, apiHost) {
  await page.evaluate(async (host) => {
    const databases = indexedDB.databases ? await indexedDB.databases() : []
    const existing = databases.find((db) => db.name === 'chatboxstore') ?? databases[0] ?? { name: 'chatboxstore' }

    const putValue = (key, value) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(existing.name)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('keyvaluepairs')) {
            db.createObjectStore('keyvaluepairs')
          }
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const storeName = db.objectStoreNames.contains('keyvaluepairs')
            ? 'keyvaluepairs'
            : db.objectStoreNames[0]
          if (!storeName) {
            db.close()
            reject(new Error('indexeddb_store_missing'))
            return
          }
          const tx = db.transaction(storeName, 'readwrite')
          tx.objectStore(storeName).put(JSON.stringify(value), key)
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      })

    await putValue('onboarding-completed', true)
    await putValue('settings', {
      providers: {
        chatbridge: { apiHost: host },
        openai: { apiKey: 'sk-demo-placeholder' },
      },
      __version: 14,
    })
  }, apiHost)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 1024 } },
})
const page = await context.newPage()
page.setDefaultTimeout(15000)
page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.stack || error.message}`))

const captureFailure = async (name) => {
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true }).catch(() => {})
  const html = await page.content().catch(() => '')
  if (html) {
    console.log(`[teacher-flow] failure-html-snippet=${html.slice(0, 2000)}`)
  }
}

await page.addInitScript(() => {
  localStorage.setItem('settings', JSON.stringify({
    providers: { chatbridge: { apiHost: 'http://localhost:3005' } },
    state: { providers: { chatbridge: { apiHost: 'http://localhost:3005' } } },
  }))
})

let videoPath = null
try {
  logStep('open login')
  await page.goto(`${webBaseUrl}/login`, { waitUntil: 'domcontentloaded' })
  await seedIndexedDbState(page, backendApiHost)
  await page.evaluate((apiHost) => {
    localStorage.setItem('settings', JSON.stringify({
      providers: { chatbridge: { apiHost } },
      state: { providers: { chatbridge: { apiHost } } },
    }))
  }, backendApiHost)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.splash-screen', { state: 'hidden' }).catch(() => {})
  await page.screenshot({ path: path.join(screenshotDir, '01-login.png'), fullPage: true })

  logStep('submit teacher login')
  const loginResult = await page.evaluate(async (apiHost) => {
    const res = await fetch(`${apiHost}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'teacher-sync-demo@chatbridge.test', password: 'dev-mode1' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.token) {
      return { ok: false, status: res.status, data }
    }

    localStorage.setItem('chatbridge:teacher_jwt', data.token)
    localStorage.setItem('chatbridge:teacher_user', JSON.stringify({
      role: data.role,
      displayName: data.displayName,
    }))
    localStorage.setItem('settings', JSON.stringify({
      providers: { chatbridge: { apiHost } },
      state: { providers: { chatbridge: { apiHost } } },
    }))

    return { ok: true }
  }, backendApiHost)
  if (!loginResult?.ok) {
    throw new Error(`browser_login_failed:${JSON.stringify(loginResult)}`)
  }
  await seedIndexedDbState(page, backendApiHost)
  await page.goto(`${webBaseUrl}/mission-control/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.splash-screen', { state: 'hidden', timeout: 10000 }).catch(() => {})
  await page.waitForFunction(() => document.body.innerText.includes('Mission Control'), null, { timeout: 15000 })

  logStep('open teacher apps config')
  await page.getByTestId('nav-settings').click({ force: true })
  await page.getByTestId('config-tab-apps').click({ force: true })
  await page.waitForSelector('[data-testid="config-apps-panel"]')
  await page.waitForFunction((pluginSlug) => {
    const text = document.body.innerText
    return text.includes('Teacher Flow Demo') && text.includes(pluginSlug)
  }, slug)
  await page.screenshot({ path: path.join(screenshotDir, '02-app-visible-in-teacher-view.png'), fullPage: true })

  logStep('disable app in teacher view')
  const row = page.locator('[data-testid="app-row"]').filter({ hasText: slug }).first()
  await row.scrollIntoViewIfNeeded()
  await row.locator('input[type="checkbox"]').evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('app_toggle_not_found')
    }
    input.checked = false
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: path.join(screenshotDir, '03-app-disabled-by-teacher.png'), fullPage: true })

  logStep('suspend app in developer platform')
  const suspendResponse = await fetch(`https://developer-platform-production.up.railway.app/api/v1/admin/plugins/${slug}/suspend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'codex-demo', reason: 'teacher flow flagging demo' }),
  })
  if (!suspendResponse.ok) {
    throw new Error(`suspend_failed:${suspendResponse.status}:${await suspendResponse.text()}`)
  }

  logStep('reload teacher apps config after suspension')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.splash-screen', { state: 'hidden', timeout: 10000 }).catch(() => {})
  await page.getByTestId('nav-settings').click({ force: true })
  await page.getByTestId('config-tab-apps').click({ force: true })
  await page.waitForSelector('[data-testid="config-apps-panel"]')
  await page.waitForFunction((pluginSlug) => {
    const rows = Array.from(document.querySelectorAll('[data-testid="app-row"]'))
    return rows.every((row) => !row.textContent?.includes(pluginSlug))
  }, slug)
  await page.screenshot({ path: path.join(screenshotDir, '04-flagged-app-removed.png'), fullPage: true })
} catch (error) {
  await captureFailure('failure-state')
  throw error
} finally {
  const video = page.video()
  await context.close()
  await browser.close()
  videoPath = video ? await video.path().catch(() => null) : null
}

if (!videoPath) {
  throw new Error('video_not_available')
}

const gifPath = path.join(outDir, 'teacher-registry-flow.gif')
const ffmpeg = spawnSync('ffmpeg', [
  '-y',
  '-i',
  videoPath,
  '-vf',
  'fps=8,scale=960:-1:flags=lanczos',
  gifPath,
], { encoding: 'utf8' })
if (ffmpeg.status !== 0) {
  throw new Error(`ffmpeg_failed:${ffmpeg.stderr}`)
}

console.log(JSON.stringify({ outDir, gifPath }, null, 2))
