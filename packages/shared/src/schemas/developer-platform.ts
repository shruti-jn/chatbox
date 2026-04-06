import { z } from 'zod/v3'

export const DeveloperPlatformUserRoleSchema = z.enum(['developer', 'reviewer', 'platform_admin'])

export const PluginStatusSchema = z.enum([
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'suspended',
])

export const PluginVersionStatusSchema = z.enum([
  'uploaded',
  'scanning',
  'scan_failed',
  'awaiting_review',
  'approved',
  'published',
  'rejected',
  'rolled_back',
  'deprecated',
])

export const TrustTierSchema = z.enum(['dev-only', 'reviewed', 'certified'])

export const ReviewDecisionTypeSchema = z.enum(['approve', 'reject', 'waive', 'escalate'])

export const ReviewChecklistItemIdSchema = z.enum([
  'platform_hosting_only',
  'manifest_matches_artifact',
  'declared_network_domains_match_observed_behavior',
  'tool_contract_matches_runtime_behavior',
  'data_collection_and_permissions_disclosed',
  'age_rating_and_student_safety_reviewed',
  'security_findings_triaged',
  'runtime_evidence_captured',
])

export const ReviewChecklistStatusSchema = z.enum(['pass', 'fail', 'waived'])

export const ReviewReasonCodeSchema = z.enum([
  'clean_review',
  'manifest_mismatch',
  'undeclared_network_access',
  'undeclared_data_collection',
  'runtime_contract_mismatch',
  'artifact_integrity_failure',
  'security_scan_blocker',
  'student_safety_risk',
  'obfuscated_or_malformed_artifact',
  'missing_reviewer_evidence',
  'needs_security_escalation',
  'needs_legal_privacy_escalation',
  'needs_trust_safety_escalation',
  'needs_platform_escalation',
])

export const ReviewEvidenceSourceSchema = z.enum([
  'platform_scan',
  'artifact_hash_verification',
  'reviewer_runtime_capture',
  'policy_document',
  'developer_submission',
])

export const EscalationPathSchema = z.enum([
  'security',
  'legal_privacy',
  'trust_safety',
  'platform_architecture',
])

export const ScanCategorySchema = z.enum([
  'manifest',
  'static_analysis',
  'dependency',
  'content',
  'artifact_integrity',
  'policy_mismatch',
])

export const ScanRuleActionSchema = z.enum(['fail', 'warn', 'manual_review'])

export const StaticAnalysisApproachSchema = z.enum([
  'ast_and_signature_scan',
  'bundle_structure_inspection',
  'manifest_policy_cross_check',
  'dependency_sca',
])

export const BlockedPatternFamilySchema = z.enum([
  'dynamic_code_execution',
  'tracking_sdk',
  'undeclared_network_access',
  'suspicious_bundling_behavior',
  'obfuscation',
  'credential_or_secret_access',
  'sandbox_escape_attempt',
])

export const ScanSeveritySchema = z.enum(['info', 'warning', 'high', 'critical'])

export const ScanDispositionSchema = z.enum(['pass', 'warn', 'fail', 'manual_review'])

export const RuntimeEventTypeSchema = z.enum([
  'plugin_suspended',
  'plugin_reinstated',
  'plugin_rolled_forward',
  'plugin_rolled_back',
  'district_policy_changed',
  'iframe_load_failed',
  'runtime_violation',
  'unexpected_network_request',
])

export const InputFieldSchema = z.object({
  name: z.string().min(1).max(100),
  label: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  required: z.boolean().default(false),
  kind: z.enum(['text', 'number', 'select', 'boolean', 'secret']).default('text'),
})

export const PluginToolSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
})

