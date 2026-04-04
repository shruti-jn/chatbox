/**
 * Layer 2: WebSocket CBP Bridge Tests
 *
 * Tests the app instance connection registry and state update
 * forwarding via the WebSocket /ws/chat endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Redis from 'ioredis'

// We test the exported functions directly since Fastify WS testing
// with auth + COPPA is complex. The registry functions are the core
// unit under test.
import {
  hasActiveAppConnection,
  registerAppConnection,
  unregisterAppConnection,
  sendCommandToApp,
} from '../src/routes/websocket.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380'

describe('WebSocket CBP Bridge — Layer 2', () => {
  let helperRedis: Redis

  beforeAll(async () => {
    helperRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
    await helperRedis.connect()
  })

  afterAll(async () => {
    await helperRedis.quit()
  })

  // --- Connection Registry ---

  it('hasActiveAppConnection returns false for unknown instanceId', () => {
    expect(hasActiveAppConnection('nonexistent-instance')).toBe(false)
  })

  it('registerAppConnection makes hasActiveAppConnection return true', () => {
    const instanceId = `test-ws-${Date.now()}`
    const mockSocket = { send: () => {}, close: () => {} } as any

    registerAppConnection(instanceId, mockSocket)
    expect(hasActiveAppConnection(instanceId)).toBe(true)

    // Cleanup
    unregisterAppConnection(instanceId)
  })

  it('unregisterAppConnection makes hasActiveAppConnection return false', () => {
    const instanceId = `test-ws-unreg-${Date.now()}`
    const mockSocket = { send: () => {}, close: () => {} } as any

    registerAppConnection(instanceId, mockSocket)
    expect(hasActiveAppConnection(instanceId)).toBe(true)

    unregisterAppConnection(instanceId)
    expect(hasActiveAppConnection(instanceId)).toBe(false)
  })

  it('sendCommandToApp sends JSON to the registered socket', () => {
    const instanceId = `test-ws-send-${Date.now()}`
    const sent: string[] = []
    const mockSocket = {
      send: (data: string) => { sent.push(data) },
      close: () => {},
    } as any

    registerAppConnection(instanceId, mockSocket)

    const command = { jsonrpc: '2.0', method: 'command', params: { action: 'start' } }
    sendCommandToApp(instanceId, command)

    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0])).toEqual(command)

    // Cleanup
    unregisterAppConnection(instanceId)
  })

  it('sendCommandToApp returns false for unconnected instanceId', () => {
    const result = sendCommandToApp('no-such-instance', { action: 'test' })
    expect(result).toBe(false)
  })

  // --- Redis state publish via app_state_update ---

  it('app_state_update message publishes to Redis cbp:state:{instanceId}', async () => {
    const instanceId = `test-ws-state-${Date.now()}`
    const stateChannel = `cbp:state:${instanceId}`
    const statePayload = { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR', moveCount: 1 }

    // We import the handler function that processes app_state_update messages.
    // This is extracted as a testable function from the WS message handler.
    const { handleAppStateUpdate } = await import('../src/routes/websocket.js')

    // Subscribe to verify
    const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
    await subscriber.connect()

    const received = new Promise<string>((resolve) => {
      subscriber.subscribe(stateChannel, () => {
        subscriber.on('message', (_ch: string, msg: string) => {
          resolve(msg)
        })
      })
    })

    // Give subscription time
    await new Promise((r) => setTimeout(r, 100))

    await handleAppStateUpdate(instanceId, statePayload)

    const msg = await received
    expect(JSON.parse(msg)).toEqual(statePayload)

    await subscriber.quit()
  })
})
