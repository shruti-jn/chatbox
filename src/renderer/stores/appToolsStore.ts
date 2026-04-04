import { jsonSchema } from 'ai'
import { createStore, useStore } from 'zustand'
import { combine } from 'zustand/middleware'
import {
  getToolManifest,
  invokeAppTool,
  type ToolManifestEntry,
} from '../packages/chatbridge/rest-client'

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export const appToolsStore = createStore(
  combine(
    {
      manifest: [] as ToolManifestEntry[],
      classroomId: null as string | null,
      lastFetchedAt: null as number | null,
    },
    (set, get) => ({
      fetchManifest: async (joinCode: string, apiHost: string) => {
        const { lastFetchedAt } = get()
        const now = Date.now()
        if (lastFetchedAt !== null && now - lastFetchedAt < CACHE_TTL_MS) {
          return
        }

        const response = await getToolManifest(joinCode, apiHost)
        set({
          manifest: response.tools,
          classroomId: response.classroomId,
          lastFetchedAt: now,
        })
      },

      buildAppToolSet: (context: {
        apiHost: string
        apiKey: string
        conversationId: string
      }): Record<string, unknown> => {
        const { manifest } = get()
        const toolSet: Record<string, unknown> = {}

        for (const entry of manifest) {
          const toolKey = `app_${entry.appName.toLowerCase()}_${entry.toolName}`
          toolSet[toolKey] = {
            description: entry.description,
            parameters: jsonSchema(entry.parameters),
            execute: async (args: Record<string, unknown>) => {
              const response = await invokeAppTool(
                entry.appId,
                entry.toolName,
                args,
                context.conversationId,
                context.apiHost,
                context.apiKey,
              )
              return response.result
            },
          }
        }

        return toolSet
      },
    }),
  ),
)

export function useAppToolsStore<U>(selector: Parameters<typeof useStore<typeof appToolsStore, U>>[1]) {
  return useStore<typeof appToolsStore, U>(appToolsStore, selector)
}
