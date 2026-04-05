/**
 * REST API client tests
 *
 * Tests: auth header injection, base URL config, typed endpoints, error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatBridgeRestClient } from './rest-client'

// Mock fetch
const mockFetch = vi.fn()

describe('ChatBridgeRestClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function createClient(token = 'test-jwt-token', baseUrl = 'http://localhost:3000') {
    return new ChatBridgeRestClient(baseUrl, token)
  }

  function mockJsonResponse(data: unknown, status = 200) {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    })
  }

  describe('auth header injection', () => {
    it('includes JWT Bearer token in all requests', async () => {
      const client = createClient('my-jwt-token')
      mockJsonResponse({ classrooms: [] })

      await client.getClassrooms()

      expect(mockFetch).toHaveBeenCalledOnce()
      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['Authorization']).toBe('Bearer my-jwt-token')
    })

    it('includes Content-Type application/json for POST/PUT', async () => {
      const client = createClient()
      mockJsonResponse({ id: '123', name: 'Math' })

      await client.createClassroom({ name: 'Math', gradeBand: 'g35' })

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['Content-Type']).toBe('application/json')
    })

    it('allows updating the token', async () => {
      const client = createClient('old-token')
      client.setToken('new-token')
      mockJsonResponse({ classrooms: [] })

      await client.getClassrooms()

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['Authorization']).toBe('Bearer new-token')
    })
  })

  describe('configurable base URL', () => {
    it('prepends base URL to all request paths', async () => {
      const client = createClient('token', 'https://api.chatbridge.example.com')
      mockJsonResponse({ classrooms: [] })

      await client.getClassrooms()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.chatbridge.example.com/api/v1/classrooms')
    })

    it('strips trailing slash from base URL', async () => {
      const client = createClient('token', 'http://localhost:3000/')
      mockJsonResponse({ classrooms: [] })

      await client.getClassrooms()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('http://localhost:3000/api/v1/classrooms')
    })
  })

  describe('classroom CRUD', () => {
    it('GET /classrooms returns list', async () => {
      const client = createClient()
      const classrooms = [
        { id: '1', name: 'Math 101', gradeBand: 'g35' },
        { id: '2', name: 'Science', gradeBand: 'g68' },
      ]
      mockJsonResponse({ classrooms })

      const result = await client.getClassrooms()

      expect(result.classrooms).toHaveLength(2)
      expect(result.classrooms[0].name).toBe('Math 101')
    })

    it('GET /classrooms/:id returns single classroom', async () => {
      const client = createClient()
      const classroom = { id: '1', name: 'Math 101', gradeBand: 'g35' }
      mockJsonResponse(classroom)

      const result = await client.getClassroom('1')

      expect(result.name).toBe('Math 101')
      const [url] = mockFetch.mock.calls[0]
      expect(url).toContain('/classrooms/1')
    })

    it('POST /classrooms creates classroom', async () => {
      const client = createClient()
      const created = { id: '3', name: 'History', gradeBand: 'g912' }
      mockJsonResponse(created, 201)

      const result = await client.createClassroom({ name: 'History', gradeBand: 'g912' })

      expect(result.id).toBe('3')
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toContain('/classrooms')
      expect(options.method).toBe('POST')
      expect(JSON.parse(options.body)).toEqual({ name: 'History', gradeBand: 'g912' })
    })

    it('PUT /classrooms/:id updates classroom', async () => {
      const client = createClient()
      const updated = { id: '1', name: 'Advanced Math', gradeBand: 'g912' }
      mockJsonResponse(updated)

      const result = await client.updateClassroom('1', { name: 'Advanced Math' })

      expect(result.name).toBe('Advanced Math')
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toContain('/classrooms/1')
      expect(options.method).toBe('PUT')
    })

    it('DELETE /classrooms/:id deletes classroom', async () => {
      const client = createClient()
      mockJsonResponse({ success: true })

      await client.deleteClassroom('1')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toContain('/classrooms/1')
      expect(options.method).toBe('DELETE')
    })
  })

  describe('error handling', () => {
    it('throws on non-OK response with status and message', async () => {
      const client = createClient()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'Unauthorized' }),
        json: async () => ({ message: 'Unauthorized' }),
      })

      await expect(client.getClassrooms()).rejects.toThrow('401')
    })

    it('throws on network error', async () => {
      const client = createClient()
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      await expect(client.getClassrooms()).rejects.toThrow('Network error')
    })
  })

  describe('health check', () => {
    it('GET /health returns status', async () => {
      const client = createClient()
      mockJsonResponse({ status: 'ok', capabilities: { ai: 'healthy', db: 'healthy' } })

      const result = await client.getHealth()

      expect(result.status).toBe('ok')
      const [url] = mockFetch.mock.calls[0]
      expect(url).toContain('/health')
    })
  })
})
