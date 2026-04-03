import { z } from 'zod/v3'

export const MessageRoleSchema = z.enum(['student', 'assistant', 'system', 'teacher_whisper'])

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ToolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  state: z.enum(['call', 'result', 'error']),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
})

export const AppCardPartSchema = z.object({
  type: z.literal('app-card'),
  appId: z.string().uuid(),
  appName: z.string(),
  instanceId: z.string().uuid(),
  status: z.enum(['loading', 'active', 'suspended', 'collapsed', 'terminated', 'error']),
  url: z.string().url().optional(),
  height: z.number().optional(),
  summary: z.string().optional(),
  stateSnapshot: z.record(z.unknown()).optional(),
})

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  AppCardPartSchema,
])

export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  authorRole: MessageRoleSchema,
  contentParts: z.array(ContentPartSchema),
  safetyVerdict: z.object({
    severity: z.enum(['safe', 'warning', 'blocked', 'critical']),
    category: z.string(),
    piiFound: z.array(z.string()).optional(),
    redactedMessage: z.string().optional(),
  }).optional(),
  tokenCount: z.number().optional(),
  createdAt: z.string().datetime(),
})

export type MessageRole = z.infer<typeof MessageRoleSchema>
export type TextPart = z.infer<typeof TextPartSchema>
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>
export type AppCardPart = z.infer<typeof AppCardPartSchema>
export type ContentPart = z.infer<typeof ContentPartSchema>
export type Message = z.infer<typeof MessageSchema>