const domainPattern = /^(?:\*\.)?(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/

function isSafeEntrypointPath(value: string) {
  return value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('..')
    && !/[?#]/.test(value)
}

export const PluginManifestSchema = z.object({
  pluginId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  description: z.string().min(1).max(2000),
  entrypoint: z.string().min(1).max(500),
  ageRating: z.string().min(1).max(50),
  collectsInput: z.boolean(),
  inputFields: z.array(InputFieldSchema).default([]),
  permissions: z.array(z.string().min(1).max(100)).default([]),
  networkDomains: z.array(z.string().min(1).max(255)).default([]),
  dataPolicyUrl: z.string().url(),
  externalResources: z.array(z.string().min(1).max(500)).default([]),
  sriHashes: z.array(z.string().min(1).max(255)).default([]),
  tools: z.array(PluginToolSchema).min(1),
}).superRefine((manifest, ctx) => {
  if (!manifest.collectsInput && manifest.inputFields.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inputFields'],
      message: 'inputFields must be empty when collectsInput is false',
    })
  }

  if (manifest.collectsInput && manifest.inputFields.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inputFields'],
      message: 'inputFields must be declared when collectsInput is true',
    })
  }

  if (!isSafeEntrypointPath(manifest.entrypoint)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entrypoint'],
      message: 'entrypoint must be an app-relative absolute path without traversal, query, or fragment components',
    })
  }

  const seenInputFieldNames = new Set<string>()
  for (const [index, field] of manifest.inputFields.entries()) {
    if (seenInputFieldNames.has(field.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputFields', index, 'name'],
        message: `duplicate input field name: ${field.name}`,
      })
    }
    seenInputFieldNames.add(field.name)
  }

  const seenToolNames = new Set<string>()
  for (const [index, tool] of manifest.tools.entries()) {
    if (seenToolNames.has(tool.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools', index, 'name'],
        message: `duplicate tool name: ${tool.name}`,
      })
    }
    seenToolNames.add(tool.name)
  }

  for (const [index, domain] of manifest.networkDomains.entries()) {
    if (!domainPattern.test(domain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['networkDomains', index],
        message: `network domain must be a valid hostname or wildcard hostname: ${domain}`,
      })
    }
  }
})

export const DeveloperSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  organization: z.string().min(1).max(200).optional(),
  createdAt: z.string().datetime(),
})

export const DeveloperInputSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  organization: z.string().min(1).max(200).optional(),
})

export const DpaRecordSchema = z.object({
  id: z.string().uuid(),
  developerId: z.string().uuid(),
  status: z.enum(['not_started', 'pending_review', 'approved', 'rejected']),
  documentUrl: z.string().url().optional(),
  approvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const DpaRecordInputSchema = z.object({
  status: z.enum(['not_started', 'pending_review', 'approved', 'rejected']).default('not_started'),
  documentUrl: z.string().url().optional(),
  approvedAt: z.string().datetime().optional(),
})

export const PluginCreateRequestSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  developer: DeveloperInputSchema.optional(),
  dpaRecord: DpaRecordInputSchema.optional(),
})

export const PluginVersionCreateRequestSchema = z.object({
  version: z.string().min(1).max(50),
  manifest: PluginManifestSchema,
})

export const ArtifactUploadMetadataSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1).max(255),
  storageKey: z.string().min(1).max(500).optional(),
})

export const ArtifactInventoryEntrySchema = z.object({
  path: z.string().min(1).max(1000),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1).max(255),
})

export const ArtifactInventorySchema = z.object({
  fileCount: z.number().int().nonnegative(),
  totalUncompressedBytes: z.number().int().nonnegative(),
  entries: z.array(ArtifactInventoryEntrySchema),
})

export const ObservedInputSurfaceSchema = z.object({
  kind: z.enum(['html_input', 'html_textarea', 'html_select', 'html_form']),
  path: z.string().min(1).max(1000),
  identifier: z.string().min(1).max(255).optional(),
})

