/**
 * ChatBridge Bridge Protocol (CBP) Handler
 *
 * JSON-RPC 2.0 over postMessage
 * Responsibilities:
 * 1. Origin validation
 * 2. Message schema validation (Zod, 64KB limit)
 * 3. PII stripping on outbound payloads
 * 4. State update parsing
 * 5. Command building
 * 6. Lifecycle message building
 * 7. Content safety on inbound messages
 */

import {
  CBPMessageSchema,
  CBPStateUpdateSchema,
  CBP_MAX_MESSAGE_SIZE,
  type CBPMessage,
  type CBPStateUpdate,
  type CBPCommand,
} from '@chatbridge/shared'
import { detectAndRedactPII } from '../safety/pii-detector.js'
import { runSafetyPipeline } from '../safety/pipeline.js'

const allowedOrigins = new Set<string>(
  (process.env.CBP_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:1212').split(','),
)

export function addAllowedOrigin(origin: string): void {
  allowedOrigins.add(origin)
}

export function validateOrigin(origin: string): boolean {
  if (!origin || origin === 'null') return false
  return allowedOrigins.has(origin)
}

export function validateMessageSize(raw: string): boolean {
  return Buffer.byteLength(raw, 'utf-8') <= CBP_MAX_MESSAGE_SIZE
}

export function validateMessage(raw: string): { valid: boolean; message?: CBPMessage; error?: string } {
  // Size check BEFORE JSON parse (DoS prevention)
  if (!validateMessageSize(raw)) {
    return { valid: false, error: 'Message exceeds 64KB limit' }
  }

  try {
    const parsed = JSON.parse(raw)
    const result = CBPMessageSchema.safeParse(parsed)
    if (!result.success) {
      return { valid: false, error: `Invalid JSON-RPC 2.0: ${result.error.message}` }
    }
    return { valid: true, message: result.data }
  } catch {
    return { valid: false, error: 'Invalid JSON' }
  }
}

export function parseStateUpdate(message: CBPMessage): CBPStateUpdate | null {
  if (message.method !== 'state_update') return null
  const result = CBPStateUpdateSchema.safeParse(message)
  return result.success ? result.data : null
}

export function buildCommand(
  instanceId: string,
  command: string,
  params: Record<string, unknown> = {},
  id?: string | number,
): CBPCommand {
  // Strip PII from outbound params
  const cleanParams = { ...params }
  for (const [key, value] of Object.entries(cleanParams)) {
    if (typeof value === 'string') {
      const { redactedMessage } = detectAndRedactPII(value)
      cleanParams[key] = redactedMessage
    }
  }

  return {
    jsonrpc: '2.0' as const,
    method: 'command' as const,
    params: {
      instance_id: instanceId,
      command,
      ...cleanParams,
    },
    ...(id !== undefined ? { id } : {}),
  }
}

export function buildLifecycleMessage(
  instanceId: string,
  event: 'suspend' | 'resume' | 'terminate',
) {
  return {
    jsonrpc: '2.0' as const,
    method: 'lifecycle' as const,
    params: {
      instance_id: instanceId,
      event,
    },
  }
}

/**
 * Check content safety on inbound app messages
 * Only classifies if params contains text
 */
export async function checkContentSafety(
  message: CBPMessage,
): Promise<{ safe: boolean; severity: string; reason?: string }> {
  const params = message.params as Record<string, unknown> | undefined
  if (!params) return { safe: true, severity: 'safe' }

  // Check any text fields in params
  const textFields = Object.values(params).filter((v): v is string => typeof v === 'string')
  for (const text of textFields) {
    if (text.length > 10) { // Skip very short strings (likely IDs)
      const result = await runSafetyPipeline(text)
      if (result.severity === 'blocked' || result.severity === 'critical') {
        return { safe: false, severity: result.severity, reason: result.category }
      }
    }
  }

  return { safe: true, severity: 'safe' }
}
