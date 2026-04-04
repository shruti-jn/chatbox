import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import ChatBridgeModel from './models/chatbridge'

export const chatbridgeProvider = defineProvider({
  id: 'chatbridge' as ModelProviderEnum,
  name: 'ChatBridge',
  type: 'chatbridge' as ModelProviderType,
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
  createModel: (options, dependencies) => {
    return new ChatBridgeModel(
      {
        apiHost: options.apiHost ?? 'http://localhost:3001',
        apiKey: options.apiKey || 'sk-ant-chatbridge-proxy-placeholder-key',  // Proxy uses its own key; format must pass Anthropic SDK validation
        model: options.model,
      },
      dependencies,
    )
  },
})
