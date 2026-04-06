import {
  type ArtifactInventory,
  type ArtifactInventoryEntry,
  type ArtifactUploadMetadata,
  type Developer,
  type DeveloperInput,
  type DpaRecord,
  type DpaRecordInput,
  type ManifestPolicyVerificationResult,
  type ObservedInputSurface,
  type ScanRun,
  type ScanEvaluationResult,
  type ScanFinding,
  type SecurityScanPolicy,
  type PluginManifest,
  type PluginStatus,
  type PluginVersionStatus,
  type PublishMetadata,
  type RegistryUpdateEvent,
  type RegistryApp,
  type RuntimeRegistryVersion,
  type RegistryPolicyResponse,
  type RuntimeControlAuditEntry,
  type RuntimeEventIngestRequest,
  type RuntimeIncident,
  type DistrictPluginOverrideRequest,
  type PluginSuspensionRequest,
  type ReviewDecisionRequest,
  type ReviewRubric,
  type ToolManifestResponse,
  type TrustTier,
} from '@chatbridge/shared'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import path from 'node:path'

type PluginRecord = {
  id: string
  developerId: string
  slug: string
  name: string
  description: string
  status: PluginStatus
  trustTier: TrustTier
  createdAt: string
}

type DeveloperRecord = Developer

type DpaRecordEntry = DpaRecord

type PluginVersionRecord = {
  id: string
  pluginId: string
  version: string
  manifest: PluginManifest
  status: PluginVersionStatus
  artifact: ArtifactUploadMetadata | null
  artifactInventory?: ArtifactInventory
  submittedAt?: string
  approvedAt?: string
  publishMetadata?: PublishMetadata
}

type ReviewDecisionRecord = ReviewDecisionRequest & {
  id: string
  pluginId: string
  pluginVersionId: string
  createdAt: string
  outcome: 'approved' | 'rejected' | 'escalated'
}

type DistrictPluginOverrideRecord = {
  districtId: string
  pluginId: string
  enabled: boolean
  updatedAt: string
}

type StoreState = {
  developers: DeveloperRecord[]
  dpaRecords: DpaRecordEntry[]
  plugins: PluginRecord[]
  versions: PluginVersionRecord[]
  scanRuns: ScanRun[]
  reviewDecisions: ReviewDecisionRecord[]
  districtPluginOverrides: DistrictPluginOverrideRecord[]
  runtimeEvents: RegistryUpdateEvent[]
  runtimeControlAudit: RuntimeControlAuditEntry[]
  runtimeIncidents: RuntimeIncident[]
}

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), '.data', 'developer-platform-store.json')

function buildDefaultDeveloper(slug: string): DeveloperInput {
  const normalizedSlug = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const label = normalizedSlug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

  return {
    name: `${label || 'Plugin'} Developer`,
    email: `${normalizedSlug || 'plugin'}@developers.chatbridge.local`,
    organization: 'Independent Developer',
  }
}

const SECURITY_SCAN_POLICY: SecurityScanPolicy = {
  rulesetVersion: 'dp-sec-v1',
  staticAnalysisApproach: [
    'ast_and_signature_scan',
    'bundle_structure_inspection',
    'manifest_policy_cross_check',
    'dependency_sca',
  ],
  proofRequirements: [
    'Every finding must identify the triggering rule or explicitly state why a signature could not be resolved.',
    'Policy outcomes must be traceable to a rulesetVersion recorded on the scan run.',
    'Manual-review outcomes still require concrete evidence such as suspicious files, network destinations, or dependency advisories.',
  ],
  thresholds: [
    { severity: 'critical', action: 'fail', rationale: 'Critical findings block submission because they indicate unsafe or deceptive behavior.' },
    { severity: 'high', action: 'manual_review', rationale: 'High-severity findings require reviewer triage unless a rule marks them as an automatic fail.' },
    { severity: 'warning', action: 'warn', rationale: 'Warnings stay visible to reviewers but do not block submission on their own.' },
    { severity: 'info', action: 'warn', rationale: 'Informational findings are retained for auditability.' },
  ],
  dependencyPolicy: {
    scaRequired: true,
    failOnKnownExploited: true,
    failOnCriticalUnpatched: true,
    manualReviewOnUnknownLicense: true,
    warnOnStalePackagesDays: 180,
  },
  blockedPatterns: [
    {
      ruleId: 'static-dynamic-code-exec',
      family: 'dynamic_code_execution',
      category: 'static_analysis',
      action: 'fail',
      severity: 'critical',
      title: 'Dynamic code execution is prohibited',
      description: 'Submitted artifacts may not use eval, Function constructors, dynamic import bootstraps intended to hide behavior, or equivalent runtime code generation.',
      examples: ['eval(userInput)', 'new Function(scriptBody)', 'setTimeout("malicious()", 10)'],
      evidentiaryNotes: ['Record the exact matched token or AST node', 'Include the file path and surrounding code fragment hash'],
    },
    {
      ruleId: 'static-tracking-sdk',
      family: 'tracking_sdk',
      category: 'static_analysis',
      action: 'fail',
      severity: 'high',
      title: 'Tracking and analytics SDKs are blocked by default',
      description: 'Third-party tracking SDKs, fingerprinting libraries, and behavioral analytics beacons are not allowed in student-facing plugins.',
      examples: ['segment analytics', 'mixpanel', 'amplitude', 'fingerprintjs'],
      evidentiaryNotes: ['Identify package names or script URLs', 'Note whether the SDK is bundled or fetched remotely'],
    },
    {
      ruleId: 'network-undeclared-domain',
      family: 'undeclared_network_access',
      category: 'policy_mismatch',
      action: 'fail',
      severity: 'high',
      title: 'Undeclared network destinations are blocked',
      description: 'Any outbound destination not declared in networkDomains is a hard block because runtime behavior must match the submission contract.',
      examples: ['fetch to undeclared api.evil.example', 'websocket to undeclared host', 'image beacon to undeclared analytics domain'],
      evidentiaryNotes: ['Include the observed destination', 'Record the manifest domains that were declared at submission time'],
    },
    {
      ruleId: 'bundle-obfuscation',
      family: 'obfuscation',
      category: 'artifact_integrity',
      action: 'manual_review',
      severity: 'high',
      title: 'Heavy obfuscation requires manual review',
      description: 'Packed or intentionally obscured bundles require reviewer triage because they can hide undeclared behavior.',
      examples: ['long encoded bootstrap strings', 'self-defending obfuscator signatures', 'single-line minified bootstrap with anti-debug logic'],
      evidentiaryNotes: ['Capture the suspicious artifact path', 'Describe why the pattern exceeds normal minification'],
    },
    {
      ruleId: 'bundle-suspicious-loader',
      family: 'suspicious_bundling_behavior',
      category: 'artifact_integrity',
      action: 'manual_review',
      severity: 'high',
      title: 'Suspicious bundling or loader behavior needs triage',
      description: 'Artifacts that unpack hidden payloads, lazy-fetch code, or reconstruct executable content after review need human investigation.',
      examples: ['base64 decoded script payload', 'zip loader that writes executable content', 'remote script bootstrapper'],
      evidentiaryNotes: ['Identify the loader file and payload path', 'Record whether the payload is local or fetched remotely'],
    },
    {
      ruleId: 'dep-known-exploited',
      family: 'suspicious_bundling_behavior',
      category: 'dependency',
      action: 'fail',
      severity: 'critical',
      title: 'Known exploited or critical unpatched dependencies fail the scan',
      description: 'SCA findings tied to known exploited or critical unpatched vulnerabilities block approval until remediated.',
      examples: ['CISA KEV package match', 'critical CVE without fix applied'],
      evidentiaryNotes: ['Include advisory identifiers', 'Record affected package and resolved version range'],
    },
    {
      ruleId: 'dep-unknown-license',
      family: 'suspicious_bundling_behavior',
      category: 'dependency',
      action: 'manual_review',
      severity: 'warning',
      title: 'Unknown dependency licenses require manual review',
      description: 'Dependencies with missing or ambiguous licensing need reviewer triage before classroom distribution.',
      examples: ['package with no SPDX license', 'custom nonstandard license text'],
      evidentiaryNotes: ['Include package name and license metadata', 'State whether the package is directly declared or transitive'],
    },
  ],
  notes: [
    'Production plugin delivery remains platform-controlled and versioned regardless of scan outcome.',
    'Developer declarations are not sufficient to override blocked patterns.',
    'Manual-review findings do not clear themselves; reviewers must disposition them explicitly.',
  ],
}

