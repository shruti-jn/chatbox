import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { _electron as electron } from 'playwright'

const outputDir = '/Users/shruti/Software/chatbox/output/playwright/shr121-electron'
const userDataDir = path.join(os.tmpdir(), `chatbox-shr121-electron-${Date.now()}`)
const conversationId = crypto.randomUUID()
const appUrl = process.env.SHR121_ELECTRON_APP_URL ?? 'http://localhost:1212'

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function seedSession(page, sessionId) {
  await page.evaluate(async ({ sid }) => {
    localStorage.setItem('_currentSessionIdCachedAtom', JSON.stringify(sid))
    localStorage.setItem(
      'last-used-model',
      JSON.stringify({
        state: { chat: { provider: 'chatbridge', modelId: 'chatbridge-haiku' } },
        version: 0,
      }),
    )

    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('chatboxstore')
      req.onerror = () => reject(req.error)
      req.onupgradeneeded = () => {
        const upgradeDb = req.result
        if (upgradeDb.objectStoreNames.contains('keyvaluepairs') === false) {
          upgradeDb.createObjectStore('keyvaluepairs')
        }
      }
      req.onsuccess = () => resolve(req.result)
    })

    const write = (key, value) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('keyvaluepairs', 'readwrite')
        tx.objectStore('keyvaluepairs').put(JSON.stringify(value), key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })

    await write(`session:${sid}`, {
      id: sid,
      name: 'SHR121 Electron E2E',
      type: 'chat',
      messages: [],
      settings: {
        provider: 'chatbridge',
        modelId: 'chatbridge-haiku',
        maxContextMessageCount: Number.MAX_SAFE_INTEGER,
      },
    })
    await write('chat-sessions-list', [{ id: sid, name: 'SHR121 Electron E2E', type: 'chat' }])
    await write('settings', { startupPage: 'session' })
    db.close()
  }, { sid: sessionId })
}

async function saveShot(page, name) {
  const target = path.join(outputDir, name)
  await page.screenshot({ path: target, fullPage: true })
  return target
}

async function clickSquare(frame, square) {
  const col = 'abcdefgh'.indexOf(square[0])
  const row = 8 - Number.parseInt(square[1], 10)
  const index = row * 8 + col
  await frame.locator('#board .square').nth(index).click({ force: true })
}

await ensureDir(outputDir)

const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    NODE_ENV: 'development',
    ELECTRON_RENDERER_URL: appUrl,
    USE_LOCAL_API: 'true',
  },
})

const window = await app.firstWindow()
await window.setViewportSize({ width: 1600, height: 1000 })
await window.goto(appUrl, { waitUntil: 'networkidle' })

await saveShot(window, '01-home.png')
await seedSession(window, conversationId)
await window.reload({ waitUntil: 'networkidle' })

await window.getByText('SHR121 Electron E2E').first().click()
await window.getByTestId('message-input').waitFor({ timeout: 30000 })
await saveShot(window, '02-session-open.png')

await window.getByTestId('message-input').fill('lets play chess')
await saveShot(window, '03-before-send.png')
await window.getByTestId('message-input').press('Enter')

await window.locator('iframe[title*="Chess Tutor"]').waitFor({ timeout: 45000 })
await saveShot(window, '04-chess-inline.png')

const chessFrame = window.frameLocator('iframe[title*="Chess Tutor"]')
await chessFrame.locator('#board .square').first().waitFor({ timeout: 15000 })
await clickSquare(chessFrame, 'e2')
await clickSquare(chessFrame, 'e4')
await saveShot(window, '05-after-move.png')

await window.getByTestId('message-input').fill('What was my last move in chess?')
await window.getByTestId('message-input').press('Enter')
await window.locator('text=/e4|your last move/i').last().waitFor({ timeout: 45000 })
await saveShot(window, '06-readback.png')

await fs.writeFile(
  path.join(outputDir, 'run-metadata.json'),
  JSON.stringify({
    conversationId,
    screenshots: [
      '01-home.png',
      '02-session-open.png',
      '03-before-send.png',
      '04-chess-inline.png',
      '05-after-move.png',
      '06-readback.png',
    ],
  }, null, 2),
)

console.log(JSON.stringify({ conversationId, outputDir }, null, 2))

await app.close()
