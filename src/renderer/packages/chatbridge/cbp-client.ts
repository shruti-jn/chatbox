/**
 * CBP Client for the Chatbox frontend
 *
 * Handles postMessage communication with sandboxed iframe apps.
 * Origin validation, message parsing, state update forwarding.
 */

import { CBPMessageSchema, CBP_MAX_MESSAGE_SIZE } from '@chatbridge/shared'
import type { CBPMessage, CBPStateUpdate } from '@chatbridge/shared'

type StateUpdateHandler = (instanceId: string, state: Record<string, unknown>) => void
type CompletionHandler = (instanceId: string, result: Record<string, unknown>) => void

const allowedOrigins = new Set<string>()

// --- App iframe registry ---------------------------------------------------
const appIframes = new Map<string, HTMLIFrameElement>()

export function registerAppIframe(instanceId: string, iframe: HTMLIFrameElement): void {
  appIframes.set(instanceId, iframe)
}

export function unregisterAppIframe(instanceId: string): void {
  appIframes.delete(instanceId)
}

// --- WebSocket bridge per instance -----------------------------------------
const appWebSockets = new Map<string, WebSocket>()

export function connectAppInstance(instanceId: string, wsUrl: string, token: string): void {
  const url = `${wsUrl}?token=${token}&instanceId=${instanceId}`
  const ws = new WebSocket(url)

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string)
    // Forward CBP commands from backend to iframe
    if (msg.method === 'command') {
      const iframe = appIframes.get(instanceId)
      if (iframe) {
        sendCommand(iframe, instanceId, msg.params?.command ?? 'unknown', msg.params ?? {})
      }
    }
  }

  ws.onclose = () => {
    appWebSockets.delete(instanceId)
  }

  appWebSockets.set(instanceId, ws)
}

export function disconnectAppInstance(instanceId: string): void {
  const ws = appWebSockets.get(instanceId)
  if (ws) {
    ws.close()
    appWebSockets.delete(instanceId)
  }
}

export function addAllowedOrigin(origin: string) {
  allowedOrigins.add(origin)
}

let onStateUpdate: StateUpdateHandler | null = null
let onCompletion: CompletionHandler | null = null

export function setStateUpdateHandler(handler: StateUpdateHandler) {
  onStateUpdate = handler
}

export function setCompletionHandler(handler: CompletionHandler) {
  onCompletion = handler
}

/**
 * Initialize CBP listener for iframe messages
 */
export function initCBPListener() {
  window.addEventListener('message', (event) => {
    // Origin validation
    if (allowedOrigins.size > 0 && !allowedOrigins.has(event.origin) && event.origin !== window.location.origin) {
      console.warn('[CBP] Rejected message from unknown origin:', event.origin)
      return
    }

    const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)

    // Size check before JSON parse
    if (raw.length > CBP_MAX_MESSAGE_SIZE) {
      console.warn('[CBP] Message exceeds 64KB limit')
      return
    }

    try {
      const msg = JSON.parse(raw)
      const result = CBPMessageSchema.safeParse(msg)
      if (!result.success) return // Not a CBP message

      handleCBPMessage(result.data)
    } catch {
      // Not a JSON message — ignore
    }
  })
}

function handleCBPMessage(msg: CBPMessage) {
  if (msg.method === 'state_update') {
    const params = msg.params as { instance_id: string; state: Record<string, unknown> }
    if (!params?.instance_id || !params?.state) return

    // Check for completion signal
    if (params.state.completed) {
      onCompletion?.(params.instance_id, params.state)
    } else {
      onStateUpdate?.(params.instance_id, params.state)
    }

    // Forward to backend via WS
    const ws = appWebSockets.get(params.instance_id)
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'app_state_update',
        instanceId: params.instance_id,
        state: params.state,
      }))
    }
  }
}

/**
 * Send a command to an app iframe
 */
export function sendCommand(
  iframe: HTMLIFrameElement,
  instanceId: string,
  command: string,
  params: Record<string, unknown> = {},
) {
  const msg = {
    jsonrpc: '2.0',
    method: 'command',
    params: {
      instance_id: instanceId,
      command,
      ...params,
    },
  }

  iframe.contentWindow?.postMessage(JSON.stringify(msg), '*')
}

/**
 * Send a lifecycle event to an app iframe
 */
export function sendLifecycleEvent(
  iframe: HTMLIFrameElement,
  instanceId: string,
  event: 'suspend' | 'resume' | 'terminate',
) {
  const msg = {
    jsonrpc: '2.0',
    method: 'lifecycle',
    params: {
      instance_id: instanceId,
      event,
    },
  }

  iframe.contentWindow?.postMessage(JSON.stringify(msg), '*')
}