export const ScanFindingSchema = z.object({
  code: z.string().min(1).max(100),
  category: ScanCategorySchema,
  severity: ScanSeveritySchema,
  disposition: ScanDispositionSchema,
  message: z.string().min(1).max(2000),
  ruleId: z.string().min(1).max(100).optional(),
  path: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const ScanThresholdSchema = z.object({
  severity: ScanSeveritySchema,
  action: ScanRuleActionSchema,
  rationale: z.string().min(1).max(500),
})

export const BlockedPatternRuleSchema = z.object({
  ruleId: z.string().min(1).max(100),
  family: BlockedPatternFamilySchema,
  category: ScanCategorySchema,
  action: ScanRuleActionSchema,
  severity: ScanSeveritySchema,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().min(1).max(500)).min(1),
  evidentiaryNotes: z.array(z.string().min(1).max(500)).min(1),
})

export const DependencyPolicySchema = z.object({
  scaRequired: z.boolean(),
  failOnKnownExploited: z.boolean(),
  failOnCriticalUnpatched: z.boolean(),
  manualReviewOnUnknownLicense: z.boolean(),
  warnOnStalePackagesDays: z.number().int().positive(),
})

export const SecurityScanPolicySchema = z.object({
  rulesetVersion: z.string().min(1).max(50),
  staticAnalysisApproach: z.array(StaticAnalysisApproachSchema).min(1),
  proofRequirements: z.array(z.string().min(1).max(500)).min(1),
  thresholds: z.array(ScanThresholdSchema).min(1),
  dependencyPolicy: DependencyPolicySchema,
  blockedPatterns: z.array(BlockedPatternRuleSchema).min(1),
  notes: z.array(z.string().min(1).max(500)).min(1),
}).superRefine((policy, ctx) => {
  const seen = new Set<string>()
  for (const rule of policy.blockedPatterns) {
    if (seen.has(rule.ruleId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedPatterns'],
        message: `duplicate blocked pattern ruleId: ${rule.ruleId}`,
      })
    }
    seen.add(rule.ruleId)
  }

  const thresholdSeverities = new Set(policy.thresholds.map((entry) => entry.severity))
  for (const severity of ScanSeveritySchema.options) {
    if (!thresholdSeverities.has(severity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholds'],
        message: `missing threshold for severity: ${severity}`,
      })
    }
  }
})

export const ScanRunSchema = z.object({
  id: z.string().uuid(),
  pluginId: z.string().min(1).max(100),
  pluginVersionId: z.string().uuid(),
  rulesetVersion: z.string().min(1).max(50),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  overallDisposition: ScanDispositionSchema,
  findings: z.array(ScanFindingSchema),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
})

export const ManifestPolicyVerificationResultSchema = z.object({
  pluginId: z.string().min(1).max(100),
  pluginVersionId: z.string().uuid(),
  verifiedAt: z.string().datetime(),
  overallDisposition: ScanDispositionSchema,
  observedNetworkDomains: z.array(z.string().min(1).max(255)),
  observedExternalResources: z.array(z.string().min(1).max(1000)),
  observedInputSurfaces: z.array(ObservedInputSurfaceSchema),
  findings: z.array(ScanFindingSchema),
})

export const ReviewScanContextSchema = z.object({
  rulesetVersion: z.string().min(1).max(50),
  scanRunIds: z.array(z.string().uuid()).min(1),
  referencedFindingRuleIds: z.array(z.string().min(1).max(100)).default([]),
})

export const ReviewChecklistResultSchema = z.object({
  itemId: ReviewChecklistItemIdSchema,
  status: ReviewChecklistStatusSchema,
  notes: z.string().min(1).max(1000).optional(),
})

export const ReviewerEvidenceSchema = z.object({
  source: ReviewEvidenceSourceSchema,
  summary: z.string().min(1).max(1000),
  location: z.string().min(1).max(1000),
  capturedAt: z.string().datetime(),
  findingIds: z.array(z.string().min(1).max(100)).default([]),
})

export const ReviewWaiverSchema = z.object({
  rationale: z.string().min(20).max(2000),
  approvedBy: z.string().min(1).max(100),
  scope: z.string().min(1).max(500),
  compensatingControls: z.array(z.string().min(1).max(500)).min(1),
  expiresAt: z.string().datetime().optional(),
})

export const ReviewEscalationSchema = z.object({
  path: EscalationPathSchema,
  severity: z.enum(['high', 'critical']),
  summary: z.string().min(20).max(1000),
  blocking: z.boolean().default(true),
})

const requiredChecklistItems = ReviewChecklistItemIdSchema.options

