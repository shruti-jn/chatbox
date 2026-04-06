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

  private getPersistedAccessToken(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) return null

    try {
      const raw = window.localStorage.getItem('chatbox-ai-auth-info')
      if (!raw) return null

      const parsed = JSON.parse(raw) as {
        state?: { accessToken?: string | null }
        accessToken?: string | null
      }

      return parsed.state?.accessToken ?? parsed.accessToken ?? null
    } catch {
      return null
    }
  }

  private getAuthToken(): string {
    return this.getPersistedAccessToken() || this.options.apiKey
  }

  private buildHeaders(): Record<string, string> {
    const token = this.getAuthToken()
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }
  }

  private buildApiUrl(path: string): string {
    return `${this.options.apiHost}/api/v1${path}`
  }

  private resolveAppUrl(url: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    return new URL(url, this.options.apiHost).toString()
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

  private async streamSseResponse(
    response: Response,
    processEvent: (rawEvent: string) => void,
  ): Promise<void> {
    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '')
      throw new ApiError(
        'ChatBridge native endpoint failed',
        errorText || `HTTP ${response.status}`,
      )
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

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
  }

  private async waitForToolCompletion(
    jobId: string,
    updateJobState: (jobStatus: 'queued' | 'running' | 'slow' | 'completed' | 'failed' | 'timed_out') => void,
  ): Promise<{
    status: 'completed' | 'failed' | 'timed_out'
    resumeToken: string | null
    result?: Record<string, unknown> | null
  }> {
    const startedAt = Date.now()
    let markedSlow = false

    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await fetch(this.buildApiUrl(`/chatbridge/jobs/${jobId}`), {
        method: 'GET',
        headers: this.buildHeaders(),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new ApiError('ChatBridge job status check failed', errorText || `HTTP ${response.status}`)
      }

      const body = await response.json() as {
        status: 'queued' | 'running' | 'completed' | 'failed' | 'timed_out'
        resumeToken: string | null
        result?: Record<string, unknown> | null
      }

      if (!markedSlow && Date.now() - startedAt > 5000 && (body.status === 'queued' || body.status === 'running')) {
        markedSlow = true
        updateJobState('slow')
      } else {
        updateJobState(body.status)
      }

      if (body.status === 'completed' || body.status === 'failed' || body.status === 'timed_out') {
        return { status: body.status, resumeToken: body.resumeToken, result: body.result ?? null }
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    updateJobState('timed_out')
    throw new ApiError('ChatBridge job did not finish in time')
  }

  public override async chat(messages: any[], options: CallChatCompletionOptions): Promise<StreamTextResult> {
    const conversationId = options.sessionId
    if (!conversationId) {
      throw new ApiError('ChatBridge requests require a conversationId (sessionId)')
    }

    const response = await fetch(this.buildApiUrl('/chatbridge/completions'), {
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
    let pendingTool: { jobId: string; resumeToken?: string | null } | null = null

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
      const part = {
        type: 'app-card',
        appId: String(payload.appId),
        appName: String(payload.appName),
        instanceId: String(payload.instanceId),
        status: (payload.status as MessageAppCardPart['status']) ?? 'active',
        url: typeof payload.url === 'string' ? this.resolveAppUrl(payload.url) : undefined,
        height: typeof payload.height === 'number' ? payload.height : undefined,
        ...(payload.displayMode === 'panel' ? { displayMode: 'panel' as const } : {}),
        summary: typeof payload.summary === 'string' ? payload.summary : undefined,
        stateSnapshot:
          payload.stateSnapshot && typeof payload.stateSnapshot === 'object'
            ? (payload.stateSnapshot as Record<string, unknown>)
            : undefined,
        ...(typeof payload.jobId === 'string' ? { jobId: payload.jobId } : {}),
        ...(typeof payload.jobStatus === 'string' ? { jobStatus: payload.jobStatus } : {}),
      } as MessageAppCardPart & Record<string, unknown>
      contentParts.push(part as MessageAppCardPart)
      options.onResultChange?.({ contentParts })
    }

    const updateAppCardForJob = (jobId: string, patch: Record<string, unknown>) => {
      const appCard = [...contentParts].reverse().find(
        (part) => part.type === 'app-card' && (part as Record<string, unknown>).jobId === jobId,
      ) as (MessageAppCardPart & Record<string, unknown>) | undefined

      if (!appCard) return

      Object.assign(appCard, patch)
      if (patch.jobStatus === 'failed' || patch.jobStatus === 'timed_out') {
        appCard.status = 'error'
      }
      options.onResultChange?.({ contentParts })
    }

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

      if (eventName === 'tool_pending') {
        pendingTool = {
          jobId: String(payload.jobId),
          resumeToken: typeof payload.resumeToken === 'string' ? payload.resumeToken : null,
        }

        updateAppCardForJob(String(payload.jobId), {
          jobStatus: 'queued',
        })
        return
      }

      if (eventName === 'error') {
        throw new ApiError(String(payload.error ?? 'ChatBridge streaming failed'))
      }

      if (eventName === 'message_stop' && typeof payload.finishReason === 'string') {
        finishReason = payload.finishReason
      }
    }

    await this.streamSseResponse(response, processEvent)

    if (pendingTool?.jobId) {
      const completion = await this.waitForToolCompletion(pendingTool.jobId, (jobStatus) => {
        const patch: Record<string, unknown> = { jobStatus }
        if (jobStatus === 'completed') {
          patch.status = 'active'
        }
        updateAppCardForJob(pendingTool!.jobId, patch)
      })

      const resumeToken = completion.resumeToken ?? pendingTool.resumeToken
      if (!resumeToken) {
        throw new ApiError('ChatBridge async tool finished without a resume token')
      }

      if (completion.status === 'completed') {
        updateAppCardForJob(pendingTool.jobId, {
          jobStatus: 'completed',
          status: 'active',
          ...(typeof completion.result?._instanceId === 'string' && completion.result._instanceId
            ? { instanceId: completion.result._instanceId }
            : {}),
          ...(completion.result && typeof completion.result === 'object'
            ? { stateSnapshot: completion.result }
            : {}),
        })
      }

      const resumeResponse = await fetch(this.buildApiUrl('/chatbridge/completions/resume'), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ resumeToken }),
        signal: options.signal,
      })

      await this.streamSseResponse(resumeResponse, processEvent)
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
