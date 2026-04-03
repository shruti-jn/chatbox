import { z } from 'zod/v3'

export const AppStatusSchema = z.enum(['pending_review', 'approved', 'rejected', 'suspended'])
export const InteractionModelSchema = z.enum(['single_user', 'turn_based', 'concurrent'])
export const AppInstanceStatusSchema = z.enum(['loading', 'active', 'suspended', 'collapsed', 'terminated', 'error'])

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
})

export const UIManifestSchema = z.object({
  url: z.string().url(),
  width: z.number().max(600).optional(),
  height: z.number().max(800).optional(),
  sandboxAttrs: z.string().optional(),
})

export const AppRegistrationSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  toolDefinitions: z.array(ToolDefinitionSchema).min(1),
  uiManifest: UIManifestSchema,
  permissions: z.record(z.unknown()),
  complianceMetadata: z.record(z.unknown()),
  interactionModel: InteractionModelSchema.default('single_user'),
  version: z.string(),
})

export const AppReviewResultSchema = z.object({
  appId: z.string().uuid(),
  overallStatus: z.enum(['pass', 'fail']),
  checks: z.array(z.object({
    name: z.string(),
    category: z.enum(['schema', 'security', 'safety', 'accessibility', 'performance']),
    status: z.enum(['pass', 'fail']),
    details: z.string().optional(),
    violations: z.array(z.string()).optional(),
  })),
  reviewedAt: z.string().datetime(),
})

export type AppStatus = z.infer<typeof AppStatusSchema>
export type InteractionModel = z.infer<typeof InteractionModelSchema>
export type AppInstanceStatus = z.infer<typeof AppInstanceStatusSchema>
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>
export type UIManifest = z.infer<typeof UIManifestSchema>
export type AppRegistration = z.infer<typeof AppRegistrationSchema>
export type AppReviewResult = z.infer<typeof AppReviewResultSchema>
