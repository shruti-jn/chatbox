import type { ModelDependencies } from '@shared/types/adapters'
import type { ProviderModelInfo } from '@shared/types/settings'
import type { SentryScope } from '@shared/utils/sentry_adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatBridgeModel from './chatbridge'

function createDependencies(): ModelDependencies {
  return {
    request: {
      apiRequest: vi.fn(),
      fetchWithOptions: vi.fn(),
    },
    storage: {
      saveImage: vi.fn(),
      getImage: vi.fn(),
    },
    sentry: {
      captureException: vi.fn(),
      withScope: vi.fn((callback: (scope: SentryScope) => void) =>
        callback({
          setTag: vi.fn(),
          setExtra: vi.fn(),
        })
      ),
    },
    getRemoteConfig: vi.fn(),
  }
}

function createModel() {
  const model: ProviderModelInfo = {
    modelId: 'chatbridge-haiku',
    type: 'chat',
    capabilities: ['tool_use'],
  }

  return new ChatBridgeModel(
    {
      apiHost: 'http://localhost:3001',
      apiKey: 'jwt-token',
      model,
    },
    createDependencies(),
  )
}

function createSseResponse(chunks: string[]) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })

  return {
    ok: true,
    status: 200,
    body: stream,
    text: async () => chunks.join(''),
  }
}

describe('ChatBridgeModel', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts to the native ChatBridge completions endpoint with conversationId', async () => {
    const model = createModel()
    mockFetch.mockResolvedValueOnce(createSseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop","finishReason":"stop"}\n\n',
    ]))

    const result = await model.chat([{ role: 'user', content: 'Hi there' }], {
      sessionId: 'conv-123',
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:3001/api/v1/chatbridge/completions')
    expect(init.headers.Authorization).toBe('Bearer jwt-token')
    expect(JSON.parse(init.body)).toEqual({
      conversationId: 'conv-123',
      messages: [{ role: 'user', content: 'Hi there' }],
    })
    expect(result.contentParts).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('converts custom app-card events into app-card content parts', async () => {
    const model = createModel()
    mockFetch.mockResolvedValueOnce(createSseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Board ready. "}}\n\n',
      'event: chatbridge_app_card\ndata: {"type":"app_card","appId":"550e8400-e29b-41d4-a716-446655440000","appName":"Chess","instanceId":"550e8400-e29b-41d4-a716-446655440001","url":"https://apps.chatbridge.example/chess","height":500,"status":"active"}\n\n',
      'event: message_stop\ndata: {"type":"message_stop","finishReason":"stop"}\n\n',
    ]))

    const onResultChange = vi.fn()
    const result = await model.chat([{ role: 'user', content: 'Let us play chess' }], {
      sessionId: 'conv-456',
      onResultChange,
    })

    expect(onResultChange).toHaveBeenCalled()
    expect(result.contentParts).toEqual([
      { type: 'text', text: 'Board ready. ' },
      {
        type: 'app-card',
        appId: '550e8400-e29b-41d4-a716-446655440000',
        appName: 'Chess',
        instanceId: '550e8400-e29b-41d4-a716-446655440001',
        url: 'https://apps.chatbridge.example/chess',
        height: 500,
        status: 'active',
      },
    ])
  })
})
