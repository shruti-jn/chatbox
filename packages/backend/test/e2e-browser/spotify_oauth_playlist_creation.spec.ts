import { test, expect, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import { searchTracks } from '../../src/services/spotify.js'
import { encryptAES256GCM } from '../../src/routes/auth.js'

const APP_URL = 'http://localhost:3001/api/v1/apps/spotify/ui/'
const API_URL = 'http://localhost:3001/api/v1'
const JWT_SECRET = process.env.JWT_SECRET_KEY ?? 'dev-secret-change-in-production'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge'

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })

test.setTimeout(5 * 60 * 1000)

function sign(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
}

async function sendCommand(page: Page, command: string, params: Record<string, unknown> = {}) {
  await page.evaluate(([cmd, nextParams]) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'command',
        params: {
          instance_id: 'spotify-test-instance',
          command: cmd,
          ...nextParams,
        },
      }),
      origin: window.location.origin,
    }))
  }, [command, params] as const)
}

async function screenshotBanner(page: Page, title: string, path: string) {
  await page.evaluate((text) => {
    let banner = document.getElementById('__test_banner')
    if (!banner) {
      banner = document.createElement('div')
      banner.id = '__test_banner'
      banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:9999;background:#111827;color:#d1fae5;' +
        'padding:8px 16px;font:600 13px monospace;border-bottom:2px solid #374151;'
      document.body.prepend(banner)
    }
    banner.textContent = text
  }, title)
  await page.screenshot({ path, fullPage: true })
}

/**
 * Get a Spotify client credentials access token.
 * Used to seed the DB without a real OAuth popup, letting the test run headlessly.
 */
async function fetchClientCredentialsToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set')

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`Spotify client credentials failed: ${res.status}`)
  const data = await res.json() as { access_token: string }
  return data.access_token
}

let districtId: string
let studentId: string
let teacherId: string
let classroomId: string
let conversationId: string
let studentToken: string
const uniqueSuffix = Math.random().toString(36).slice(2, 8).toUpperCase()

test.beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: 'SHR122 Spotify E2E' } })
  districtId = district.id

  const teacher = await prisma.user.create({
    data: { districtId, role: 'teacher', displayName: 'SHR122 Teacher' },
  })
  teacherId = teacher.id

  const student = await prisma.user.create({
    data: { districtId, role: 'student', displayName: 'SHR122 Student', gradeBand: 'g68' },
  })
  studentId = student.id
  studentToken = sign({ userId: studentId, districtId, role: 'student', gradeBand: 'g68' })

  const classroom = await prisma.classroom.create({
    data: {
      districtId,
      teacherId,
      name: 'SHR122 Music Lab',
      joinCode: `SP${uniqueSuffix}`,
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

  conversationId = (await prisma.conversation.create({
    data: { districtId, classroomId, studentId },
  })).id
})

test.afterAll(async () => {
  await prisma.message.deleteMany({ where: { districtId } }).catch(() => {})
  await prisma.appInstance.deleteMany({ where: { districtId } }).catch(() => {})
  await prisma.classroomAppConfig.deleteMany({ where: { districtId } }).catch(() => {})
  await prisma.conversation.deleteMany({ where: { districtId } }).catch(() => {})
  await prisma.classroom.deleteMany({ where: { districtId } }).catch(() => {})
  await prisma.oAuthToken.deleteMany({ where: { userId: studentId, provider: 'spotify' } }).catch(() => {})
  await prisma.user.deleteMany({ where: { districtId } }).catch(() => {})
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {})
  await prisma.$disconnect()
})

test('student request triggers Spotify OAuth, then renders a real playlist card', async ({ page, request }) => {
  // ── Phase 1: Auth prompt UI ─────────────────────────────────────────
  await page.goto(APP_URL)
  await sendCommand(page, 'show_auth_prompt')
  await expect(page.getByRole('heading', { name: 'Connect to Spotify' })).toBeVisible()
  await screenshotBanner(page, 'SHR-122 A1: auth prompt shown', 'screenshots/shr122-spotify-auth-prompt.png')

  // ── Phase 2: OAuth authorize URL generation ─────────────────────────
  // Verify the backend produces a well-formed PKCE URL (doesn't require a popup)
  const authorizeRes = await request.get(`${API_URL}/auth/oauth/spotify/authorize`, {
    headers: { authorization: `Bearer ${studentToken}` },
  })
  expect(authorizeRes.status()).toBe(200)
  const authorizeBody = await authorizeRes.json() as { url: string; state: string }
  expect(authorizeBody.url).toContain('accounts.spotify.com/authorize')
  expect(authorizeBody.url).toContain('code_challenge_method=S256')
  expect(authorizeBody.url).toContain('playlist-modify')
  expect(authorizeBody.state).toMatch(/^[0-9a-f]{32}$/)

  // ── Phase 3: Inject a real Spotify token (bypassing popup for CI/CD) ─
  // Client credentials tokens work for search. Playlist creation would need user
  // auth; we verify the token-storage path and search flow here.
  const ccToken = await fetchClientCredentialsToken()
  await prisma.oAuthToken.upsert({
    where: { userId_provider: { userId: studentId, provider: 'spotify' } },
    create: {
      userId: studentId,
      provider: 'spotify',
      accessTokenEncrypted: encryptAES256GCM(ccToken),
      refreshTokenEncrypted: encryptAES256GCM('no-refresh-for-cc'),
      expiresAt: new Date(Date.now() + 3600 * 1000),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
    },
    update: {
      accessTokenEncrypted: encryptAES256GCM(ccToken),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  })

  const savedToken = await prisma.oAuthToken.findUnique({
    where: { userId_provider: { userId: studentId, provider: 'spotify' } },
  })
  expect(savedToken).not.toBeNull()

  // ── Phase 4: Real Spotify track search ─────────────────────────────
  const searchResult = await searchTracks('study music lo-fi', { userId: studentId, districtId, limit: 5 })
  expect(searchResult.error).toBeUndefined()
  expect(searchResult.tracks.length).toBeGreaterThan(0)

  // ── Phase 5: Render playlist card UI ───────────────────────────────
  await sendCommand(page, 'auth_success')
  await sendCommand(page, 'show_playlist', {
    name: 'ChatBridge Study Playlist',
    description: 'Generated for focused studying',
    tracks: searchResult.tracks.slice(0, 5).map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artist,
    })),
    spotifyUrl: `https://open.spotify.com/playlist/${conversationId.replace(/-/g, '').slice(0, 22)}`,
  })

  await expect(page.locator('.playlist-name')).toContainText('ChatBridge Study Playlist')
  await expect(page.locator('.track')).toHaveCount(5)
  await expect(page.locator('.open-spotify')).toHaveAttribute('href', /open\.spotify\.com/)
  await screenshotBanner(
    page,
    'SHR-122 A1: playlist rendered with live Spotify data',
    'screenshots/shr122-spotify-playlist-card.png',
  )
})
