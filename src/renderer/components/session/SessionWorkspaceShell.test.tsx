// @vitest-environment jsdom

/// <reference path="./vitest-matchers.d.ts" />

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionWorkspaceShell } from './SessionWorkspaceShell'
import type { MessageAppCardPart } from '@shared/types'

expect.extend({
  toBeInTheDocument(received: unknown) {
    const pass = received instanceof HTMLElement
      ? received.ownerDocument.contains(received)
      : false

    return {
      pass,
      message: () =>
        pass ? 'expected element not to be in the document' : 'expected element to be in the document',
    }
  },
})

function panelApp(overrides: Partial<MessageAppCardPart> = {}): MessageAppCardPart {
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

describe('SessionWorkspaceShell', () => {
  it('renders the split-pane workspace with a center app panel and chat rail', () => {
    render(
      <SessionWorkspaceShell
        activePanelApp={panelApp()}
        miniPlayerApps={[]}
        onFocusApp={vi.fn()}
        onMinimizeApp={vi.fn()}
        onRestoreApp={vi.fn()}
      >
        <div data-testid="chat-column">chat</div>
      </SessionWorkspaceShell>
    )

    expect(screen.getByTestId('session-workspace-shell')).toBeInTheDocument()
    expect(screen.getByTestId('session-app-panel')).toBeInTheDocument()
    expect(screen.getByTestId('chat-column')).toBeInTheDocument()
    expect(screen.getByTitle('Chess panel')).toBeInTheDocument()
  })

  it('renders the app panel header controls for the active workspace app', () => {
    render(
      <SessionWorkspaceShell
        activePanelApp={panelApp()}
        miniPlayerApps={[]}
        onFocusApp={vi.fn()}
        onMinimizeApp={vi.fn()}
        onRestoreApp={vi.fn()}
      >
        <div>chat</div>
      </SessionWorkspaceShell>
    )

    expect(screen.getByRole('button', { name: /minimize chess/i })).toBeInTheDocument()
  })

  it('shows a mini player strip when a panel app is backgrounded', () => {
    render(
      <SessionWorkspaceShell
        activePanelApp={undefined}
        miniPlayerApps={[panelApp({ status: 'collapsed', summary: 'Current game in progress' })]}
        onFocusApp={vi.fn()}
        onMinimizeApp={vi.fn()}
        onRestoreApp={vi.fn()}
      >
        <div>chat</div>
      </SessionWorkspaceShell>
    )

    expect(screen.getByTestId('session-mini-player')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /resume chess/i })).toBeInTheDocument()
  })

  it('keeps chat full-width when there is no active or backgrounded panel app', () => {
    render(
      <SessionWorkspaceShell
        activePanelApp={undefined}
        miniPlayerApps={[]}
        onFocusApp={vi.fn()}
        onMinimizeApp={vi.fn()}
        onRestoreApp={vi.fn()}
      >
        <div data-testid="chat-column">chat</div>
      </SessionWorkspaceShell>
    )

    expect(screen.queryByTestId('session-app-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-mini-player')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-column')).toBeInTheDocument()
  })
})