export const ReviewDecisionRequestSchema = z.object({
  decision: ReviewDecisionTypeSchema,
  reasonCode: ReviewReasonCodeSchema,
  notes: z.string().min(20).max(4000),
  reviewerId: z.string().min(1).max(100),
  scanContext: ReviewScanContextSchema,
  checklist: z.array(ReviewChecklistResultSchema).min(requiredChecklistItems.length),
  evidence: z.array(ReviewerEvidenceSchema).min(1),
  waiver: ReviewWaiverSchema.optional(),
  escalation: ReviewEscalationSchema.optional(),
}).superRefine((decision, ctx) => {
  const seenItems = new Set<string>()

  for (const item of decision.checklist) {
    if (seenItems.has(item.itemId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checklist'],
        message: `duplicate checklist item: ${item.itemId}`,
      })
    }
    seenItems.add(item.itemId)
  }

  for (const itemId of requiredChecklistItems) {
    if (!seenItems.has(itemId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checklist'],
        message: `missing checklist item: ${itemId}`,
      })
    }
  }

  const hasRuntimeOrArtifactProof = decision.evidence.some((entry) =>
    entry.source === 'reviewer_runtime_capture' || entry.source === 'artifact_hash_verification' || entry.source === 'platform_scan'
  )

  if (!hasRuntimeOrArtifactProof) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidence'],
      message: 'approval evidence must include platform-generated or runtime-captured proof',
    })
  }

  const failingItems = decision.checklist.filter((item) => item.status === 'fail')
  const waivedItems = decision.checklist.filter((item) => item.status === 'waived')

  if (decision.decision === 'approve') {
    if (failingItems.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'approve decisions cannot include failed checklist items',
      })
    }

    if (waivedItems.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'approve decisions must use waive when any checklist item is waived',
      })
    }

    if (decision.waiver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['waiver'],
        message: 'waiver details are not allowed on clean approvals',
      })
    }
  }

  if (decision.decision === 'waive') {
    if (waivedItems.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checklist'],
        message: 'waive decisions require at least one waived checklist item',
      })
    }

    if (!decision.waiver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['waiver'],
        message: 'waive decisions require waiver metadata',
      })
    }
  }

  if (decision.decision === 'reject' && failingItems.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['checklist'],
      message: 'reject decisions require at least one failed checklist item',
    })
  }

  if (decision.decision === 'escalate') {
    if (!decision.escalation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['escalation'],
        message: 'escalate decisions require escalation details',
      })
    }
  } else if (decision.escalation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['escalation'],
      message: 'escalation details are only allowed for escalate decisions',
    })
  }
})

export const ReviewRubricSchema = z.object({
  checklist: z.array(z.object({
    itemId: ReviewChecklistItemIdSchema,
    label: z.string().min(1).max(200),
    hardBlockOnFail: z.boolean(),
    waiverAllowed: z.boolean(),
    reviewerPrompt: z.string().min(1).max(1000),
  })),
  proofRequirements: z.array(z.string().min(1).max(500)).min(1),
  insufficientProofExamples: z.array(z.string().min(1).max(500)).min(1),
  escalationPaths: z.array(z.object({
    path: EscalationPathSchema,
    triggers: z.array(z.string().min(1).max(500)).min(1),
  })).min(1),
  reasonCodes: z.array(ReviewReasonCodeSchema).min(1),
})

export const ScanEvaluationInputSchema = z.object({
  findings: z.array(ScanFindingSchema),
  rulesetVersion: z.string().min(1).max(50),
})

export const ScanRunCreateRequestSchema = z.object({
  rulesetVersion: z.string().min(1).max(50),
  findings: z.array(ScanFindingSchema).default([]),
})

export const ScanEvaluationResultSchema = z.object({
  rulesetVersion: z.string().min(1).max(50),
  overallDisposition: ScanDispositionSchema,
  thresholdReason: z.string().min(1).max(500),
})

export const PublishMetadataSchema = z.object({
  pluginId: z.string().min(1).max(100),
  pluginVersionId: z.string().uuid(),
  version: z.string().min(1).max(50),
  hostedUrl: z.string().url(),
  artifactSha256: z.string().min(1).max(255),
  publishedAt: z.string().datetime(),
})

export const RegistryAppSchema = z.object({
  pluginId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  trustTier: TrustTierSchema,
  status: PluginStatusSchema,
  enabled: z.boolean(),
  ageRating: z.string().min(1).max(50),
  hostedUrl: z.string().url(),
  permissions: z.array(z.string()),
  networkDomains: z.array(z.string()),
  collectsInput: z.boolean(),
  inputFields: z.array(InputFieldSchema),
  tools: z.array(PluginToolSchema),
})

export const RegistryAppsResponseSchema = z.object({
  apps: z.array(RegistryAppSchema),
})

export const RegistryContextRequestSchema = z.object({
  districtId: z.string().uuid().optional(),
  classroomId: z.string().uuid().optional(),
  includeSuspended: z.preprocess(
    (val) => {
      if (val === 'true') return true
      if (val === 'false') return false
      return val
    },
    z.boolean().default(false),
  ),
})

export const DistrictPluginOverrideRequestSchema = z.object({
  districtId: z.string().uuid(),
  pluginId: z.string().min(1).max(100),
  enabled: z.boolean(),
})

