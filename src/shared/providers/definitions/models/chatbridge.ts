/**
 * ChatBridge Model — Routes messages through the ChatBridge Fastify backend
 *
 * Instead of calling Claude directly, messages go through:
 * Student input → ChatBridge API → Safety pipeline → AI service → Response
 *
 * This ensures every message is:
 * - PII-stripped
 * - Injection-checked
 * - LLM-classified for safety
 * - Crisis-detected
 * - Traced in Langfuse
 * - Contextualized with classroom config, app state, whisper guidance
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import AbstractAISDKModel, { type CallSettings } from '../../../models/abstract-ai-sdk'
import type { CallChatCompletionOptions } from '../../../models/types'
import type { ProviderModelInfo } from '../../../types'
import type { ModelDependencies } from '../../../types/adapters'

interface Options {
  apiHost: string
  apiKey: string
  model: ProviderModelInfo
  temperature?: number
  topP?: number
}

/**
 * For V1, ChatBridge model uses the Anthropic SDK directly but points to our
 * backend's /api/v1/ai proxy endpoint. This means all messages flow through
 * our safety pipeline transparently.
 *
 * In V2, this will use WebSocket streaming for real-time features.
 */
export default class ChatBridgeModel extends AbstractAISDKModel {
  public name = 'ChatBridge'

  constructor(
    public options: Options,
    dependencies: ModelDependencies,
  ) {
    super(options, dependencies)
  }

  protected getProvider() {
    // Use Anthropic SDK but route through our backend proxy
    // Our backend's /api/v1/ai/proxy endpoint forwards to Anthropic
    // after applying safety pipeline + context enrichment
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
    // Use haiku for all ChatBridge requests
    return provider.languageModel('claude-haiku-4-5-20251001')
  }

  protected getCallSettings(_options: CallChatCompletionOptions): CallSettings {
    return {
      temperature: this.options.temperature ?? 0.7,
      topP: this.options.topP,
    }
  }

  isSupportToolUse(): boolean {
    return true
  }

  isSupportReasoning(): boolean {
    return false
  }
}
