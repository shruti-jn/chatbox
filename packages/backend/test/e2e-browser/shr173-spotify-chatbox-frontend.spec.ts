import { test, expect, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const WEB_URL = 'http://localhost:3000'
const JWT_SECRET = process.env.JWT_SECRET_KEY ?? 'dev-secret-change-in-production'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge'

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })

function sign(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
}

async function seedRendererSession(page: Page, sessionId: string, accessToken: string) {
  await page.evaluate(async ({ sid, token }) => {
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
          refreshToken: 'shr173-refresh-placeholder',
        },
        version: 0,
      }),
    )

    const write = (key: string, value: unknown) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('chatboxstore')
        req.onerror = () => reject(req.error)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('keyvaluepairs')) {
            db.createObjectStore('keyvaluepairs')
          }
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('keyvaluepairs', 'readwrite')
          tx.objectStore('keyvaluepairs').put(JSON.stringify(value), key)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      })

    const read = (key: string) =>
      new Promise<any>((resolve, reject) => {
        const req = indexedDB.open('chatboxstore')
        req.onerror = () => reject(req.error)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('keyvaluepairs')) {
            db.createObjectStore('keyvaluepairs')
          }
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('keyvaluepairs', 'readonly')
          const getReq = tx.objectStore('keyvaluepairs').get(key)
          getReq.onsuccess = () => resolve(getReq.result)
          getReq.onerror = () => reject(getReq.error)
        }
      })

    const now = Date.now()
    const session = {
      id: sid,
      name: 'SHR-173 Spotify Frontend Handoff',
      type: 'chat',
      messages: [
        {
          id: 'shr173-assistant-app-card',
          role: 'assistant',
          timestamp: now,
          content: '',
          contentParts: [
            { type: 'text', text: 'Connect Spotify to continue your playlist request.' },
            {
              type: 'app-card',
              appId: '00000000-0000-4000-e000-000000000003',
              appName: 'Music Lab',
              instanceId: '00000000-0000-4000-8000-000000000173',
              status: 'active',
              url: 'http://localhost:3001/api/v1/apps/spotify/ui/',
              height: 400,
            },
          ],
        },
      ],
      settings: {
        provider: 'chatbridge',
        modelId: 'chatbridge-haiku',
        maxContextMessageCount: Number.MAX_SAFE_INTEGER,
      },
    }

    const sessionMeta = [{ id: sid, name: session.name, type: 'chat' }]
    const settingsRaw = await read('settings')
    const settings = typeof settingsRaw === 'string' ? JSON.parse(settingsRaw) : {}
    settings.startupPage = 'session'

    await Promise.all([
      write(`session:${sid}`, session),
      write('chat-sessions-list', sessionMeta),
      write('settings', settings),
    ])
  }, { sid: sessionId, token: accessToken })
}

let districtId: string
let teacherId: string
let studentId: string
let classroomId: string
let conversationId: string
let studentToken: string

test.beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: 'SHR173 Spotify Frontend' } })
  districtId = district.id

  const teacher = await prisma.user.create({
    data: { districtId, role: 'teacher', displayName: 'SHR173 Teacher' },
  })
  teacherId = teacher.id

  const student = await prisma.user.create({
    data: { districtId, role: 'student', displayName: 'SHR173 Student', gradeBand: 'g68' },
  })
  studentId = student.id
  studentToken = sign({ userId: studentId, districtId, role: 'student', gradeBand: 'g68' })

  const classroom = await prisma.classroom.create({
    data: {
      districtId,
      teacherId,
      name: 'SHR173 Music Lab',
      joinCode: `S173-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      gradeBand: 'g68',
      aiConfig: { mode: 'direct', subject: 'general' },
    },
  })
  classroomId = classroom.id

  await prisma.classroomAppConfig.create({
    data: {
      classroomId,
      appId: '00000000-0000-4000-e000-000000000003',
      districtId,
      enabled: true,
    },
  })

  const conversation = await prisma.conversation.create({
    data: {
      districtId,
      classroomId,
      studentId,
    },
  })
  conversationId = conversation.id
})

test.afterAll(async () => {
  await prisma.message.deleteMany({ where: { conversationId } }).catch(() => {})
  await prisma.oAuthToken.deleteMany({ where: { userId: studentId, provider: 'spotify' } }).catch(() => {})
  await prisma.appInstance.deleteMany({ where: { conversationId } }).catch(() => {})
  await prisma.conversation.deleteMany({ where: { id: conversationId } }).catch(() => {})
  await prisma.classroomAppConfig.deleteMany({ where: { classroomId } }).catch(() => {})
  await prisma.classroom.deleteMany({ where: { id: classroomId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [studentId, teacherId] } } }).catch(() => {})
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {})
  await prisma.$disconnect()
})

test('SHR-173: Spotify app card in real Chatbox UI opens live Spotify OAuth popup', async ({ page }) => {
  test.setTimeout(120000)

  await page.goto(`${WEB_URL}/`)
  await page.waitForLoadState('networkidle')
  await seedRendererSession(page, conversationId, studentToken)
  await page.reload()

  await page.locator('[data-testid="virtuoso-item-list"] div.cursor-pointer').filter({ hasText: 'SHR-173 Spotify Frontend Handoff' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/session/${conversationId}$`))

  const iframe = page.locator('iframe[title="Music Lab app"]')
  await expect(iframe).toBeVisible({ timeout: 30000 })

  const frame = page.frameLocator('iframe[title="Music Lab app"]')
  await expect(frame.getByRole('heading', { name: 'Connect to Spotify' })).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: 'screenshots/shr173-chatbox-spotify-auth-prompt.png', fullPage: true })

  const popupPromise = page.waitForEvent('popup')
  await frame.getByRole('button', { name: 'Connect Spotify' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await expect(popup).toHaveURL(/accounts\.spotify\.com\/.*authorize/)
  await popup.screenshot({ path: 'screenshots/shr173-chatbox-spotify-oauth-popup.png', fullPage: true })
})