const REVIEW_RUBRIC: ReviewRubric = {
  checklist: [
    {
      itemId: 'platform_hosting_only',
      label: 'Production delivery stays platform-hosted',
      hardBlockOnFail: true,
      waiverAllowed: false,
      reviewerPrompt: 'Confirm the approved runtime URL is platform-controlled and versioned. Developer-hosted production URLs are never acceptable.',
    },
    {
      itemId: 'manifest_matches_artifact',
      label: 'Manifest matches the reviewed artifact',
      hardBlockOnFail: true,
      waiverAllowed: false,
      reviewerPrompt: 'Compare declared entrypoint, permissions, resources, and version metadata against the uploaded artifact and extracted contents.',
    },
    {
      itemId: 'declared_network_domains_match_observed_behavior',
      label: 'Observed network behavior matches declared domains',
      hardBlockOnFail: true,
      waiverAllowed: false,
      reviewerPrompt: 'Use runtime evidence and scanner output to verify that no undeclared network destinations are contacted.',
    },
    {
      itemId: 'tool_contract_matches_runtime_behavior',
      label: 'Tool contract matches runtime behavior',
      hardBlockOnFail: true,
      waiverAllowed: false,
      reviewerPrompt: 'Confirm tool schemas, permissions, and side effects align with what the artifact actually does at runtime.',
    },
    {
      itemId: 'data_collection_and_permissions_disclosed',
      label: 'Data collection and permissions are fully disclosed',
      hardBlockOnFail: true,
      waiverAllowed: false,
      reviewerPrompt: 'Verify the manifest and policy disclosures cover all collected inputs, sensitive fields, and permission use.',
    },
    {
      itemId: 'age_rating_and_student_safety_reviewed',
      label: 'Age rating and student-safety suitability are reviewed',
      hardBlockOnFail: true,
      waiverAllowed: true,
      reviewerPrompt: 'Confirm the plugin is suitable for the declared audience and does not introduce unsafe or manipulative flows.',
    },
    {
      itemId: 'security_findings_triaged',
      label: 'Security findings are triaged with disposition',
      hardBlockOnFail: true,
      waiverAllowed: true,
      reviewerPrompt: 'Every scan or runtime finding needs a disposition, rationale, and either remediation, waiver, or escalation.',
    },
    {
      itemId: 'runtime_evidence_captured',
      label: 'Runtime evidence captured by the platform reviewer',
      hardBlockOnFail: true,
      waiverAllowed: false,
      reviewerPrompt: 'Approval requires reviewer-captured runtime or artifact-verification evidence, not only developer assertions.',
    },
  ],
  proofRequirements: [
    'At least one platform-generated or reviewer-captured proof artifact must be attached for every decision.',
    'Clean approvals require evidence that covers both artifact integrity or scanner results and observed runtime behavior.',
    'Each checklist item must be resolved explicitly as pass, fail, or waived with notes.',
  ],
  insufficientProofExamples: [
    'Developer statement without independent reviewer verification.',
    'Manifest fields copied into notes without runtime or artifact comparison.',
    'Approval notes that mention scans passed but omit finding IDs, captured evidence, or reviewer observations.',
  ],
  escalationPaths: [
    {
      path: 'security',
      triggers: [
        'Obfuscated bundles, artifact integrity anomalies, or undeclared executable behavior.',
        'Unexpected network destinations, secret handling, or privilege expansion.',
      ],
    },
    {
      path: 'legal_privacy',
      triggers: [
        'Unclear data policy, student-data collection ambiguity, or DPA mismatch.',
      ],
    },
    {
      path: 'trust_safety',
      triggers: [
        'Age-rating uncertainty, unsafe student interaction patterns, or manipulative content.',
      ],
    },
    {
      path: 'platform_architecture',
      triggers: [
        'Runtime contract mismatch that requires control-plane or ChatBridge runtime changes.',
      ],
    },
  ],
  reasonCodes: [
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
  ],
}

function toRegistryApp(plugin: PluginRecord, version: PluginVersionRecord): RegistryApp {
  const hostedUrl = version.publishMetadata?.hostedUrl
    ?? `https://plugins.chatbridge.app/${plugin.slug}/v${version.version}/`

  return {
    pluginId: plugin.slug,
    name: plugin.name,
    version: version.version,
    trustTier: plugin.trustTier,
    status: plugin.status,
    enabled: plugin.status === 'approved' && version.status === 'published',
    ageRating: version.manifest.ageRating,
    hostedUrl,
    permissions: version.manifest.permissions,
    networkDomains: version.manifest.networkDomains,
    collectsInput: version.manifest.collectsInput,
    inputFields: version.manifest.inputFields,
    tools: version.manifest.tools,
  }
}

function buildPublishMetadata(pluginSlug: string, version: PluginVersionRecord, publishedAt: string): PublishMetadata {
  return {
    pluginId: pluginSlug,
    pluginVersionId: version.id,
    version: version.version,
    hostedUrl: `https://plugins.chatbridge.app/${pluginSlug}/v${version.version}/`,
    artifactSha256: version.artifact?.sha256 ?? 'unknown',
    publishedAt,
  }
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))
  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index]! : 0
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index]! : 0
    if (leftValue !== rightValue) {
      return leftValue - rightValue
    }
  }

  return left.localeCompare(right)
}

function normalizeArchivePath(entryPath: string): string {
  const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'))
  if (
    !normalized ||
    normalized === '.'
    || normalized.startsWith('../')
    || normalized === '..'
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error('unsafe_archive_path')
  }
  return normalized
}