export const DistrictPluginOverrideSchema = DistrictPluginOverrideRequestSchema.extend({
  updatedAt: z.string().datetime(),
})

export const RuntimeRegistryVersionSchema = z.object({
  pluginId: z.string().min(1).max(100),
  activeVersion: z.string().min(1).max(50),
  hostedUrl: z.string().url(),
  trustTier: TrustTierSchema,
  status: PluginStatusSchema,
})

export const PublishVersionRequestSchema = z.object({}).strict().optional().transform(() => ({}))

export const RollbackVersionRequestSchema = z.object({
  targetVersionId: z.string().uuid(),
})

export const ToolManifestEntrySchema = z.object({
  pluginId: z.string().min(1).max(100),
  pluginName: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  hostedUrl: z.string().url(),
  trustTier: TrustTierSchema,
  status: PluginStatusSchema,
  tool: PluginToolSchema,
  permissions: z.array(z.string()),
  networkDomains: z.array(z.string()),
})

export const ToolManifestResponseSchema = z.object({
  tools: z.array(ToolManifestEntrySchema),
})

export const RegistryPolicyResponseSchema = z.object({
  pluginId: z.string().min(1).max(100),
  status: PluginStatusSchema,
  trustTier: TrustTierSchema,
  killSwitchActive: z.boolean(),
  permissions: z.array(z.string()),
  networkDomains: z.array(z.string()),
  collectsInput: z.boolean(),
  inputFields: z.array(InputFieldSchema),
})

export const RegistryUpdateEventSchema = z.object({
  id: z.string().uuid(),
  type: RuntimeEventTypeSchema,
  pluginId: z.string().min(1).max(100),
  pluginVersionId: z.string().uuid().optional(),
  districtId: z.string().uuid().optional(),
  classroomId: z.string().uuid().optional(),
  effectiveAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
})

export const RuntimeEventIngestRequestSchema = z.object({
  pluginId: z.string().min(1).max(100),
  pluginVersionId: z.string().uuid().optional(),
  eventType: RuntimeEventTypeSchema,
  districtId: z.string().uuid().optional(),
  classroomId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).default({}),
})

export const RuntimeIncidentSchema = z.object({
  id: z.string().uuid(),
  pluginId: z.string().min(1).max(100),
  pluginVersionId: z.string().uuid().optional(),
  eventType: RuntimeEventTypeSchema,
  districtId: z.string().uuid().optional(),
  classroomId: z.string().uuid().optional(),
  status: z.enum(['open', 'triaged']),
  severity: z.enum(['info', 'warning', 'high', 'critical']),
  suspensionTriggered: z.boolean(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
})

export const RuntimeControlAuditEntrySchema = z.object({
  id: z.string().uuid(),
  type: RuntimeEventTypeSchema,
  pluginId: z.string().min(1).max(100),
  pluginVersionId: z.string().uuid().optional(),
  districtId: z.string().uuid().optional(),
  classroomId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
})

export const PluginSuspensionRequestSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
  actor: z.string().min(1).max(100).optional(),
}).default({})

export const RuntimeRegistryUpdateStreamRequestSchema = z.object({
  districtId: z.string().uuid().optional(),
  classroomId: z.string().uuid().optional(),
  pluginId: z.string().min(1).max(100).optional(),
  since: z.string().datetime().optional(),
})

