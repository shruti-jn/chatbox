import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatBridgeApp } from '../src/index.js'

// Mock window + postMessage for Node test environment
function setupWindowMock() {
  const listeners: Array<(event: any) => void> = []
  const posted: Array<{ message: string; origin: string }> = []

  const mockWindow = {
    addEventListener: vi.fn((type: string, handler: any) => {
      if (type === 'message') listeners.push(handler)
    }),
    parent: {
      postMessage: vi.fn((message: string, origin: string) => {
        posted.push({ message, origin })
      }),
    },
  }

  // Assign to global
  ;(globalThis as any).window = mockWindow

  return {
    listeners,
    posted,
    mockWindow,
    dispatchMessage(data: any, origin = 'https://chatbridge.test') {
      for (const listener of listeners) {
        listener({ data, origin })
      }
    },
  }
}

describe('ChatBridgeApp', () => {
  let mock: ReturnType<typeof setupWindowMock>

  beforeEach(() => {
    mock = setupWindowMock()
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  it('initializes with default options', () => {
    const app = new ChatBridgeApp()
    expect(app).toBeDefined()
    expect(app.getInstanceId()).toBeNull()
  })

  it('supports fluent lifecycle hook registration methods', () => {
    const onActivate = vi.fn()
    const onSuspend = vi.fn()
    const onResume = vi.fn()
    const onTerminate = vi.fn()

    const app = new ChatBridgeApp()
      .onActivate(onActivate)
      .onSuspend(onSuspend)
      .onResume(onResume)
      .onTerminate(onTerminate)

    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'command',
      params: { command: 'set_instance_id', instance_id: 'inst-fluent' },
    }))
    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'lifecycle',
      params: { event: 'suspend' },
    }))
    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'lifecycle',
      params: { event: 'resume' },
    }))
    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'lifecycle',
      params: { event: 'terminate' },
    }))

    expect(app.getInstanceId()).toBe('inst-fluent')
    expect(onActivate).toHaveBeenCalledWith('inst-fluent')
    expect(onSuspend).toHaveBeenCalled()
    expect(onResume).toHaveBeenCalled()
    expect(onTerminate).toHaveBeenCalled()
  })

  it('initializes with custom allowed origins', () => {
    const app = new ChatBridgeApp({
      allowedOrigins: ['https://chatbridge.test'],
    })
    expect(app).toBeDefined()
    // Should have registered a message listener
    expect(mock.mockWindow.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('sendState produces correct JSON-RPC message', () => {
    const app = new ChatBridgeApp()
    app.sendState({ score: 100 })

    expect(mock.posted).toHaveLength(1)
    const parsed = JSON.parse(mock.posted[0].message)
    expect(parsed).toEqual({
      jsonrpc: '2.0',
      method: 'state_update',
      params: {
        instance_id: 'pending',
        state: { score: 100 },
      },
    })
  })

  it('sendStateUpdate is an alias for sendState and produces correct JSON-RPC', () => {
    const app = new ChatBridgeApp()
    app.sendStateUpdate({ level: 5 })

    expect(mock.posted).toHaveLength(1)
    const parsed = JSON.parse(mock.posted[0].message)
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.method).toBe('state_update')
    expect(parsed.params.state).toEqual({ level: 5 })
  })

  it('registerTool stores typed tool metadata without exposing raw postMessage', () => {
    const app = new ChatBridgeApp()

    app.registerTool({
      name: 'start_game',
      description: 'Start a game',
      inputSchema: { type: 'object' },
    })

    expect(app.getRegisteredTools()).toEqual([
      {
        name: 'start_game',
        description: 'Start a game',
        inputSchema: { type: 'object' },
      },
    ])
  })

  it('lifecycle hooks called on message events', () => {
    const onActivate = vi.fn()
    const onSuspend = vi.fn()
    const onResume = vi.fn()
    const onTerminate = vi.fn()

    const app = new ChatBridgeApp({
      onActivate,
      onSuspend,
      onResume,
      onTerminate,
    })

    // Activate via set_instance_id command
    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'command',
      params: { command: 'set_instance_id', instance_id: 'inst-123' },
    }))
    expect(onActivate).toHaveBeenCalledWith('inst-123')
    expect(app.getInstanceId()).toBe('inst-123')

    // Suspend
    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'lifecycle',
      params: { event: 'suspend' },
    }))
    expect(onSuspend).toHaveBeenCalled()

    // Resume
    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'lifecycle',
      params: { event: 'resume' },
    }))
    expect(onResume).toHaveBeenCalled()

    // Terminate
    mock.dispatchMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'lifecycle',
      params: { event: 'terminate' },
    }))
    expect(onTerminate).toHaveBeenCalled()
  })

  it('origin validation rejects messages from unknown origins', () => {
    const onActivate = vi.fn()

    const app = new ChatBridgeApp({
      allowedOrigins: ['https://chatbridge.test'],
      onActivate,
    })

    // Message from wrong origin should be ignored
    mock.dispatchMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'command',
        params: { command: 'set_instance_id', instance_id: 'inst-bad' },
      }),
      'https://evil.example.com',
    )

    expect(onActivate).not.toHaveBeenCalled()
    expect(app.getInstanceId()).toBeNull()

    // Message from correct origin should work
    mock.dispatchMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'command',
        params: { command: 'set_instance_id', instance_id: 'inst-good' },
      }),
      'https://chatbridge.test',
    )

    expect(onActivate).toHaveBeenCalledWith('inst-good')
  })

  it('postMessage uses configured origin instead of wildcard', () => {
    const app = new ChatBridgeApp({
      allowedOrigins: ['https://chatbridge.test'],
    })

    app.sendState({ data: 'test' })

    expect(mock.posted).toHaveLength(1)
    expect(mock.posted[0].origin).toBe('https://chatbridge.test')
  })

  it('postMessage uses wildcard when no specific origin configured', () => {
    const app = new ChatBridgeApp() // default: ['*']

    app.sendState({ data: 'test' })

    expect(mock.posted).toHaveLength(1)
    expect(mock.posted[0].origin).toBe('*')
  })

  it('ignores non-JSON-RPC messages gracefully', () => {
    const onActivate = vi.fn()
    const app = new ChatBridgeApp({ onActivate })

    // Non-JSON string
    mock.dispatchMessage('not json')
    expect(onActivate).not.toHaveBeenCalled()

    // JSON but not JSON-RPC
    mock.dispatchMessage(JSON.stringify({ type: 'other' }))
    expect(onActivate).not.toHaveBeenCalled()
  })
})