async function extractArtifactTextEntries(fileName: string, body: Buffer): Promise<Array<{ path: string; content: string }>> {
  const lowerFileName = fileName.toLowerCase()

  try {
    const zip = await JSZip.loadAsync(body)
    const entries: Array<{ path: string; content: string }> = []

    for (const [rawPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue

      if (typeof entry.unsafeOriginalName === 'string') {
        normalizeArchivePath(entry.unsafeOriginalName)
      }

      const normalizedPath = normalizeArchivePath(rawPath)
      if (!/\.(html?|js|mjs|cjs|jsx|ts|tsx|json|css|svg|txt)$/i.test(normalizedPath)) {
        continue
      }

      entries.push({
        path: normalizedPath,
        content: await entry.async('text'),
      })
    }

    return entries
  } catch {
    if (/\.(html?|js|mjs|cjs|jsx|ts|tsx|json|css|svg|txt)$/i.test(lowerFileName)) {
      return [{ path: path.basename(fileName), content: body.toString('utf8') }]
    }
    return []
  }
}

async function extractStoredArtifactTextEntries(filePath: string, artifactFileName: string): Promise<Array<{ path: string; content: string }>> {
  const artifactBytes = await readFile(filePath)
  return extractArtifactTextEntries(artifactFileName, artifactBytes)
}

function analyzeStaticArtifactFindings(entries: Array<{ path: string; content: string }>): ScanFinding[] {
  const findings: ScanFinding[] = []

  for (const entry of entries) {
    const content = entry.content

    if (
      /\beval\s*\(/.test(content)
      || /\bnew Function\s*\(/.test(content)
      || /\bsetTimeout\s*\(\s*["'`]/.test(content)
    ) {
      findings.push({
        code: 'DYN-001',
        ruleId: 'static-dynamic-code-exec',
        category: 'static_analysis',
        severity: 'critical',
        disposition: 'fail',
        message: `Dynamic code execution signature detected in ${entry.path}`,
        path: entry.path,
      })
    }

    if (/\bmixpanel\b/i.test(content) || /\bamplitude\b/i.test(content) || /\bsegment\b/i.test(content) || /\bfingerprintjs\b/i.test(content)) {
      findings.push({
        code: 'TRK-001',
        ruleId: 'static-tracking-sdk',
        category: 'static_analysis',
        severity: 'high',
        disposition: 'fail',
        message: `Tracking or analytics SDK signature detected in ${entry.path}`,
        path: entry.path,
      })
    }

    if (
      /\batob\s*\(/.test(content)
      || /[A-Za-z0-9+/=]{120,}/.test(content)
      || /self[-_\s]?defending/i.test(content)
    ) {
      findings.push({
        code: 'BND-041',
        ruleId: 'bundle-obfuscation',
        category: 'artifact_integrity',
        severity: 'high',
        disposition: 'manual_review',
        message: `Obfuscation or encoded payload signature detected in ${entry.path}`,
        path: entry.path,
      })
    }
  }

  const deduped = new Map<string, ScanFinding>()
  for (const finding of findings) {
    const key = `${finding.ruleId ?? finding.code}:${finding.path ?? ''}`
    if (!deduped.has(key)) {
      deduped.set(key, finding)
    }
  }

  return [...deduped.values()]
}

function analyzeInventoryFindings(inventory: ArtifactInventory | null): ScanFinding[] {
  if (!inventory) return []

  const findings: ScanFinding[] = []
  for (const entry of inventory.entries) {
    if (/\.(zip|tar|tgz|gz|7z|rar)$/i.test(entry.path)) {
      findings.push({
        code: 'BND-051',
        ruleId: 'bundle-suspicious-loader',
        category: 'artifact_integrity',
        severity: 'high',
        disposition: 'manual_review',
        message: `Nested archive detected in artifact inventory: ${entry.path}`,
        path: entry.path,
      })
    }
  }

  return findings
}

async function buildArtifactInventory(fileName: string, body: Buffer): Promise<ArtifactInventory> {
  try {
    const zip = await JSZip.loadAsync(body)
    const entries: ArtifactInventoryEntry[] = []

    for (const [rawPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue

      if (typeof entry.unsafeOriginalName === 'string') {
        normalizeArchivePath(entry.unsafeOriginalName)
      }

      const normalizedPath = normalizeArchivePath(rawPath)
      const bytes = Buffer.from(await entry.async('nodebuffer'))
      entries.push({
        path: normalizedPath,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }

    entries.sort((a, b) => a.path.localeCompare(b.path))

    return {
      fileCount: entries.length,
      totalUncompressedBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      entries,
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'unsafe_archive_path') {
      throw error
    }

    return {
      fileCount: 1,
      totalUncompressedBytes: body.byteLength,
      entries: [
        {
          path: path.basename(fileName),
          sizeBytes: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
        },
      ],
    }
  }
}

async function loadState(filePath: string): Promise<StoreState> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreState>
    return {
      developers: parsed.developers ?? [],
      dpaRecords: parsed.dpaRecords ?? [],
      plugins: parsed.plugins ?? [],
      versions: parsed.versions ?? [],
      scanRuns: parsed.scanRuns ?? [],
      reviewDecisions: parsed.reviewDecisions ?? [],
      districtPluginOverrides: parsed.districtPluginOverrides ?? [],
      runtimeEvents: parsed.runtimeEvents ?? [],
      runtimeControlAudit: parsed.runtimeControlAudit ?? [],
      runtimeIncidents: parsed.runtimeIncidents ?? [],
    }
  } catch {
    return {
      developers: [],
      dpaRecords: [],
      plugins: [],
      versions: [],
      scanRuns: [],
      reviewDecisions: [],
      districtPluginOverrides: [],
      runtimeEvents: [],
      runtimeControlAudit: [],
      runtimeIncidents: [],
    }
  }
}

async function saveState(filePath: string, state: StoreState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8')
}

export async function createDeveloperPlatformStore(filePath = DEFAULT_STORE_PATH) {
  let state = await loadState(filePath)
  const artifactRoot = path.join(path.dirname(filePath), 'artifacts')
  const activeScanJobs = new Map<string, Promise<void>>()
  const runtimeEventSubscribers = new Set<(event: RegistryUpdateEvent) => void>()

  const persist = async () => {
    await saveState(filePath, state)
  }

  const findPluginBySlug = (slug: string) => state.plugins.find((plugin) => plugin.slug === slug) ?? null
  const findDeveloperById = (developerId: string) => state.developers.find((developer) => developer.id === developerId) ?? null
  const hasPublishedVersion = (pluginId: string) => state.versions.some(
    (version) => version.pluginId === pluginId && version.status === 'published',
  )
  const getDistrictOverride = (districtId: string | undefined, pluginId: string) => (
    districtId
      ? state.districtPluginOverrides.find((entry) => entry.districtId === districtId && entry.pluginId === pluginId) ?? null
      : null
  )
  const resolveRuntimeIncidentSeverity = (metadata: Record<string, unknown>): RuntimeIncident['severity'] => {
    const candidate = metadata.severity
    return candidate === 'critical' || candidate === 'high' || candidate === 'warning' || candidate === 'info'
      ? candidate
      : 'warning'
  }
  const isIncidentThresholdCandidate = (incident: RuntimeIncident) => (
    ['runtime_violation', 'unexpected_network_request'].includes(incident.eventType)
    && ['high', 'critical'].includes(incident.severity)
  )
  const matchesRuntimeUpdateContext = (
    entry: RegistryUpdateEvent,
    context: {
      districtId?: string
      classroomId?: string
      pluginId?: string
      since?: string
    },
  ) => (
    (context.pluginId ? entry.pluginId === context.pluginId : true)
    && (context.districtId ? !entry.districtId || entry.districtId === context.districtId : true)
    && (context.classroomId ? !entry.classroomId || entry.classroomId === context.classroomId : true)
    && (context.since ? entry.effectiveAt >= context.since : true)
  )

  const recordRuntimeEvent = async (
    type: RegistryUpdateEvent['type'],
    input: {
      pluginId: string
      pluginVersionId?: string
      districtId?: string
      classroomId?: string
      metadata?: Record<string, unknown>
      effectiveAt?: string
    },
  ) => {
    const effectiveAt = input.effectiveAt ?? new Date().toISOString()
    const event: RegistryUpdateEvent = {
      id: randomUUID(),
      type,
      pluginId: input.pluginId,
      pluginVersionId: input.pluginVersionId,
      districtId: input.districtId,
      classroomId: input.classroomId,
      effectiveAt,
      metadata: input.metadata ?? {},
    }
    const auditEntry: RuntimeControlAuditEntry = {
      id: event.id,
      type: event.type,
      pluginId: event.pluginId,
      pluginVersionId: event.pluginVersionId,
      districtId: event.districtId,
      classroomId: event.classroomId,
      createdAt: effectiveAt,
      metadata: event.metadata ?? {},
    }

    state = {
      ...state,
      runtimeEvents: [...state.runtimeEvents, event],
      runtimeControlAudit: [...state.runtimeControlAudit, auditEntry],
    }
    await persist()
    for (const subscriber of runtimeEventSubscribers) {
      subscriber(event)
    }
    return event
  }
  const resolveActivePublishedVersion = (pluginId: string) => state.versions
    .filter((version) => version.pluginId === pluginId && version.status === 'published')
    .sort((left, right) => {
      const publishedAtDiff = (right.publishMetadata?.publishedAt ?? '').localeCompare(left.publishMetadata?.publishedAt ?? '')
      if (publishedAtDiff !== 0) return publishedAtDiff
      return compareVersionStrings(right.version, left.version)
    })[0] ?? null

  const updateScanRun = async (
    scanRunId: string,
    updater: (current: ScanRun) => ScanRun,
  ) => {
    const current = state.scanRuns.find((entry) => entry.id === scanRunId) ?? null
    if (!current) return null

    const next = updater(current)
    state = {
      ...state,
      scanRuns: state.scanRuns.map((entry) => (entry.id === scanRunId ? next : entry)),
    }
    await persist()
    return next
  }

  const finalizeScanRun = async (scanRunId: string, pluginSlug: string, versionId: string, findings: ScanFinding[]) => {
    const plugin = findPluginBySlug(pluginSlug)
    const version = state.versions.find((entry) => entry.id === versionId) ?? null
    if (!plugin || !version || version.pluginId !== plugin.id) {
      await updateScanRun(scanRunId, (current) => ({
        ...current,
        status: 'failed',
        completedAt: new Date().toISOString(),
      }))
      return
    }

    await updateScanRun(scanRunId, (current) => ({ ...current, status: 'running' }))

    try {
      const artifactPath = version.artifact?.storageKey
        ? path.join(path.dirname(filePath), version.artifact.storageKey)
        : null
      const staticArtifactFindings = artifactPath
        ? analyzeStaticArtifactFindings(await extractStoredArtifactTextEntries(artifactPath, version.artifact?.fileName ?? ''))
        : []
      const inventoryFindings = analyzeInventoryFindings(version.artifactInventory ?? null)
      const verification = await api.verifyManifestAgainstArtifact(pluginSlug, versionId)
      const combinedFindings = [...verification.findings, ...staticArtifactFindings, ...inventoryFindings, ...findings]
      const evaluation = api.evaluateScanFindings(combinedFindings, SECURITY_SCAN_POLICY.rulesetVersion)
      const completedAt = new Date().toISOString()

      await updateScanRun(scanRunId, (current) => ({
        ...current,
        status: 'completed',
        overallDisposition: evaluation.overallDisposition,
        findings: combinedFindings,
        completedAt,
      }))

      const nextVersionStatus: PluginVersionStatus = evaluation.overallDisposition === 'fail'
        ? 'scan_failed'
        : 'awaiting_review'

      state = {
        ...state,
        versions: state.versions.map((entry) => (
          entry.id === versionId
            ? { ...entry, status: nextVersionStatus }
            : entry
        )),
      }
      await persist()
    } catch {
      await updateScanRun(scanRunId, (current) => ({
        ...current,
        status: 'failed',
        completedAt: new Date().toISOString(),
      }))
      state = {
        ...state,
        versions: state.versions.map((entry) => (
          entry.id === versionId
            ? { ...entry, status: 'scan_failed' }
            : entry
        )),
      }
      await persist()
    } finally {
      activeScanJobs.delete(scanRunId)
    }
  }

  const enqueueScanRun = (scanRunId: string, pluginSlug: string, versionId: string, findings: ScanFinding[]) => {
    const job = Promise.resolve().then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await finalizeScanRun(scanRunId, pluginSlug, versionId, findings)
    })
    activeScanJobs.set(scanRunId, job)
    void job
  }

  const api = {
    getSecurityScanPolicy() {
      return SECURITY_SCAN_POLICY
    },

    evaluateScanFindings(findings: ScanFinding[], rulesetVersion: string): ScanEvaluationResult {
      if (rulesetVersion !== SECURITY_SCAN_POLICY.rulesetVersion) {
        throw new Error(`scan_ruleset_unknown:${rulesetVersion}`)
      }

      let overallDisposition: ScanEvaluationResult['overallDisposition'] = 'pass'
      let thresholdReason = 'No findings triggered warn, manual review, or fail thresholds.'

      for (const finding of findings) {
        const matchingRule = finding.ruleId
          ? SECURITY_SCAN_POLICY.blockedPatterns.find((rule) => rule.ruleId === finding.ruleId)
          : null
        const threshold = SECURITY_SCAN_POLICY.thresholds.find((entry) => entry.severity === finding.severity)

        const action = matchingRule?.action ?? threshold?.action ?? 'warn'

        if (action === 'fail') {
          overallDisposition = 'fail'
          thresholdReason = `Finding ${finding.code} triggered fail via ${matchingRule?.ruleId ?? `severity:${finding.severity}`}.`
          break
        }

        if (action === 'manual_review') {
          overallDisposition = 'manual_review'
          thresholdReason = `Finding ${finding.code} requires manual review via ${matchingRule?.ruleId ?? `severity:${finding.severity}`}.`
          continue
        }

        if (action === 'warn' && overallDisposition === 'pass') {
          overallDisposition = 'warn'
          thresholdReason = `Finding ${finding.code} triggered warning threshold ${matchingRule?.ruleId ?? `severity:${finding.severity}`}.`
        }
      }

      return {
        rulesetVersion,
        overallDisposition,
        thresholdReason,
      }
    },

    getReviewRubric() {
      return REVIEW_RUBRIC
    },

    async createPlugin(input: { slug: string; name: string; description: string; developer?: DeveloperInput; dpaRecord?: DpaRecordInput }) {
      if (findPluginBySlug(input.slug)) {
        throw new Error(`plugin_slug_conflict:${input.slug}`)
      }

      const timestamp = new Date().toISOString()
      const developerInput = input.developer ?? buildDefaultDeveloper(input.slug)
      const existingDeveloper = state.developers.find((entry) => entry.email === developerInput.email) ?? null
      const developer: DeveloperRecord = existingDeveloper ?? {
        id: randomUUID(),
        name: developerInput.name,
        email: developerInput.email,
        organization: developerInput.organization,
        createdAt: timestamp,
      }
      const dpaRecord: DpaRecordEntry = {
        id: randomUUID(),
        developerId: developer.id,
        status: input.dpaRecord?.status ?? 'not_started',
        documentUrl: input.dpaRecord?.documentUrl,
        approvedAt: input.dpaRecord?.approvedAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const plugin: PluginRecord = {
        id: randomUUID(),
        developerId: developer.id,
        slug: input.slug,
        name: input.name,
        description: input.description,
        status: 'draft',
        trustTier: 'dev-only',
        createdAt: timestamp,
      }

      state = {
        ...state,
        developers: existingDeveloper ? state.developers : [...state.developers, developer],
        dpaRecords: [...state.dpaRecords, dpaRecord],
        plugins: [...state.plugins, plugin],
      }
      await persist()
      return plugin
    },

    async createVersion(pluginSlug: string, input: { version: string; manifest: PluginManifest }) {
      const plugin = findPluginBySlug(pluginSlug)
      if (!plugin) {
        throw new Error(`plugin_not_found:${pluginSlug}`)
      }

      if (input.manifest.pluginId !== plugin.slug) {
        throw new Error(`manifest_plugin_id_mismatch:${plugin.slug}:${input.manifest.pluginId}`)
      }

      const duplicate = state.versions.find(
        (version) => version.pluginId === plugin.id && version.version === input.version,
      )
      if (duplicate) {
        throw new Error(`plugin_version_conflict:${pluginSlug}:${input.version}`)
      }

      const version: PluginVersionRecord = {
        id: randomUUID(),
        pluginId: plugin.id,
        version: input.version,
        manifest: input.manifest,
        status: 'uploaded',
        artifact: null,
      }

      state = {
        ...state,
        versions: [...state.versions, version],
      }
      await persist()
      return version
    },

    async attachArtifact(pluginSlug: string, versionId: string, artifact: ArtifactUploadMetadata) {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }

      const updatedVersion: PluginVersionRecord = { ...version, artifact }
      state = {
        ...state,
        versions: state.versions.map((entry) => (entry.id === versionId ? updatedVersion : entry)),
      }
      await persist()
      return updatedVersion
    },

    async saveArtifactUpload(
      pluginSlug: string,
      versionId: string,
      artifactUpload: { fileName: string; contentType: string; body: Buffer },
    ) {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }

      const safeFileName = path.basename(artifactUpload.fileName)
      let artifactInventory: ArtifactInventory
      try {
        artifactInventory = await buildArtifactInventory(safeFileName, artifactUpload.body)
      } catch (error) {
        if (error instanceof Error && error.message === 'unsafe_archive_path') {
          throw new Error(`artifact_inventory_unsafe_path:${pluginSlug}`)
        }
        throw error
      }

      const storageKey = path.join('artifacts', plugin.slug, version.id, safeFileName)
      const artifactPath = path.join(path.dirname(filePath), storageKey)
      await mkdir(path.dirname(artifactPath), { recursive: true })
      await writeFile(artifactPath, artifactUpload.body)

      const artifact: ArtifactUploadMetadata = {
        fileName: safeFileName,
        contentType: artifactUpload.contentType,
        sizeBytes: artifactUpload.body.byteLength,
        sha256: createHash('sha256').update(artifactUpload.body).digest('hex'),
        storageKey,
      }

      const updatedVersion: PluginVersionRecord = {
        ...version,
        artifact,
        artifactInventory,
      }
      state = {
        ...state,
        versions: state.versions.map((entry) => (entry.id === versionId ? updatedVersion : entry)),
      }
      await persist()
      return artifact
    },

    async createScanRun(pluginSlug: string, versionId: string, findings: ScanFinding[]): Promise<ScanRun> {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }
      if (!version.artifact) {
        throw new Error(`artifact_required:${pluginSlug}`)
      }
      if (!['uploaded', 'scan_failed', 'awaiting_review'].includes(version.status)) {
        throw new Error(`scan_state_invalid:${pluginSlug}:${version.status}`)
      }

      const createdAt = new Date().toISOString()
      const scanRun: ScanRun = {
        id: randomUUID(),
        pluginId: plugin.slug,
        pluginVersionId: version.id,
        rulesetVersion: SECURITY_SCAN_POLICY.rulesetVersion,
        status: 'pending',
        overallDisposition: 'warn',
        findings: [],
        createdAt,
      }

      state = {
        ...state,
        versions: state.versions.map((entry) => (
          entry.id === versionId
            ? { ...entry, status: 'scanning' }
            : entry
        )),
        scanRuns: [...state.scanRuns, scanRun],
      }
      await persist()
      enqueueScanRun(scanRun.id, pluginSlug, versionId, findings)
      return scanRun
    },

    async listScanRuns(pluginSlug: string, versionId: string): Promise<ScanRun[]> {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }

      return state.scanRuns
        .filter((scanRun) => scanRun.pluginId === plugin.slug && scanRun.pluginVersionId === version.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    async getArtifactInventory(pluginSlug: string, versionId: string): Promise<ArtifactInventory | null> {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }

      return version.artifactInventory ?? null
    },

    async verifyManifestAgainstArtifact(
      pluginSlug: string,
      versionId: string,
    ): Promise<ManifestPolicyVerificationResult> {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }
      if (!version.artifact?.storageKey) {
        throw new Error(`artifact_required:${pluginSlug}`)
      }

      const artifactPath = path.join(path.dirname(filePath), version.artifact.storageKey)
      const artifactBytes = await readFile(artifactPath)
      const textEntries = await extractArtifactTextEntries(version.artifact.fileName, artifactBytes)

      const observedNetworkDomains = new Set<string>()
      const observedExternalResources = new Set<string>()
      const observedInputSurfaces: ObservedInputSurface[] = []
      const findings: ScanFinding[] = []
      const declaredInputFieldNames = new Set(version.manifest.inputFields.map((field) => field.name))
      const declaredExternalResources = new Set(version.manifest.externalResources)
      const resourceToDomain = new Map<string, string>()

      for (const entry of textEntries) {
        const urlMatches = entry.content.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})([^\s"'<>)]*)?/gi)
        for (const match of urlMatches) {
          const domain = match[1]?.toLowerCase()
          const fullUrl = match[0]
          if (!domain) continue
          observedNetworkDomains.add(domain)
          observedExternalResources.add(fullUrl)
          resourceToDomain.set(fullUrl, domain)
        }

        const inputRegexes: Array<{ kind: ObservedInputSurface['kind']; regex: RegExp }> = [
          { kind: 'html_input', regex: /<input\b([^>]*)>/gi },
          { kind: 'html_textarea', regex: /<textarea\b([^>]*)>/gi },
          { kind: 'html_select', regex: /<select\b([^>]*)>/gi },
          { kind: 'html_form', regex: /<form\b([^>]*)>/gi },
        ]

        for (const { kind, regex } of inputRegexes) {
          for (const match of entry.content.matchAll(regex)) {
            const identifierMatch = /(?:name|id)=["']([^"']+)["']/i.exec(match[1] ?? '')
            observedInputSurfaces.push({
              kind,
              path: entry.path,
              identifier: identifierMatch?.[1],
            })
          }
        }
      }

      for (const resource of [...observedExternalResources].sort()) {
        if (!declaredExternalResources.has(resource)) {
          findings.push({
            code: 'RESOURCE-UNDECLARED',
            category: 'policy_mismatch',
            severity: 'high',
            disposition: 'fail',
            message: `Observed undeclared external resource: ${resource}`,
            metadata: {
              resource,
              domain: resourceToDomain.get(resource),
            },
          })
        }
      }

      for (const domain of [...observedNetworkDomains].sort()) {
        if (!version.manifest.networkDomains.includes(domain) && !version.manifest.externalResources.some((resource) => {
          try {
            return new URL(resource).hostname.toLowerCase() === domain
          } catch {
            return false
          }
        })) {
          findings.push({
            code: 'NET-UNDECLARED',
            ruleId: 'network-undeclared-domain',
            category: 'policy_mismatch',
            severity: 'high',
            disposition: 'fail',
            message: `Observed undeclared network domain: ${domain}`,
            metadata: { domain },
          })
        }
      }

      if (!version.manifest.collectsInput && observedInputSurfaces.length > 0) {
        findings.push({
          code: 'INPUT-UNDECLARED',
          category: 'policy_mismatch',
          severity: 'high',
          disposition: 'fail',
          message: 'Artifact exposes input surfaces while manifest declares collectsInput=false',
          metadata: {
            surfaces: observedInputSurfaces.map((surface) => ({
              kind: surface.kind,
              path: surface.path,
              identifier: surface.identifier,
            })),
          },
        })
      } else if (version.manifest.collectsInput) {
        for (const surface of observedInputSurfaces) {
          if (!surface.identifier) continue
          if (!declaredInputFieldNames.has(surface.identifier)) {
            findings.push({
              code: 'INPUT-FIELD-UNDECLARED',
              category: 'policy_mismatch',
              severity: 'high',
              disposition: 'fail',
              message: `Observed undeclared input field identifier: ${surface.identifier}`,
              metadata: {
                identifier: surface.identifier,
                kind: surface.kind,
                path: surface.path,
              },
            })
          }
        }
      }

      const overallDisposition = findings.some((finding) => finding.disposition === 'fail')
        ? 'fail'
        : findings.some((finding) => finding.disposition === 'manual_review')
          ? 'manual_review'
          : findings.some((finding) => finding.disposition === 'warn')
            ? 'warn'
            : 'pass'

      return {
        pluginId: plugin.slug,
        pluginVersionId: version.id,
        verifiedAt: new Date().toISOString(),
        overallDisposition,
        observedNetworkDomains: [...observedNetworkDomains].sort(),
        observedExternalResources: [...observedExternalResources].sort(),
        observedInputSurfaces,
        findings,
      }
    },

    async submitVersion(pluginSlug: string, versionId: string) {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }
      if (!version.artifact) {
        throw new Error(`artifact_required:${pluginSlug}`)
      }

      const updatedVersion: PluginVersionRecord = {
        ...version,
        submittedAt: new Date().toISOString(),
      }
      const updatedPlugin: PluginRecord = {
        ...plugin,
        status: hasPublishedVersion(plugin.id) ? plugin.status : 'submitted',
      }

      state = {
        ...state,
        plugins: state.plugins.map((entry) => (entry.id === plugin.id ? updatedPlugin : entry)),
        versions: state.versions.map((entry) => (entry.id === versionId ? updatedVersion : entry)),
      }
      await persist()
      const scanRun = await api.createScanRun(pluginSlug, versionId, [])
      await activeScanJobs.get(scanRun.id)

      const finalizedVersion = state.versions.find((entry) => entry.id === versionId) ?? updatedVersion
      return finalizedVersion
    },

    async reviewVersion(pluginSlug: string, versionId: string, decision: ReviewDecisionRequest) {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }

      if (version.status !== 'awaiting_review') {
        throw new Error(`review_state_invalid:${pluginSlug}:${version.status}`)
      }

      const scanRuns = state.scanRuns.filter((entry) => (
        entry.pluginId === plugin.slug
        && entry.pluginVersionId === version.id
        && decision.scanContext.scanRunIds.includes(entry.id)
      ))
      if (scanRuns.length !== decision.scanContext.scanRunIds.length) {
        throw new Error(`scan_run_not_found:${pluginSlug}:${versionId}`)
      }

      const timestamp = new Date().toISOString()
      const reviewDecision: ReviewDecisionRecord = {
        ...decision,
        id: randomUUID(),
        pluginId: plugin.slug,
        pluginVersionId: version.id,
        createdAt: timestamp,
        outcome: decision.decision === 'reject'
          ? 'rejected'
          : decision.decision === 'escalate'
            ? 'escalated'
            : 'approved',
      }

      let updatedPlugin = plugin
      let updatedVersion = version

      if (decision.decision === 'approve' || decision.decision === 'waive') {
        updatedVersion = {
          ...version,
          status: 'approved',
          approvedAt: timestamp,
        }

        updatedPlugin = {
          ...plugin,
          status: 'approved',
          trustTier: 'reviewed',
        }
      } else if (decision.decision === 'reject') {
        updatedVersion = {
          ...version,
          status: 'rejected',
        }
        updatedPlugin = {
          ...plugin,
          status: hasPublishedVersion(plugin.id) ? plugin.status : 'rejected',
        }
      }

      state = {
        ...state,
        plugins: state.plugins.map((entry) => (entry.id === plugin.id ? updatedPlugin : entry)),
        versions: state.versions.map((entry) => (entry.id === versionId ? updatedVersion : entry)),
        reviewDecisions: [...state.reviewDecisions, reviewDecision],
      }
      await persist()
      return {
        version: updatedVersion,
        decision: reviewDecision,
      }
    },

    async publishVersion(pluginSlug: string, versionId: string) {
      const plugin = findPluginBySlug(pluginSlug)
      const version = state.versions.find((entry) => entry.id === versionId) ?? null
      if (!plugin || !version || version.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${versionId}`)
      }

      if (!version.artifact) {
        throw new Error(`artifact_required:${pluginSlug}:${versionId}`)
      }

      if (version.status !== 'approved') {
        throw new Error(`publish_state_invalid:${pluginSlug}:${version.status}`)
      }

      const timestamp = new Date().toISOString()
      const publishedVersion: PluginVersionRecord = {
        ...version,
        status: 'published',
        publishMetadata: buildPublishMetadata(pluginSlug, version, timestamp),
      }
      const updatedPlugin: PluginRecord = {
        ...plugin,
        status: 'approved',
        trustTier: 'reviewed',
      }

      state = {
        ...state,
        plugins: state.plugins.map((entry) => (entry.id === plugin.id ? updatedPlugin : entry)),
        versions: state.versions.map((entry) => {
          if (entry.id === version.id) return publishedVersion
          if (entry.pluginId === plugin.id && entry.status === 'published') {
            return { ...entry, status: 'deprecated' as const }
          }
          return entry
        }),
      }
      await persist()
      await recordRuntimeEvent('plugin_rolled_forward', {
        pluginId: plugin.slug,
        pluginVersionId: version.id,
        effectiveAt: timestamp,
        metadata: {
          action: 'publish',
          activeVersion: publishedVersion.version,
          hostedUrl: publishedVersion.publishMetadata?.hostedUrl,
        },
      })
      return publishedVersion
    },

    async rollbackPublishedVersion(pluginSlug: string, targetVersionId: string) {
      const plugin = findPluginBySlug(pluginSlug)
      const targetVersion = state.versions.find((entry) => entry.id === targetVersionId) ?? null
      if (!plugin || !targetVersion || targetVersion.pluginId !== plugin.id) {
        throw new Error(`plugin_version_not_found:${pluginSlug}:${targetVersionId}`)
      }

      if (!targetVersion.artifact) {
        throw new Error(`artifact_required:${pluginSlug}:${targetVersionId}`)
      }

      if (!['approved', 'published', 'deprecated', 'rolled_back'].includes(targetVersion.status)) {
        throw new Error(`rollback_state_invalid:${pluginSlug}:${targetVersion.status}`)
      }

      const activePublishedVersion = state.versions.find(
        (entry) => entry.pluginId === plugin.id && entry.status === 'published',
      ) ?? null
      if (!activePublishedVersion) {
        throw new Error(`publish_state_invalid:${pluginSlug}:none_published`)
      }

      const timestamp = new Date().toISOString()
      const rolledBackVersion: PluginVersionRecord = {
        ...targetVersion,
        status: 'published',
        publishMetadata: buildPublishMetadata(pluginSlug, targetVersion, timestamp),
      }

      state = {
        ...state,
        versions: state.versions.map((entry) => {
          if (entry.id === rolledBackVersion.id) return rolledBackVersion
          if (entry.id === activePublishedVersion.id) return { ...entry, status: 'deprecated' as const }
          return entry
        }),
      }
      await persist()
      await recordRuntimeEvent('plugin_rolled_back', {
        pluginId: plugin.slug,
        pluginVersionId: targetVersion.id,
        effectiveAt: timestamp,
        metadata: {
          action: 'rollback',
          activeVersion: rolledBackVersion.version,
          previousVersion: activePublishedVersion.version,
          hostedUrl: rolledBackVersion.publishMetadata?.hostedUrl,
        },
      })
      return rolledBackVersion
    },

    async listRegistryApps(): Promise<RegistryApp[]> {
      return state.plugins
        .filter((plugin) => plugin.status !== 'suspended')
        .map((plugin) => {
          const version = resolveActivePublishedVersion(plugin.id)
          return version ? toRegistryApp(plugin, version) : null
        })
        .filter((app): app is RegistryApp => Boolean(app))
    },

    async listRegistryAppsForContext(context: {
      districtId?: string
      classroomId?: string
      includeSuspended?: boolean
    }): Promise<RegistryApp[]> {
      return state.plugins
        .map((plugin) => {
          const version = resolveActivePublishedVersion(plugin.id)
          if (!version) return null

          const app = toRegistryApp(plugin, version)
          const districtOverride = getDistrictOverride(context.districtId, app.pluginId)
          return districtOverride ? { ...app, enabled: districtOverride.enabled && app.enabled } : app
        })
        .filter((app): app is RegistryApp => Boolean(app))
        .filter((app) => context.includeSuspended ? true : app.status !== 'suspended')
        .filter((app) => app.enabled)
        .filter((app) => app.hostedUrl.startsWith('https://plugins.chatbridge.app/'))
    },

    async getRegistryApp(pluginSlug: string): Promise<RegistryApp | null> {
      const plugin = findPluginBySlug(pluginSlug)
      if (!plugin) return null
      if (plugin.status === 'suspended') return null

      const publishedVersion = resolveActivePublishedVersion(plugin.id)
      if (!publishedVersion) return null

      return toRegistryApp(plugin, publishedVersion)
    },

    async getRegistryVersion(pluginSlug: string): Promise<RuntimeRegistryVersion | null> {
      const app = await api.getRegistryApp(pluginSlug)
      if (!app) return null

      return {
        pluginId: app.pluginId,
        activeVersion: app.version,
        hostedUrl: app.hostedUrl,
        trustTier: app.trustTier,
        status: app.status,
      }
    },

    async getToolManifest(context: {
      districtId?: string
      classroomId?: string
      includeSuspended?: boolean
    }): Promise<ToolManifestResponse> {
      const apps = await api.listRegistryAppsForContext(context)

      return {
        tools: apps.flatMap((app) => app.tools.map((tool) => ({
          pluginId: app.pluginId,
          pluginName: app.name,
          version: app.version,
          hostedUrl: app.hostedUrl,
          trustTier: app.trustTier,
          status: app.status,
          tool,
          permissions: app.permissions,
          networkDomains: app.networkDomains,
        }))),
      }
    },

    async getRegistryPolicy(pluginSlug: string): Promise<RegistryPolicyResponse | null> {
      const app = await api.getRegistryApp(pluginSlug)
      if (!app) return null

      return {
        pluginId: app.pluginId,
        status: app.status,
        trustTier: app.trustTier,
        killSwitchActive: app.status === 'suspended',
        permissions: app.permissions,
        networkDomains: app.networkDomains,
        collectsInput: app.collectsInput,
        inputFields: app.inputFields,
      }
    },

    async listAdminPlugins() {
      return state.plugins
        .map((plugin) => {
          const versions = state.versions
            .filter((entry) => entry.pluginId === plugin.id)
            .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: 'base' }))

          const latestVersion = versions[0] ?? null
          const activePublishedVersion = resolveActivePublishedVersion(plugin.id)
          const pendingReviewVersion = versions.find((entry) => entry.status === 'awaiting_review') ?? null
          const scanFailedVersion = versions.find((entry) => entry.status === 'scan_failed') ?? null

          return {
            pluginId: plugin.slug,
            name: plugin.name,
            description: plugin.description,
            developerId: plugin.developerId,
            status: plugin.status,
            trustTier: plugin.trustTier,
            createdAt: plugin.createdAt,
            versionCount: versions.length,
            latestVersion: latestVersion
              ? {
                id: latestVersion.id,
                version: latestVersion.version,
                status: latestVersion.status,
                submittedAt: latestVersion.submittedAt,
                approvedAt: latestVersion.approvedAt,
                hasArtifact: Boolean(latestVersion.artifact),
              }
              : null,
            activePublishedVersion: activePublishedVersion
              ? {
                id: activePublishedVersion.id,
                version: activePublishedVersion.version,
                hostedUrl: activePublishedVersion.publishMetadata?.hostedUrl
                  ?? `https://plugins.chatbridge.app/${plugin.slug}/v${activePublishedVersion.version}/`,
              }
              : null,
            queueStatus: pendingReviewVersion
              ? 'awaiting_review'
              : scanFailedVersion
                ? 'scan_failed'
                : latestVersion?.status ?? 'draft',
          }
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    },

    async getAdminPluginDetail(pluginSlug: string) {
      const plugin = findPluginBySlug(pluginSlug)
      if (!plugin) return null

      const versions = state.versions
        .filter((entry) => entry.pluginId === plugin.id)
        .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: 'base' }))

      const activePublishedVersion = resolveActivePublishedVersion(plugin.id)
      const developer = findDeveloperById(plugin.developerId)
      const dpaRecord = state.dpaRecords
        .filter((entry) => entry.developerId === plugin.developerId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null

      return {
        pluginId: plugin.slug,
        name: plugin.name,
        description: plugin.description,
        developer,
        dpaRecord,
        status: plugin.status,
        trustTier: plugin.trustTier,
        createdAt: plugin.createdAt,
        activePublishedVersionId: activePublishedVersion?.id ?? null,
        versions: versions.map((version) => ({
          id: version.id,
          version: version.version,
          status: version.status,
          manifest: version.manifest,
          artifact: version.artifact,
          submittedAt: version.submittedAt,
          approvedAt: version.approvedAt,
          publishMetadata: version.publishMetadata,
        })),
      }
    },

    async getPluginAudit(pluginSlug: string) {
      const plugin = findPluginBySlug(pluginSlug)
      if (!plugin) return null

      return {
        pluginId: plugin.slug,
        developer: findDeveloperById(plugin.developerId),
        dpaRecords: state.dpaRecords
          .filter((entry) => entry.developerId === plugin.developerId)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
        pluginStatus: plugin.status,
        scanRuns: state.scanRuns
          .filter((entry) => entry.pluginId === plugin.slug)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        reviewDecisions: state.reviewDecisions
          .filter((entry) => entry.pluginId === plugin.slug)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        districtPluginOverrides: state.districtPluginOverrides
          .filter((entry) => entry.pluginId === plugin.slug)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
        controlActions: state.runtimeControlAudit
          .filter((entry) => entry.pluginId === plugin.slug)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        runtimeIncidents: state.runtimeIncidents
          .filter((entry) => entry.pluginId === plugin.slug)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      }
    },

    async getDebugSnapshot() {
      return structuredClone(state)
    },

    async setDistrictPluginOverride(input: DistrictPluginOverrideRequest) {
      if (!findPluginBySlug(input.pluginId)) {
        throw new Error(`plugin_not_found:${input.pluginId}`)
      }

      const existing = state.districtPluginOverrides.find(
        (entry) => entry.districtId === input.districtId && entry.pluginId === input.pluginId,
      ) ?? null

      const nextOverride: DistrictPluginOverrideRecord = {
        districtId: input.districtId,
        pluginId: input.pluginId,
        enabled: input.enabled,
        updatedAt: new Date().toISOString(),
      }

      state = {
        ...state,
        districtPluginOverrides: existing
          ? state.districtPluginOverrides.map((entry) => (
            entry.districtId === input.districtId && entry.pluginId === input.pluginId ? nextOverride : entry
          ))
          : [...state.districtPluginOverrides, nextOverride],
      }
      await persist()
      await recordRuntimeEvent('district_policy_changed', {
        pluginId: input.pluginId,
        districtId: input.districtId,
        effectiveAt: nextOverride.updatedAt,
        metadata: {
          enabled: input.enabled,
        },
      })
      return nextOverride
    },

    async suspendPlugin(
      pluginSlug: string,
      input: PluginSuspensionRequest & { trigger?: string; incidentIds?: string[] } = {},
    ) {
      const plugin = findPluginBySlug(pluginSlug)
      if (!plugin) {
        throw new Error(`plugin_not_found:${pluginSlug}`)
      }

      const nextPlugin: PluginRecord = {
        ...plugin,
        status: 'suspended',
      }

      state = {
        ...state,
        plugins: state.plugins.map((entry) => (entry.id === plugin.id ? nextPlugin : entry)),
      }
      await persist()
      await recordRuntimeEvent('plugin_suspended', {
        pluginId: plugin.slug,
        metadata: {
          actor: input.actor ?? 'platform_admin',
          reason: input.reason ?? 'admin_action',
          trigger: input.trigger,
          incidentIds: input.incidentIds,
        },
      })
      return nextPlugin
    },

    async reinstatePlugin(pluginSlug: string, input: PluginSuspensionRequest = {}) {
      const plugin = findPluginBySlug(pluginSlug)
      if (!plugin) {
        throw new Error(`plugin_not_found:${pluginSlug}`)
      }

      const nextStatus: PluginStatus = hasPublishedVersion(plugin.id) ? 'approved' : 'draft'
      const nextPlugin: PluginRecord = {
        ...plugin,
        status: nextStatus,
      }

      state = {
        ...state,
        plugins: state.plugins.map((entry) => (entry.id === plugin.id ? nextPlugin : entry)),
      }
      await persist()
      await recordRuntimeEvent('plugin_reinstated', {
        pluginId: plugin.slug,
        metadata: {
          actor: input.actor ?? 'platform_admin',
          reason: input.reason ?? 'admin_action',
          restoredStatus: nextStatus,
        },
      })
      return nextPlugin
    },

    async ingestRuntimeEvent(input: RuntimeEventIngestRequest) {
      const plugin = findPluginBySlug(input.pluginId)
      if (!plugin) {
        throw new Error(`plugin_not_found:${input.pluginId}`)
      }

      const incident: RuntimeIncident = {
        id: randomUUID(),
        pluginId: input.pluginId,
        pluginVersionId: input.pluginVersionId,
        eventType: input.eventType,
        districtId: input.districtId,
        classroomId: input.classroomId,
        status: 'open',
        severity: resolveRuntimeIncidentSeverity(input.metadata),
        suspensionTriggered: false,
        createdAt: new Date().toISOString(),
        metadata: input.metadata,
      }

      state = {
        ...state,
        runtimeIncidents: [...state.runtimeIncidents, incident],
      }
      await persist()
      await recordRuntimeEvent(input.eventType, {
        pluginId: input.pluginId,
        pluginVersionId: input.pluginVersionId,
        districtId: input.districtId,
        classroomId: input.classroomId,
        effectiveAt: incident.createdAt,
        metadata: {
          ...input.metadata,
          incidentId: incident.id,
        },
      })

      const thresholdCandidates = state.runtimeIncidents.filter((entry) => (
        entry.pluginId === input.pluginId && isIncidentThresholdCandidate(entry)
      ))

      if (plugin.status !== 'suspended' && thresholdCandidates.length >= 3) {
        const triggeringIds = thresholdCandidates.slice(-3).map((entry) => entry.id)
        state = {
          ...state,
          runtimeIncidents: state.runtimeIncidents.map((entry) => (
            triggeringIds.includes(entry.id)
              ? { ...entry, status: 'triaged', suspensionTriggered: true }
              : entry
          )),
        }
        await persist()
        await api.suspendPlugin(input.pluginId, {
          actor: 'runtime_monitor',
          reason: 'runtime_incident_threshold',
          trigger: 'runtime_incident_threshold',
          incidentIds: triggeringIds,
        })
        const latestIncident = state.runtimeIncidents.find((entry) => entry.id === incident.id)!
        return latestIncident
      }

      return incident
    },

    async listRuntimeIncidents(pluginSlug: string) {
      if (!findPluginBySlug(pluginSlug)) {
        throw new Error(`plugin_not_found:${pluginSlug}`)
      }

      return state.runtimeIncidents
        .filter((entry) => entry.pluginId === pluginSlug)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    async listRegistryUpdates(context: {
      districtId?: string
      classroomId?: string
      pluginId?: string
      since?: string
    } = {}) {
      return state.runtimeEvents
        .filter((entry) => matchesRuntimeUpdateContext(entry, context))
        .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
    },

    subscribeRegistryUpdates(
      context: {
        districtId?: string
        classroomId?: string
        pluginId?: string
        since?: string
      } = {},
      listener: (event: RegistryUpdateEvent) => void,
    ) {
      const subscriber = (event: RegistryUpdateEvent) => {
        if (matchesRuntimeUpdateContext(event, context)) {
          listener(event)
        }
      }

      runtimeEventSubscribers.add(subscriber)
      return () => {
        runtimeEventSubscribers.delete(subscriber)
      }
    },
  }

  return api
}

export type DeveloperPlatformStore = Awaited<ReturnType<typeof createDeveloperPlatformStore>>
