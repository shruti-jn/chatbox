import { beforeEach, describe, expect, it } from 'vitest'
import { settingsStore } from '../settingsStore'
import { processAppCards, resolveChatBridgeUrl } from './app-card-processor'

describe('processAppCards', () => {
  beforeEach(() => {
    settingsStore.setState((state) => {
      state.providers = {
        ...state.providers,
        chatbridge: {
          ...state.providers?.chatbridge,
          apiHost: 'http://localhost:3005',
        },
      }
    })
  })

  it('converts a persisted chess markdown link into an app-card part', () => {
    const result = processAppCards([
      {
        type: 'text',
        text: 'Here is the board:\n\n[Open Chess Board](http://127.0.0.1:3001/api/v1/apps/chess/ui/)',
      },
    ])

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'text', text: 'Here is the board:' })
    expect(result[1]).toMatchObject({
      type: 'app-card',
      appName: 'Chess',
      url: 'http://127.0.0.1:3001/api/v1/apps/chess/ui/',
      status: 'active',
      height: 500,
    })
  })

  it('inserts an app-card after a tool result with __cbApp metadata', () => {
    const result = processAppCards([
      {
        type: 'tool-call',
        state: 'result',
        toolCallId: 'tool-1',
        toolName: 'start_chess',
        args: {},
        result: {
          __cbApp: {
            appId: '11111111-1111-4111-8111-111111111111',
            appName: 'Chess',
            instanceId: '22222222-2222-4222-8222-222222222222',
            url: 'http://127.0.0.1:3001/api/v1/apps/chess/ui/',
            height: 500,
          },
        },
      },
    ])

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'tool-call', toolCallId: 'tool-1' })
    expect(result[1]).toMatchObject({
      type: 'app-card',
      appId: '11111111-1111-4111-8111-111111111111',
      appName: 'Chess',
      instanceId: '22222222-2222-4222-8222-222222222222',
      url: 'http://127.0.0.1:3001/api/v1/apps/chess/ui/',
      status: 'loading',
      height: 500,
    })
  })

  it('resolves relative app URLs against the configured ChatBridge API host', () => {
    expect(resolveChatBridgeUrl('/api/v1/apps/chess/ui/')).toBe('http://localhost:3005/api/v1/apps/chess/ui/')
  })

  it('uses the configured ChatBridge API host for __cbApp relative URLs', () => {
    const result = processAppCards([
      {
        type: 'tool-call',
        state: 'result',
        toolCallId: 'tool-2',
        toolName: 'start_chess',
        args: {},
        result: {
          __cbApp: {
            appId: '11111111-1111-4111-8111-111111111111',
            appName: 'Chess',
            instanceId: '22222222-2222-4222-8222-222222222222',
            url: '/api/v1/apps/chess/ui/',
            height: 500,
          },
        },
      },
    ])

    expect(result[1]).toMatchObject({
      type: 'app-card',
      url: 'http://localhost:3005/api/v1/apps/chess/ui/',
      status: 'loading',
    })
  })
})
