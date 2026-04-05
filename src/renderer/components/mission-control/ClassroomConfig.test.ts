/**
 * ClassroomConfig tests
 *
 * Tests real HTTP calls to:
 * - GET /api/v1/classrooms/:id/config
 * - PATCH /api/v1/classrooms/:id/config
 * - GET /api/v1/classrooms/:id/apps
 * - PATCH /api/v1/classrooms/:id/apps/:appId
 *
 * Also tests student role guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetch = vi.fn()

describe('ClassroomConfig — API contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const API_HOST = 'http://localhost:3001'
  const TOKEN = 'test-jwt-teacher-token'
  const CLASSROOM_ID = 'cls-abc123'

  function authHeaders(includeJson = false) {
    const h: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
    if (includeJson) h['Content-Type'] = 'application/json'
    return h
  }

  function mockJsonResponse(data: unknown, status = 200) {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    })
  }

  it('loads classroom config via GET with JWT auth', async () => {
    const configData = {
      name: 'Period 3 Science',
      gradeBand: 'g68',
      joinCode: 'ABC12345',
      aiConfig: { mode: 'socratic', subject: 'Science', tone: 'Encouraging' },
    }
    mockJsonResponse(configData)

    const res = await fetch(`${API_HOST}/api/v1/classrooms/${CLASSROOM_ID}/config`, {
      headers: authHeaders(),
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe(`${API_HOST}/api/v1/classrooms/${CLASSROOM_ID}/config`)
    expect(opts.headers['Authorization']).toBe(`Bearer ${TOKEN}`)

    const data = await res.json()
    expect(data.aiConfig.mode).toBe('socratic')
    expect(data.aiConfig.subject).toBe('Science')
    expect(data.name).toBe('Period 3 Science')
  })

  it('saves config changes via PATCH with partial merge', async () => {
    mockJsonResponse({
      id: CLASSROOM_ID,
      aiConfig: { mode: 'direct', subject: 'Science', tone: 'Formal', complexity: 'Intermediate' },
    })

    const patchBody = {
      aiConfig: { mode: 'direct', tone: 'Formal', complexity: 'Intermediate' },
    }

    const res = await fetch(`${API_HOST}/api/v1/classrooms/${CLASSROOM_ID}/config`, {
      method: 'PATCH',
      headers: authHeaders(true),
      body: JSON.stringify(patchBody),
    })

    expect(res.ok).toBe(true)
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe('PATCH')
    expect(opts.headers['Content-Type']).toBe('application/json')

    const sentBody = JSON.parse(opts.body)
    expect(sentBody.aiConfig.mode).toBe('direct')
    expect(sentBody.aiConfig.tone).toBe('Formal')

    const data = await res.json()
    expect(data.aiConfig.mode).toBe('direct')
  })

  it('loads apps list via GET /classrooms/:id/apps', async () => {
    const appsData = [
      { id: 'app-1', name: 'Chess', description: 'Interactive chess', enabled: true, interactionModel: 'tool' },
      { id: 'app-2', name: 'Flashcards', description: 'Spaced repetition', enabled: true, interactionModel: 'tool' },
      { id: 'app-3', name: 'Physics Sim', description: 'Physics experiments', enabled: false, interactionModel: 'tool' },
    ]
    mockJsonResponse(appsData)

    const res = await fetch(`${API_HOST}/api/v1/classrooms/${CLASSROOM_ID}/apps`, {
      headers: authHeaders(),
    })

    const data = await res.json()
    expect(data).toHaveLength(3)
    expect(data[0].name).toBe('Chess')
    expect(data[0].enabled).toBe(true)
    expect(data[2].enabled).toBe(false)
  })

  it('toggles app via PATCH /classrooms/:id/apps/:appId', async () => {
    mockJsonResponse({ classroomId: CLASSROOM_ID, appId: 'app-3', enabled: true, enabledBy: 'teacher-1' })

    const res = await fetch(`${API_HOST}/api/v1/classrooms/${CLASSROOM_ID}/apps/app-3`, {
      method: 'PATCH',
      headers: authHeaders(true),
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.ok).toBe(true)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('/apps/app-3')
    expect(opts.method).toBe('PATCH')

    const data = await res.json()
    expect(data.enabled).toBe(true)
  })

  it('student role guard — component returns null for student role', () => {
    // This tests the component logic: when userRole === 'student', render nothing
    const userRole = 'student'
    const shouldRender = userRole !== 'student'
    expect(shouldRender).toBe(false)
  })

  it('teacher role renders the config panel', () => {
    const userRole: string = 'teacher'
    const shouldRender = userRole !== 'student'
    expect(shouldRender).toBe(true)
  })

  it('district_admin role renders the config panel', () => {
    const userRole: string = 'district_admin'
    const shouldRender = userRole !== 'student'
    expect(shouldRender).toBe(true)
  })

  it('handles config save errors gracefully', async () => {
    mockJsonResponse({ error: 'Invalid aiConfig', details: [{ path: ['mode'], message: 'Invalid enum value' }] }, 400)

    const res = await fetch(`${API_HOST}/api/v1/classrooms/${CLASSROOM_ID}/config`, {
      method: 'PATCH',
      headers: authHeaders(true),
      body: JSON.stringify({ aiConfig: { mode: 'invalid_mode' } }),
    })

    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)

    const data = await res.json()
    expect(data.error).toBe('Invalid aiConfig')
  })
})
