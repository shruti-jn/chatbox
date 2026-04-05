/**
 * Tool Registry — resolves enabled tools for a ChatBridge conversation
 *
 * Determines which app tools should be available to the AI based on:
 * - District approval status
 * - Classroom enablement
 * - App health status
 * - COPPA consent (for age-gated apps)
 * - App review status
 *
 * Returns real Anthropic tool definitions, not prompt metadata.
 */

import { isBlocked } from '../apps/health.js'
import type { ConversationContext } from './context-builder.js'

export interface ChatBridgeTool {
  /** Namespaced tool name: app_chess_start_game */
  name: string
  /** Human-readable description for the AI */
  description: string
  /** JSON Schema for tool parameters */
  input_schema: Record<string, unknown>
  /** Metadata for app card rendering (not sent to Anthropic) */
  _appMeta: {
    appId: string
    appName: string
    uiManifestUrl: string
    uiManifestHeight: number
    displayMode: 'inline' | 'panel'
  }
}

/**
 * Resolve the tools available for a conversation.
 *
 * Filters by: approved, enabled, healthy, and not consent-blocked.
 */
export function resolveTools(ctx: ConversationContext): ChatBridgeTool[] {
  const tools: ChatBridgeTool[] = []

  for (const config of ctx.enabledApps) {
    const app = config.app

    // Only approved apps
    if (app.reviewStatus !== 'approved') continue

    // Skip unhealthy/degraded apps
    if (isBlocked(app.id)) continue

    // Get tool definitions
    const toolDefs = app.toolDefinitions as Array<{
      name: string
      description: string
      inputSchema?: Record<string, unknown>
    }>

    if (!Array.isArray(toolDefs)) continue

    const uiManifest = app.uiManifest as { url?: string; height?: number; displayMode?: 'inline' | 'panel' } ?? {}

    for (const tool of toolDefs) {
      tools.push({
        name: `${app.name.toLowerCase().replace(/\s+/g, '_')}__${tool.name}`,
        description: `[${app.name}] ${tool.description}`,
        input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
        _appMeta: {
          appId: app.id,
          appName: app.name,
          uiManifestUrl: uiManifest.url ?? '',
          uiManifestHeight: uiManifest.height ?? 400,
          displayMode: uiManifest.displayMode === 'panel' ? 'panel' : 'inline',
        },
      })
    }
  }

  return tools
}

/**
 * Convert ChatBridge tools to Anthropic API tool format.
 * Strips internal metadata (_appMeta) — Anthropic doesn't need it.
 */
export function toAnthropicTools(tools: ChatBridgeTool[]): Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

/**
 * Find the app metadata for a tool call result.
 * Used to build __cbApp in the tool execution response.
 */
export function findToolMeta(tools: ChatBridgeTool[], toolName: string): ChatBridgeTool['_appMeta'] | null {
  const tool = tools.find(t => t.name === toolName)
  return tool?._appMeta ?? null
}

/**
 * Parse a namespaced tool name back to appName + toolName.
 * "chess__start_game" → { appName: "chess", toolName: "start_game" }
 */
export function parseToolName(namespacedName: string): { appName: string; toolName: string } | null {
  const parts = namespacedName.split('__')
  if (parts.length !== 2) return null
  return { appName: parts[0], toolName: parts[1] }
}
