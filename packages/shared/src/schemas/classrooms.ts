import { z } from 'zod/v3'

export const GradeBandSchema = z.enum(['k2', 'g35', 'g68', 'g912'])

export const AIConfigSchema = z.object({
  mode: z.enum(['socratic', 'direct', 'exploratory']).default('socratic'),
  subject: z.string().optional(),
  tone: z.string().optional(),
  complexity: z.string().optional(),
  asyncGuidance: z.string().optional(),
})

export const ClassroomCreateSchema = z.object({
  name: z.string().min(1).max(200),
  gradeBand: GradeBandSchema,
  aiConfig: AIConfigSchema.optional(),
})

export const ClassroomConfigSchema = z.object({
  gradeBand: GradeBandSchema,
  aiConfig: AIConfigSchema,
  joinCode: z.string(),
})

export const WhisperSchema = z.object({
  guidance: z.string().min(1).max(2000),
})

export type GradeBand = z.infer<typeof GradeBandSchema>
export type AIConfig = z.infer<typeof AIConfigSchema>
export type ClassroomCreate = z.infer<typeof ClassroomCreateSchema>
export type ClassroomConfig = z.infer<typeof ClassroomConfigSchema>
export type Whisper = z.infer<typeof WhisperSchema>
