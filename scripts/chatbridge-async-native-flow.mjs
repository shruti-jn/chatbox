import { chromium } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import crypto from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const WEB_URL = process.env.CHATBRIDGE_WEB_URL ?? 'http://localhost:1212'
const API_URL = process.env.CHATBRIDGE_API_URL ?? 'http://localhost:3001'
const DATABASE_URL = process.env.DATABASE_URL
const DEFAULT_DISTRICT_ID = '00000000-0000-4000-a000-000000000001'
const CHESS_APP_ID = '00000000-0000-4000-e000-000000000001'
const STUDENT_EMAIL = 'student-async-demo@chatbridge.test'
const STUDENT_PASSWORD = 'dev-mode1'
const STUDENT_ID = '11111111-1111-4111-8111-111111111123'

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required')
}

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve('output/playwright/chatbridge-async-native-flow', runId)
const screenshotDir = path.join(outDir, 'screenshots')
const videoDir = path.join(outDir, 'video')
await mkdir(screenshotDir, { recursive: true })
await mkdir(videoDir, { recursive: true })

function sha256(value) {
  return crypto.createHash('sha256').update(value.toLowerCase()).digest('hex')
}

function logStep(message) {
  console.log(`[chatbridge-async-flow] ${message}`)
}

async function seedAsyncDemoData() {
  const teacher = await prisma.user.findFirst({
    where: { districtId: DEFAULT_DISTRICT_ID, role: 'teacher' },
    orderBy: { createdAt: 'asc' },
  })
  if (!teacher) {
    throw new Error('No teacher found in default district')
  }

  const chess = await prisma.app.findFirst({
    where: {
      id: CHESS_APP_ID,
      reviewStatus: 'approved',
    },
  })
  if (!chess) {
    throw new Error('Built-in chess app not found')
  }

  let classroom = await prisma.classroom.findFirst({
    where: {
      districtId: DEFAULT_DISTRICT_ID,
      name: 'Async Browser Demo',
    },
  })

  if (!classroom) {
    classroom = await prisma.classroom.create({
      data: {
        districtId: DEFAULT_DISTRICT_ID,
        teacherId: teacher.id,
        name: 'Async Browser Demo',
        joinCode: 'ASYNC01',
        gradeBand: 'g68',
        aiConfig: { mode: 'direct', subject: 'general' },
      },
    })
  }

  const student = await prisma.user.upsert({
    where: { id: STUDENT_ID },
    update: {
      districtId: DEFAULT_DISTRICT_ID,
      role: 'student',
      displayName: 'Async Demo Student',
      gradeBand: 'g68',
      emailHash: sha256(STUDENT_EMAIL),
    },
    create: {
      id: STUDENT_ID,
      districtId: DEFAULT_DISTRICT_ID,
      role: 'student',
      displayName: 'Async Demo Student',
      gradeBand: 'g68',
      emailHash: sha256(STUDENT_EMAIL),
    },
  })

  const existingConfig = await prisma.classroomAppConfig.findFirst({
    where: { classroomId: classroom.id, appId: chess.id },
  })

  if (existingConfig) {
    await prisma.classroomAppConfig.update({
      where: { id: existingConfig.id },
      data: { enabled: true, districtId: DEFAULT_DISTRICT_ID },
    })
  } else {
    await prisma.classroomAppConfig.create({
      data: {
        classroomId: classroom.id,
        districtId: DEFAULT_DISTRICT_ID,
        appId: chess.id,
        enabled: true,
      },
    })
  }

  const conversation = await prisma.conversation.create({
    data: {
      districtId: DEFAULT_DISTRICT_ID,
      classroomId: classroom.id,
      studentId: student.id,
      title: `Async Native Chat ${runId}`,
    },
  })

  return {
    classroomId: classroom.id,
    conversationId: conversation.id,
    studentId: student.id,
  }
}

async function seedRendererState(page, { conversationId, accessToken, apiHost }) {
  await page.evaluate(async ({ sid, token, host }) => {
    const putValue = (key, value) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chatboxstore')
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('keyvaluepairs')) {
            db.createObjectStore('keyvaluepairs')
          }
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('keyvaluepairs', 'readwrite')
          tx.objectStore('keyvaluepairs').put(JSON.stringify(value), key)
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      })

    window.localStorage.setItem('_currentSessionIdCachedAtom', JSON.stringify(sid))
    window.localStorage.setItem(
      'last-used-model',
      JSON.stringify({
        state: {
          chat: {
            provider: 'chatbridge',
            modelId: 'chatbridge-haiku',
          },
        },
        version: 0,
      }),
    )
    window.localStorage.setItem(
      'chatbox-ai-auth-info',
      JSON.stringify({
        state: {
          accessToken: token,
          refreshToken: 'async-demo-refresh-token',
        },
        version: 0,
      }),
    )

    const session = {
      id: sid,
      name: 'Async Native ChatBridge Flow',
      type: 'chat',
      messages: [],
      settings: {
        provider: 'chatbridge',
        modelId: 'chatbridge-haiku',
        maxContextMessageCount: Number.MAX_SAFE_INTEGER,
      },
    }

    await Promise.all([
      putValue('onboarding-completed', true),
      putValue(`session:${sid}`, session),
      putValue('chat-sessions-list', [{ id: sid, name: session.name, type: 'chat' }]),
      putValue('settings', {
        providers: {
          chatbridge: { apiHost: host },
        },
        state: {
          providers: {
            chatbridge: { apiHost: host },
          },
        },
        startupPage: 'session',
      }),
    ])
  }, { sid: conversationId, token: accessToken, host: apiHost })
}

