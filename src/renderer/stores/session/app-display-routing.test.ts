import { describe, expect, it } from 'vitest'
import type { Message, MessageAppCardPart } from '@shared/types'
import {
  collectAppCardsFromMessages,
  createInitialPanelWorkspaceState,
  derivePanelWorkspaceModel,
  minimizeActivePanelApp,
} from './app-display-routing'

function appCard(overrides: Partial<MessageAppCardPart>): MessageAppCardPart {
  return {
    type: 'app-card',
    appId: '11111111-1111-4111-8111-111111111111',
    appName: 'Chess',
    instanceId: '22222222-2222-4222-8222-222222222222',
    status: 'active',
    url: 'https://apps.chatbridge.example/chess',
    height: 500,
    displayMode: 'panel',
    ...overrides,
  }
}

function assistantMessage(id: string, parts: Message['contentParts']): Message {
  return {
    id,
    role: 'assistant',
    contentParts: parts,
    tokenCalculatedAt: undefined,
  }
}

describe('panel workspace routing', () => {
  it('collects app cards only from assistant messages', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        contentParts: [appCard({ appName: 'Ignored user app' })],
        tokenCalculatedAt: undefined,
      },
      assistantMessage('assistant-1', [appCard({ appName: 'Chess' })]),
    ]

    const cards = collectAppCardsFromMessages(messages)

    expect(cards).toHaveLength(1)
    expect(cards[0]?.appName).toBe('Chess')
  })

  it('routes panel apps into the workspace column while leaving inline apps in chat', () => {
    const messages = [
      assistantMessage('m1', [
        { type: 'text', text: 'Open the app.' },
        appCard({ appName: 'Chess', displayMode: 'panel' }),
        appCard({
          appId: '33333333-3333-4333-8333-333333333333',
          instanceId: '44444444-4444-4444-8444-444444444444',
          appName: 'Weather',
          displayMode: 'inline',
          url: 'https://apps.chatbridge.example/weather',
        }),
      ]),
    ]

    const model = derivePanelWorkspaceModel(messages, createInitialPanelWorkspaceState())

    expect(model.activePanelApp?.appName).toBe('Chess')
    expect(model.chatInlineApps).toHaveLength(1)
    expect(model.chatInlineApps[0]?.appName).toBe('Weather')
  })

  it('does not open inline apps in the workspace column', () => {
    const messages = [
      assistantMessage('m1', [
        appCard({
          appName: 'Weather',
          displayMode: 'inline',
          url: 'https://apps.chatbridge.example/weather',
        }),
      ]),
    ]

    const model = derivePanelWorkspaceModel(messages, createInitialPanelWorkspaceState())

    expect(model.activePanelApp).toBeUndefined()
    expect(model.chatInlineApps.map((app) => app.appName)).toEqual(['Weather'])
  })

  it('keeps a minimized panel app in the mini player with its state preserved', () => {
    const messages = [
      assistantMessage('m1', [
        appCard({
          appName: 'Chess',
          stateSnapshot: { fen: 'startpos', turn: 'white' },
        }),
      ]),
    ]

    const minimized = minimizeActivePanelApp(createInitialPanelWorkspaceState(), '22222222-2222-4222-8222-222222222222')
    const model = derivePanelWorkspaceModel(messages, minimized)

    expect(model.activePanelApp).toBeUndefined()
    expect(model.miniPlayerApps).toHaveLength(1)
    expect(model.miniPlayerApps[0]?.stateSnapshot).toEqual({ fen: 'startpos', turn: 'white' })
  })

  it('does not keep terminated panel apps in the mini player', () => {
    const messages = [
      assistantMessage('m1', [
        appCard({
          appName: 'Chess',
          status: 'terminated',
        }),
      ]),
    ]

    const model = derivePanelWorkspaceModel(messages, createInitialPanelWorkspaceState())

    expect(model.activePanelApp).toBeUndefined()
    expect(model.miniPlayerApps).toHaveLength(0)
  })

  it('moves the previously focused panel app into the mini player when a new panel app opens', () => {
    const messages = [
      assistantMessage('m1', [appCard({ appName: 'Chess' })]),
      assistantMessage('m2', [
        appCard({
          appId: '55555555-5555-4555-8555-555555555555',
          instanceId: '66666666-6666-4666-8666-666666666666',
          appName: 'Spotify',
          url: 'https://apps.chatbridge.example/spotify',
        }),
      ]),
    ]

    const model = derivePanelWorkspaceModel(messages, createInitialPanelWorkspaceState())

    expect(model.activePanelApp?.appName).toBe('Spotify')
    expect(model.miniPlayerApps.map((app) => app.appName)).toEqual(['Chess'])
  })
})