export type DeveloperPlatformUserRole = z.infer<typeof DeveloperPlatformUserRoleSchema>
export type PluginStatus = z.infer<typeof PluginStatusSchema>
export type PluginVersionStatus = z.infer<typeof PluginVersionStatusSchema>
export type TrustTier = z.infer<typeof TrustTierSchema>
export type ReviewDecisionType = z.infer<typeof ReviewDecisionTypeSchema>
export type ReviewChecklistItemId = z.infer<typeof ReviewChecklistItemIdSchema>
export type ReviewChecklistStatus = z.infer<typeof ReviewChecklistStatusSchema>
export type ReviewReasonCode = z.infer<typeof ReviewReasonCodeSchema>
export type ReviewEvidenceSource = z.infer<typeof ReviewEvidenceSourceSchema>
export type EscalationPath = z.infer<typeof EscalationPathSchema>
export type ScanCategory = z.infer<typeof ScanCategorySchema>
export type ScanRuleAction = z.infer<typeof ScanRuleActionSchema>
export type StaticAnalysisApproach = z.infer<typeof StaticAnalysisApproachSchema>
export type BlockedPatternFamily = z.infer<typeof BlockedPatternFamilySchema>
export type ScanSeverity = z.infer<typeof ScanSeveritySchema>
export type ScanDisposition = z.infer<typeof ScanDispositionSchema>
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>
export type InputField = z.infer<typeof InputFieldSchema>
export type PluginTool = z.infer<typeof PluginToolSchema>
export type PluginManifest = z.infer<typeof PluginManifestSchema>
export type Developer = z.infer<typeof DeveloperSchema>
export type DeveloperInput = z.infer<typeof DeveloperInputSchema>
export type DpaRecord = z.infer<typeof DpaRecordSchema>
export type DpaRecordInput = z.infer<typeof DpaRecordInputSchema>
export type PluginCreateRequest = z.infer<typeof PluginCreateRequestSchema>
export type PluginVersionCreateRequest = z.infer<typeof PluginVersionCreateRequestSchema>
export type ArtifactUploadMetadata = z.infer<typeof ArtifactUploadMetadataSchema>
export type ArtifactInventoryEntry = z.infer<typeof ArtifactInventoryEntrySchema>
export type ArtifactInventory = z.infer<typeof ArtifactInventorySchema>
export type ObservedInputSurface = z.infer<typeof ObservedInputSurfaceSchema>
export type ScanFinding = z.infer<typeof ScanFindingSchema>
export type ScanThreshold = z.infer<typeof ScanThresholdSchema>
export type BlockedPatternRule = z.infer<typeof BlockedPatternRuleSchema>
export type DependencyPolicy = z.infer<typeof DependencyPolicySchema>
export type SecurityScanPolicy = z.infer<typeof SecurityScanPolicySchema>
export type ScanRun = z.infer<typeof ScanRunSchema>
export type ManifestPolicyVerificationResult = z.infer<typeof ManifestPolicyVerificationResultSchema>
export type ReviewScanContext = z.infer<typeof ReviewScanContextSchema>
export type ReviewChecklistResult = z.infer<typeof ReviewChecklistResultSchema>
export type ReviewerEvidence = z.infer<typeof ReviewerEvidenceSchema>
export type ReviewWaiver = z.infer<typeof ReviewWaiverSchema>
export type ReviewEscalation = z.infer<typeof ReviewEscalationSchema>
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>
export type ReviewRubric = z.infer<typeof ReviewRubricSchema>
export type ScanEvaluationInput = z.infer<typeof ScanEvaluationInputSchema>
export type ScanEvaluationResult = z.infer<typeof ScanEvaluationResultSchema>
export type ScanRunCreateRequest = z.infer<typeof ScanRunCreateRequestSchema>
export type PublishMetadata = z.infer<typeof PublishMetadataSchema>
export type RegistryApp = z.infer<typeof RegistryAppSchema>
export type RegistryAppsResponse = z.infer<typeof RegistryAppsResponseSchema>
export type RegistryContextRequest = z.infer<typeof RegistryContextRequestSchema>
export type DistrictPluginOverrideRequest = z.infer<typeof DistrictPluginOverrideRequestSchema>
export type DistrictPluginOverride = z.infer<typeof DistrictPluginOverrideSchema>
export type RuntimeRegistryVersion = z.infer<typeof RuntimeRegistryVersionSchema>
export type PublishVersionRequest = z.infer<typeof PublishVersionRequestSchema>
export type RollbackVersionRequest = z.infer<typeof RollbackVersionRequestSchema>
export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>
export type ToolManifestResponse = z.infer<typeof ToolManifestResponseSchema>
export type RegistryPolicyResponse = z.infer<typeof RegistryPolicyResponseSchema>
export type RegistryUpdateEvent = z.infer<typeof RegistryUpdateEventSchema>
export type RuntimeEventIngestRequest = z.infer<typeof RuntimeEventIngestRequestSchema>
export type RuntimeIncident = z.infer<typeof RuntimeIncidentSchema>
export type RuntimeControlAuditEntry = z.infer<typeof RuntimeControlAuditEntrySchema>
export type PluginSuspensionRequest = z.infer<typeof PluginSuspensionRequestSchema>
export type RuntimeRegistryUpdateStreamRequest = z.infer<typeof RuntimeRegistryUpdateStreamRequestSchema>
