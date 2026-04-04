/**
 * @chatbridge/sdk — Developer SDK for building ChatBridge apps
 *
 * Provides:
 * - CBP client (postMessage wrapper with type safety)
 * - Lifecycle hooks (onActivate, onSuspend, onTerminate)
 * - State management helpers
 * - Type definitions from @chatbridge/shared
 */

import type { CBPMessage, CBPStateUpdate, CBPCommand } from '@chatbridge/shared'

export type LifecycleEvent = 'activate' | 'suspend' | 'resume' | 'terminate'

export interface ChatBridgeAppOptions {
  /** Allowed parent origins for postMessage validation */
  allowedOrigins?: string[]
  /** Called when the app should display its UI */
  onActivate?: (instanceId: string) => void
  /** Called when the app is being suspended (another app taking focus) */
  onSuspend?: () => void
  /** Called when the app is being resumed from suspension */
  onResume?: () => void
  /** Called when the app is being terminated */
  onTerminate?: () => void
  /** Called when a command is received from the platform */
  onCommand?: (command: string, params: Record<string, unknown>) => void
}

export class ChatBridgeApp {
  private instanceId: string | null = null
  private options: ChatBridgeAppOptions
  private allowedOrigins: Set<string>

  constructor(options: ChatBridgeAppOptions = {}) {
    this.options = options
    this.allowedOrigins = new Set(options.allowedOrigins ?? ['*'])
    this.setupListener()
  }

  private setupListener() {
    window.addEventListener('message', (event) => {
      // Origin validation
      if (!this.allowedOrigins.has('*') && !this.allowedOrigins.has(event.origin)) {
        return
      }

      try {
        const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
        const msg = JSON.parse(raw) as CBPMessage

        if (msg.jsonrpc !== '2.0') return

        if (msg.method === 'command') {
          const params = msg.params as Record<string, unknown>
          if (params.command === 'set_instance_id') {
            this.instanceId = params.instance_id as string
            this.options.onActivate?.(this.instanceId)
          } else {
            this.options.onCommand?.(params.command as string, params)
          }
        } else if (msg.method === 'lifecycle') {
          const params = msg.params as Record<string, unknown>
          const event = params.event as LifecycleEvent

          switch (event) {
            case 'suspend': this.options.onSuspend?.(); break
            case 'resume': this.options.onResume?.(); break
            case 'terminate': this.options.onTerminate?.(); break
          }
        }
      } catch {
        // Ignore non-CBP messages
      }
    })
  }

  /** Send a state update to the platform */
  sendState(state: Record<string, unknown>): void {
    this.send('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state,
    })
  }

  /** Alias for sendState (backwards compatibility) */
  sendStateUpdate(state: Record<string, unknown>): void {
    this.sendState(state)
  }

  /** Signal that the app has completed its task */
  signalCompletion(result: Record<string, unknown>): void {
    this.sendState({
      ...result,
      completed: true,
    })
  }

  /** Get the current instance ID */
  getInstanceId(): string | null {
    return this.instanceId
  }

  /** Get the configured target origin for postMessage */
  getTargetOrigin(): string {
    return this.targetOrigin
  }

  private get targetOrigin(): string {
    // Use first configured origin if available and not wildcard
    const origins = Array.from(this.allowedOrigins)
    if (origins.length > 0 && !this.allowedOrigins.has('*')) {
      return origins[0]
    }
    return '*'
  }

  private send(method: string, params: Record<string, unknown>) {
    const msg = { jsonrpc: '2.0', method, params }
    window.parent.postMessage(JSON.stringify(msg), this.targetOrigin)
  }
}

// Re-export shared types for convenience
export type {
  CBPMessage,
  CBPStateUpdate,
  CBPCommand,
} from '@chatbridge/shared'
