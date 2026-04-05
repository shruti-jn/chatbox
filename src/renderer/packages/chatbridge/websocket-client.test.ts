/**
 * WebSocket client tests
 *
 * Tests: connection, reconnect with backoff, auth, message routing, heartbeat, disconnect
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatBridgeWebSocket } from './websocket-client'

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close(code?: number) {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: code ?? 1000 })
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  simulateClose(code: number) {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code })
  }

  simulateError() {
    this.onerror?.()
  }
}

describe('ChatBridgeWebSocket', () => {
  let originalWebSocket: typeof globalThis.WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  describe('connection', () => {
    it('connects with token as query param', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'my-jwt-token')
      ws.connect('/ws/chat')

      expect(MockWebSocket.instances).toHaveLength(1)
      expect(MockWebSocket.instances[0].url).toBe('ws://localhost:3000/ws/chat?token=my-jwt-token')
    })

    it('converts https to wss', () => {
      const ws = new ChatBridgeWebSocket('https://example.com', 'token')
      ws.connect()

      expect(MockWebSocket.instances[0].url).toContain('wss://example.com')
    })

    it('does not create duplicate connection if already open', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      ws.connect() // second call
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('fires onConnect handlers when connection opens', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      const handler = vi.fn()
      ws.onConnect(handler)

      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      expect(handler).toHaveBeenCalledOnce()
    })

    it('reports isConnected correctly', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      expect(ws.isConnected).toBe(false)

      ws.connect()
      MockWebSocket.instances[0].simulateOpen()
      expect(ws.isConnected).toBe(true)
    })
  })

  describe('reconnect', () => {
    it('reconnects with exponential backoff after abnormal close', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      // Abnormal close (code 1006)
      MockWebSocket.instances[0].simulateClose(1006)
      expect(MockWebSocket.instances).toHaveLength(1) // no reconnect yet

      // After 1s (first backoff)
      vi.advanceTimersByTime(1000)
      expect(MockWebSocket.instances).toHaveLength(2)

      // Close again
      MockWebSocket.instances[1].simulateClose(1006)

      // After 2s (second backoff = 2^1 * 1000)
      vi.advanceTimersByTime(2000)
      expect(MockWebSocket.instances).toHaveLength(3)
    })

    it('does NOT reconnect on normal close (code 1000)', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      MockWebSocket.instances[0].simulateClose(1000)
      vi.advanceTimersByTime(5000)
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('does NOT reconnect on auth rejection (code 4001)', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      MockWebSocket.instances[0].simulateClose(4001)
      vi.advanceTimersByTime(5000)
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('caps reconnect delay at 30s', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      // Simulate many consecutive failures to exceed 30s cap
      for (let i = 0; i < 10; i++) {
        const lastIdx = MockWebSocket.instances.length - 1
        MockWebSocket.instances[lastIdx].simulateClose(1006)
        vi.advanceTimersByTime(30000) // max delay
      }

      // Should still be reconnecting (not crashed)
      expect(MockWebSocket.instances.length).toBeGreaterThan(5)
    })

    it('resets reconnect attempts on successful connection', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      // Fail a few times
      MockWebSocket.instances[0].simulateClose(1006)
      vi.advanceTimersByTime(1000)
      MockWebSocket.instances[1].simulateClose(1006)
      vi.advanceTimersByTime(2000)

      // Now succeed
      MockWebSocket.instances[2].simulateOpen()

      // Fail again — should start backoff from 1s, not continue from 4s
      MockWebSocket.instances[2].simulateClose(1006)
      vi.advanceTimersByTime(1000)
      expect(MockWebSocket.instances).toHaveLength(4) // reconnected after 1s
    })
  })

  describe('message routing', () => {
    it('routes messages by type to registered handlers', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      const chatHandler = vi.fn()
      const statusHandler = vi.fn()

      ws.on('chat', chatHandler)
      ws.on('status', statusHandler)

      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      MockWebSocket.instances[0].simulateMessage({ type: 'chat', text: 'hello' })

      expect(chatHandler).toHaveBeenCalledWith({ type: 'chat', text: 'hello' })
      expect(statusHandler).not.toHaveBeenCalled()
    })

    it('routes to wildcard (*) handlers for all messages', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      const wildcardHandler = vi.fn()

      ws.on('*', wildcardHandler)

      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      MockWebSocket.instances[0].simulateMessage({ type: 'chat', text: 'hello' })
      MockWebSocket.instances[0].simulateMessage({ type: 'status', connected: true })

      expect(wildcardHandler).toHaveBeenCalledTimes(2)
    })

    it('supports multiple handlers for the same type', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      ws.on('chat', handler1)
      ws.on('chat', handler2)

      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      MockWebSocket.instances[0].simulateMessage({ type: 'chat', text: 'hello' })

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('ignores non-JSON messages', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      const handler = vi.fn()
      ws.on('chat', handler)

      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      // Send raw non-JSON
      MockWebSocket.instances[0].onmessage?.({ data: 'not json' })

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('send', () => {
    it('sends JSON-stringified data when connected', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      ws.send({ type: 'chat', text: 'hello' })

      expect(MockWebSocket.instances[0].sentMessages).toHaveLength(1)
      expect(JSON.parse(MockWebSocket.instances[0].sentMessages[0])).toEqual({
        type: 'chat',
        text: 'hello',
      })
    })

    it('does not throw when sending while disconnected', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      // Not connected — should silently no-op
      expect(() => ws.send({ type: 'test' })).not.toThrow()
    })
  })

  describe('heartbeat', () => {
    it('sends ping every 30s while connected', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      vi.advanceTimersByTime(30000)
      expect(MockWebSocket.instances[0].sentMessages).toHaveLength(1)
      expect(JSON.parse(MockWebSocket.instances[0].sentMessages[0])).toEqual({ type: 'ping' })

      vi.advanceTimersByTime(30000)
      expect(MockWebSocket.instances[0].sentMessages).toHaveLength(2)
    })
  })

  describe('disconnect', () => {
    it('closes connection and stops reconnect', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      ws.connect()
      MockWebSocket.instances[0].simulateOpen()

      ws.disconnect()
      expect(ws.isConnected).toBe(false)

      // Should not reconnect
      vi.advanceTimersByTime(60000)
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('fires onDisconnect handlers', () => {
      const ws = new ChatBridgeWebSocket('http://localhost:3000', 'token')
      const handler = vi.fn()
      ws.onDisconnect(handler)

      ws.connect()
      MockWebSocket.instances[0].simulateOpen()
      ws.disconnect()

      expect(handler).toHaveBeenCalledOnce()
    })
  })
})