async function readStoredSession(page, conversationId) {
  return await page.evaluate(async (sid) => {
    const readValue = (key) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chatboxstore')
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('keyvaluepairs')) {
            db.createObjectStore('keyvaluepairs')
          }
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('keyvaluepairs', 'readonly')
          const getReq = tx.objectStore('keyvaluepairs').get(key)
          getReq.onsuccess = () => {
            db.close()
            const value = getReq.result
            resolve(typeof value === 'string' ? JSON.parse(value) : value)
          }
          getReq.onerror = () => reject(getReq.error)
        }
      })

    return await readValue(`session:${sid}`)
  }, conversationId)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 1024 } },
})
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.stack || error.message}`))

const captureFailure = async (name) => {
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true }).catch(() => {})
}

let videoPath = null
try {
  logStep('seed conversation and classroom state')
  const seeded = await seedAsyncDemoData()

  logStep('open app shell')
  await page.goto(WEB_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.splash-screen', { state: 'hidden', timeout: 15000 }).catch(() => {})

  logStep('login as seeded student through real auth endpoint')
  const loginResult = await page.evaluate(async ({ apiHost, email, password }) => {
    const res = await fetch(`${apiHost}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  }, { apiHost: API_URL, email: STUDENT_EMAIL, password: STUDENT_PASSWORD })

  if (!loginResult.ok || !loginResult.data?.token) {
    throw new Error(`student_login_failed:${JSON.stringify(loginResult)}`)
  }

  await seedRendererState(page, {
    conversationId: seeded.conversationId,
    accessToken: loginResult.data.token,
    apiHost: API_URL,
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.splash-screen', { state: 'hidden', timeout: 15000 }).catch(() => {})
  await page.screenshot({ path: path.join(screenshotDir, '01-seeded-session.png'), fullPage: true })

  logStep('open seeded session')
  await page.locator('[data-testid="virtuoso-item-list"] div.cursor-pointer').filter({ hasText: 'Async Native ChatBridge Flow' }).first().click()
  await page.waitForURL(new RegExp(`/session/${seeded.conversationId}$`))
  await page.getByTestId('message-input').waitFor()

  logStep('send native chess request')
  const input = page.getByTestId('message-input')
  await input.click()
  await input.fill("Let's play chess")
  await input.press('Enter')

  await page.waitForSelector('[data-testid="app-card"]', { timeout: 30000 })
  await page.screenshot({ path: path.join(screenshotDir, '02-app-card-pending.png'), fullPage: true })

  logStep('wait for async job completion in the backend')
  let job = null
  await expectPoll(async () => {
    const found = await prisma.appInvocationJob.findFirst({
      where: { conversationId: seeded.conversationId },
      orderBy: { createdAt: 'desc' },
    })
    job = found
    return found?.status ?? null
  }, ['completed', 'timed_out', 'failed'], 30000)

  if (!job || job.status !== 'completed') {
    throw new Error(`job_not_completed:${job ? JSON.stringify({ id: job.id, status: job.status, errorCode: job.errorCode }) : 'missing'}`)
  }

  logStep('wait for chess iframe to render')
  const iframe = page.locator('iframe[title="Chess Tutor app"], iframe[title="Chess app"]').first()
  await iframe.waitFor({ state: 'visible', timeout: 30000 })
  const frame = page.frameLocator('iframe[title="Chess Tutor app"], iframe[title="Chess app"]').first()
  await frame.locator('#board .square').first().waitFor({ timeout: 30000 })
  await page.screenshot({ path: path.join(screenshotDir, '03-chess-iframe-active.png'), fullPage: true })

  logStep('verify resumed assistant output reached renderer state')
  await expectPoll(async () => {
    const session = await readStoredSession(page, seeded.conversationId)
    const messages = Array.isArray(session?.messages) ? session.messages : []
    const assistantMessages = messages.filter((message) => message?.role === 'assistant')
    const lastAssistant = assistantMessages.at(-1)
    const parts = Array.isArray(lastAssistant?.contentParts) ? lastAssistant.contentParts : []
    const textPart = parts.find((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0)
    const appCard = parts.find((part) => part?.type === 'app-card')
    return Boolean(textPart && appCard)
  }, [true], 30000)

  await page.waitForFunction(() => {
    const body = document.body.innerText.toLowerCase()
    return body.includes('chess')
  }, null, { timeout: 15000 })
  await page.screenshot({ path: path.join(screenshotDir, '04-resumed-response-visible.png'), fullPage: true })

  logStep('verify backend saved assistant follow-up')
  await expectPoll(async () => {
    const assistantMessages = await prisma.message.findMany({
      where: {
        conversationId: seeded.conversationId,
        authorRole: 'assistant',
      },
      orderBy: { createdAt: 'asc' },
    })
    return assistantMessages.some((message) => {
      const parts = Array.isArray(message.contentParts) ? message.contentParts : []
      return parts.some((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0)
    })
  }, [true], 30000)
} catch (error) {
  await captureFailure('failure-state')
  throw error
} finally {
  const video = page.video()
  await context.close()
  await browser.close()
  videoPath = video ? await video.path().catch(() => null) : null
  await prisma.$disconnect()
}

if (!videoPath) {
  throw new Error('video_not_available')
}

const gifPath = path.join(outDir, 'chatbridge-async-native-flow.gif')
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

async function expectPoll(readFn, expectedValues, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await readFn()
    if (expectedValues.includes(value)) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`poll_timeout:${await readFn()}`)
}
