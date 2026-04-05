import type { Message, MessageAppCardPart } from '@shared/types'
import { processAppCards } from './app-card-processor'

export interface PanelWorkspaceState {
  focusedInstanceId?: string
  minimizedInstanceIds: string[]
}

export interface PanelWorkspaceModel {
  activePanelApp?: MessageAppCardPart
  miniPlayerApps: MessageAppCardPart[]
  chatInlineApps: MessageAppCardPart[]
  panelApps: MessageAppCardPart[]
}

function isRenderableApp(app: MessageAppCardPart) {
  return app.status !== 'terminated' && app.status !== 'error'
}

export function createInitialPanelWorkspaceState(): PanelWorkspaceState {
  return {
    focusedInstanceId: undefined,
    minimizedInstanceIds: [],
  }
}

export function minimizeActivePanelApp(state: PanelWorkspaceState, instanceId: string): PanelWorkspaceState {
  if (state.minimizedInstanceIds.includes(instanceId)) {
    return {
      ...state,
      focusedInstanceId: state.focusedInstanceId === instanceId ? undefined : state.focusedInstanceId,
    }
  }

  return {
    focusedInstanceId: state.focusedInstanceId === instanceId ? undefined : state.focusedInstanceId,
    minimizedInstanceIds: [...state.minimizedInstanceIds, instanceId],
  }
}

export function focusPanelApp(state: PanelWorkspaceState, instanceId: string): PanelWorkspaceState {
  return {
    focusedInstanceId: instanceId,
    minimizedInstanceIds: state.minimizedInstanceIds.filter((id) => id !== instanceId),
  }
}

export function collectAppCardsFromMessages(messages: Message[]): MessageAppCardPart[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') {
      return []
    }

    return processAppCards(message.contentParts ?? []).flatMap((part) =>
      part.type === 'app-card' ? [part] : []
    )
  })
}

function dedupeLatestAppCards(cards: MessageAppCardPart[]): MessageAppCardPart[] {
  const latestByInstanceId = new Map<string, MessageAppCardPart>()
  for (const card of cards) {
    latestByInstanceId.set(card.instanceId, card)
  }
  return [...latestByInstanceId.values()]
}

export function derivePanelWorkspaceModel(
  messages: Message[],
  state: PanelWorkspaceState,
): PanelWorkspaceModel {
  const latestCards = dedupeLatestAppCards(collectAppCardsFromMessages(messages))
  const chatInlineApps = latestCards.filter((card) => card.displayMode !== 'panel' && isRenderableApp(card))
  const panelApps = latestCards.filter((card) => card.displayMode === 'panel' && isRenderableApp(card))

  if (panelApps.length === 0) {
    return {
      activePanelApp: undefined,
      miniPlayerApps: [],
      chatInlineApps,
      panelApps,
    }
  }

  const newestPanelApp = panelApps[panelApps.length - 1]
  const defaultFocusedId = newestPanelApp?.instanceId
  const focusedId = state.focusedInstanceId ?? defaultFocusedId
  const minimizedSet = new Set(state.minimizedInstanceIds)

  const activePanelApp = panelApps.find(
    (card) =>
      card.instanceId === focusedId &&
      card.status !== 'collapsed' &&
      card.status !== 'suspended' &&
      !minimizedSet.has(card.instanceId),
  )

  const miniPlayerApps = panelApps.filter((card) => {
    if (activePanelApp?.instanceId === card.instanceId) {
      return false
    }

    if (card.status === 'collapsed' || card.status === 'suspended') {
      return true
    }

    return minimizedSet.has(card.instanceId) || card.instanceId !== newestPanelApp.instanceId
  })

  return {
    activePanelApp,
    miniPlayerApps,
    chatInlineApps,
    panelApps,
  }
}
