import { createAnthropic } from '@ai-sdk/anthropic'
import AbstractAISDKModel, { type CallSettings } from '../../../models/abstract-ai-sdk'
import { ApiError } from '../../../models/errors'
import type { CallChatCompletionOptions } from '../../../models/types'
import type {
  MessageAppCardPart,
  MessageContentParts,
  MessageTextPart,
  ProviderModelInfo,
  StreamTextResult,
} from '../../../types'
import type { ModelDependencies } from '../../../types/adapters'

interface Options {
  apiHost: string
  apiKey: string
  model: ProviderModelInfo
  temperature?: number
  topP?: number
}

export default class ChatBridgeModel extends AbstractAISDKModel {
  public name = 'ChatBridge'

  constructor(
    public options: Options,
    dependencies: ModelDependencies,
  ) {
    super(options, dependencies)
  }

  protected getProvider() {
    return createAnthropic({
      apiKey: this.options.apiKey,
      baseURL: `${this.options.apiHost}/api/v1/ai/proxy`,
      headers: {
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    })
  }

  protected getChatModel() {
    const provider = this.getProvider()
    return provider.languageModel('claude-haiku-4-5-20251001')
  }

  protected getCallSettings(_options: CallChatCompletionOptions): CallSettings {
    return {
      temperature: this.options.temperature ?? 0.7,
      topP: this.options.topP,
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
    }
  }

  private normalizeMessageContent(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
            return part.text
          }
          return ''
        })
        .join('')
    }
    return ''
  }

  public override async chat(messages: any[], options: CallChatCompletionOptions): Promise<StreamTextResult> {
    const conversationId = options.sessionId
    if (!conversationId) {
      throw new ApiError('ChatBridge requests require a conversationId (sessionId)')
    }

    const response = await fetch(`${this.options.apiHost}/api/v1/chatbridge/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        conversationId,
        messages: messages.map((message) => ({
          role: message.role,
          content: this.normalizeMessageContent(message.content),
        })),
      }),
      signal: options.signal,
    })

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '')
      throw new ApiError(
        'ChatBridge native endpoint failed',
        errorText || `HTTP ${response.status}`,
      )
    }

    const contentParts: MessageContentParts = []
    let currentTextPart: MessageTextPart | undefined
    let finishReason = 'stop'

    const pushTextDelta = (text: string) => {
      if (!currentTextPart) {
        currentTextPart = { type: 'text', text: '' }
        contentParts.push(currentTextPart)
      }
      currentTextPart.text += text
      options.onResultChange?.({ contentParts })
    }

    const pushAppCard = (payload: Record<string, unknown>) => {
      currentTextPart = undefined
      const part: MessageAppCardPart = {
        type: 'app-card',
        appId: String(payload.appId),
        appName: String(payload.appName),
        instanceId: String(payload.instanceId),
        status: (payload.status as MessageAppCardPart['status']) ?? 'active',
        url: typeof payload.url === 'string' ? payload.url : undefined,
        height: typeof payload.height === 'number' ? payload.height : undefined,
        ...(payload.displayMode === 'panel' ? { displayMode: 'panel' as const } : {}),
        summary: typeof payload.summary === 'string' ? payload.summary : undefined,
        stateSnapshot:
          payload.stateSnapshot && typeof payload.stateSnapshot === 'object'
            ? (payload.stateSnapshot as Record<string, unknown>)
            : undefined,
      }
      contentParts.push(part)
      options.onResultChange?.({ contentParts })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const processEvent = (rawEvent: string) => {
      const lines = rawEvent.split('\n')
      let eventName = 'message'
      const dataLines: string[] = []

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        }
      }

      if (dataLines.length === 0) return
      const payload = JSON.parse(dataLines.join('\n')) as Record<string, any>

      if (eventName === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        pushTextDelta(String(payload.delta.text ?? ''))
        return
      }

      if (eventName === 'chatbridge_app_card') {
        pushAppCard(payload)
        return
      }

      if (eventName === 'error') {
        throw new ApiError(String(payload.error ?? 'ChatBridge streaming failed'))
      }

      if (eventName === 'message_stop' && typeof payload.finishReason === 'string') {
        finishReason = payload.finishReason
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex).trim()
        buffer = buffer.slice(separatorIndex + 2)
        if (rawEvent) processEvent(rawEvent)
        separatorIndex = buffer.indexOf('\n\n')
      }

      if (done) break
    }

    options.onStatusChange?.(null)
    return {
      contentParts,
      finishReason,
    }
  }

  isSupportToolUse(): boolean {
    return true
  }

  isSupportReasoning(): boolean {
    return false
  }
}
