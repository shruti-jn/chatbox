import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import ChatBridgeModel from './models/chatbridge'

export const chatbridgeProvider = defineProvider({
  id: ModelProviderEnum.ChatBridge,
  name: 'ChatBridge',
  type: ModelProviderType.ChatBridge,
  curatedModelIds: ['chatbridge-haiku'],
  urls: {
    website: 'http://localhost:3001',
  },
  defaultSettings: {
    apiHost: 'http://localhost:3001',
    models: [
      {
        modelId: 'chatbridge-haiku',
        contextWindow: 200_000,
        maxOutput: 64_000,
        capabilities: ['tool_use'],
      },
    ],
  },
  description: 'ChatBridge K-12 AI Platform — messages routed through safety pipeline',
  createModel: (config) => {
    return new ChatBridgeModel(
      {
        apiHost: config.formattedApiHost || 'http://localhost:3001',
        apiKey: config.effectiveApiKey || 'sk-ant-chatbridge-proxy-placeholder-key',
        model: config.model,
        temperature: config.settings.temperature,
        topP: config.settings.topP,
      },
      config.dependencies,
    )
  },
})
