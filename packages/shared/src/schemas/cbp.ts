import { z } from 'zod/v3'

// CBP Message Types — JSON-RPC 2.0 over postMessage
export const CBPMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.enum(['state_update', 'command', 'lifecycle']),
  params: z.record(z.unknown()).optional(),
  id: z.union([z.string(), z.number()]).optional(),
})

export const CBPStateUpdateSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('state_update'),
  params: z.object({
    instance_id: z.string().uuid(),
    state: z.record(z.unknown()),
  }),
})

export const CBPCommandSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('command'),
  params: z.object({
    instance_id: z.string().uuid(),
    command: z.string(),
  }).passthrough(),
  id: z.union([z.string(), z.number()]).optional(),
})

export const CBPLifecycleSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('lifecycle'),
  params: z.object({
    instance_id: z.string().uuid(),
    event: z.enum(['suspend', 'resume', 'terminate']),
  }),
})

export const CBP_MAX_MESSAGE_SIZE = 64 * 1024 // 64KB

export type CBPMessage = z.infer<typeof CBPMessageSchema>
export type CBPStateUpdate = z.infer<typeof CBPStateUpdateSchema>
export type CBPCommand = z.infer<typeof CBPCommandSchema>
export type CBPLifecycle = z.infer<typeof CBPLifecycleSchema>
