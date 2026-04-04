/**
 * CBP Client Layer 4 Tests — WebSocket ↔ iframe postMessage bridge
 *
 * Tests the frontend bridge that connects backend WebSocket messages
 * to sandboxed iframe apps via postMessage, and forwards iframe
 * state_update messages back to the backend over WebSocket.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- MockWebSocket -----------------------------------------------------------
// jsdom has no WebSocket, so we provide a minimal mock that captures
// constructor args, lets us simulate incoming messages, and records sends/closes.

type WSMessageHandler = ((event: { data: string }) => void) | null
type WSCloseHandler = (() => void) | null

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  url: string
  readyState: number
  onmessage: WSMessageHandler = null
  onclose: WSCloseHandler = null
  sentMessages: string[] = []
  closed = false

  constructor(url: string) {
    this.url = url
    this.readyState = 1 // OPEN
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.closed = true
    this.readyState = 3 // CLOSED
    this.onclose?.()
  }

  // Test helper: simulate a message arriving from the server
  _simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

// Stub the global WebSocket before importing the module under test
vi.stubGlobal('WebSocket', MockWebSocket)

// Now import the module under test
import {
  registerAppIframe,
  unregisterAppIframe,
  connectAppInstance,
  disconnectAppInstance,
  initCBPListener,
  addAllowedOrigin,
} from './cbp-client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  // jsdom iframes don't have a real contentWindow with postMessage,
  // so we spy on it by assigning a mock.
  Object.defineProperty(iframe, 'contentWindow', {
    value: { postMessage: vi.fn() },
    writable: true,
  })
  return iframe
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CBP Client — Layer 4: WS ↔ iframe bridge', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  afterEach(() => {
    // Disconnect any leftover connections
    MockWebSocket.instances.forEach((ws) => {
      if (!ws.closed) ws.close()
    })
  })

  // ---- iframe registry ----------------------------------------------------

  describe('registerAppIframe / unregisterAppIframe', () => {
    it('stores an iframe ref that connectAppInstance can later look up', () => {
      const iframe = makeIframe()
      const instanceId = 'inst-001'

      registerAppIframe(instanceId, iframe)

      // Prove it's stored: connect a WS and send a command — the iframe should receive it
      connectAppInstance(instanceId, 'ws://localhost:3000', 'tok')
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]

      ws._simulateMessage({ method: 'command', params: { command: 'ping' } })

      // If the iframe was NOT registered, postMessage would not be called
      expect(iframe.contentWindow!.postMessage).toHaveBeenCalled()

      // Cleanup
      disconnectAppInstance(instanceId)
      unregisterAppIframe(instanceId)
    })

    it('unregisterAppIframe removes the iframe so commands no longer forward', () => {
      const iframe = makeIframe()
      const instanceId = 'inst-002'

      registerAppIframe(instanceId, iframe)
      unregisterAppIframe(instanceId)

      // Connect WS and send command — should NOT reach iframe
      connectAppInstance(instanceId, 'ws://localhost:3000', 'tok')
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]

      ws._simulateMessage({ method: 'command', params: { command: 'ping' } })

      expect(iframe.contentWindow!.postMessage).not.toHaveBeenCalled()

      disconnectAppInstance(instanceId)
    })
  })

  // ---- connectAppInstance -------------------------------------------------

  describe('connectAppInstance', () => {
    it('creates a WebSocket with the correct URL including token and instanceId', () => {
      connectAppInstance('inst-100', 'ws://localhost:4000', 'my-token')

      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      expect(ws).toBeDefined()
      expect(ws.url).toBe('ws://localhost:4000?token=my-token&instanceId=inst-100')

      disconnectAppInstance('inst-100')
    })
  })

  // ---- disconnectAppInstance ----------------------------------------------

  describe('disconnectAppInstance', () => {
    it('closes the WebSocket and removes it from the registry', () => {
      connectAppInstance('inst-200', 'ws://localhost:4000', 'tok')
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      expect(ws.closed).toBe(false)

      disconnectAppInstance('inst-200')

      expect(ws.closed).toBe(true)
    })

    it('is safe to call for an instance that was never connected', () => {
      // Should not throw
      expect(() => disconnectAppInstance('nonexistent')).not.toThrow()
    })
  })

  // ---- WS command -> iframe forwarding ------------------------------------

  describe('WS message forwarding to iframe', () => {
    it('forwards method=command messages to the registered iframe via sendCommand', () => {
      const iframe = makeIframe()
      registerAppIframe('inst-300', iframe)
      connectAppInstance('inst-300', 'ws://localhost:4000', 'tok')

      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws._simulateMessage({
        method: 'command',
        params: { command: 'set_theme', value: 'dark' },
      })

      // sendCommand posts a JSON-RPC message to iframe contentWindow
      expect(iframe.contentWindow!.postMessage).toHaveBeenCalledTimes(1)
      const posted = JSON.parse(
        (iframe.contentWindow!.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0],
      )
      expect(posted.jsonrpc).toBe('2.0')
      expect(posted.method).toBe('command')
      expect(posted.params.command).toBe('set_theme')
      expect(posted.params.instance_id).toBe('inst-300')

      disconnectAppInstance('inst-300')
      unregisterAppIframe('inst-300')
    })

    it('does not throw if no iframe is registered for the instance', () => {
      connectAppInstance('inst-301', 'ws://localhost:4000', 'tok')
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]

      // Should silently ignore — no iframe registered
      expect(() =>
        ws._simulateMessage({
          method: 'command',
          params: { command: 'ping' },
        }),
      ).not.toThrow()

      disconnectAppInstance('inst-301')
    })
  })

  // ---- iframe state_update -> WS forwarding --------------------------------

  describe('iframe state_update forwarded to WS', () => {
    it('forwards state_update from handleCBPMessage to the connected WebSocket', () => {
      const iframe = makeIframe()
      registerAppIframe('inst-400', iframe)
      connectAppInstance('inst-400', 'ws://localhost:4000', 'tok')

      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      expect(ws.sentMessages).toHaveLength(0)

      // Initialize the CBP listener and allow the test origin
      addAllowedOrigin('http://localhost')
      initCBPListener()

      // Dispatch a state_update message as if it came from the iframe
      const stateUpdateMsg = {
        jsonrpc: '2.0',
        method: 'state_update',
        params: {
          instance_id: 'inst-400',
          state: { score: 42, turn: 'black' },
        },
      }

      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify(stateUpdateMsg),
          origin: 'http://localhost',
        }),
      )

      // The WS should have received the forwarded message
      expect(ws.sentMessages).toHaveLength(1)
      const forwarded = JSON.parse(ws.sentMessages[0])
      expect(forwarded.type).toBe('app_state_update')
      expect(forwarded.instanceId).toBe('inst-400')
      expect(forwarded.state).toEqual({ score: 42, turn: 'black' })

      disconnectAppInstance('inst-400')
      unregisterAppIframe('inst-400')
    })
  })

  // ---- onclose cleanup ----------------------------------------------------

  describe('WebSocket onclose cleanup', () => {
    it('removes the WebSocket from the registry when the server closes the connection', () => {
      connectAppInstance('inst-500', 'ws://localhost:4000', 'tok')
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]

      // Simulate server-initiated close
      ws.onclose?.()

      // Trying to disconnect again should be a no-op (already removed)
      // We verify by checking that no additional close() is called on the ws
      const closeSpy = vi.spyOn(ws, 'close')
      disconnectAppInstance('inst-500')
      expect(closeSpy).not.toHaveBeenCalled()
    })
  })
})
