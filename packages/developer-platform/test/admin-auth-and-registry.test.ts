import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDeveloperPlatformServer } from '../dist/developer-platform/src/app.js'

const ADMIN_API_KEY = 'test-admin-key'
const ADMIN_API_KEY_HEADER = 'x-developer-platform-admin-key'

type InjectOptions = {
  method: string
  url: string
  payload?: unknown
  headers?: Record<string, string>
}

function withAdminHeaders(options: InjectOptions): InjectOptions {
  if (!options.url.startsWith('/api/v1/admin/')) {
    return options
  }

  return {
    ...options,
    headers: {
      ...options.headers,
      [ADMIN_API_KEY_HEADER]: ADMIN_API_KEY,
    },
  }
}

async function inject(server: Awaited<ReturnType<typeof buildDeveloperPlatformServer>>, options: InjectOptions) {
  return server.inject(withAdminHeaders(options))
}

async function seedPublishedPlugin(server: Awaited<ReturnType<typeof buildDeveloperPlatformServer>>, slug: string) {
  await inject(server, {
    method: 'POST',
    url: '/api/v1/developer/plugins',
    payload: {
      slug,
      name: 'Registry Lab',
      description: 'Registry verification helper',
    },
  })

  const createVersionResponse = await inject(server, {
    method: 'POST',
    url: `/api/v1/developer/plugins/${slug}/versions`,
    payload: {
      version: '1.0.0',
      manifest: {
        pluginId: slug,
        name: 'Registry Lab',
        version: '1.0.0',
        description: 'Registry verification helper',
        entrypoint: '/index.html',
        ageRating: '8+',
        collectsInput: true,
        inputFields: [{ name: 'query', required: true, kind: 'text' }],
        permissions: ['weather.read'],
        networkDomains: ['api.weather.example'],
        dataPolicyUrl: 'https://example.com/privacy',
        externalResources: [],
        sriHashes: [],
        tools: [
          {
            name: 'lookup_weather',
            description: 'Lookup weather data',
            inputSchema: { type: 'object' },
          },
        ],
      },
    },
  })

  const version = createVersionResponse.json()
  const boundary = `----registry-${slug}`
  const artifactBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="artifact"; filename="${slug}.js"\r\n`
        + 'Content-Type: application/javascript\r\n\r\n',
      'utf8',
    ),
    Buffer.from('console.log("registry lab")', 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ])

  await inject(server, {
    method: 'POST',
    url: `/api/v1/developer/plugins/${slug}/versions/${version.id}/artifact`,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: artifactBody,
  })

  await inject(server, {
    method: 'POST',
    url: `/api/v1/developer/plugins/${slug}/versions/${version.id}/submit`,
  })

  const scanResponse = await inject(server, {
    method: 'GET',
    url: `/api/v1/admin/plugins/${slug}/versions/${version.id}/scan-runs`,
  })
  const [scanRun] = scanResponse.json()

  await inject(server, {
    method: 'POST',
    url: `/api/v1/admin/plugins/${slug}/versions/${version.id}/review-decisions`,
    payload: {
      decision: 'approve',
      reasonCode: 'clean_review',
      notes: 'Reviewed artifact matches manifest and runtime evidence.',
      reviewerId: 'reviewer-1',
      scanContext: {
        rulesetVersion: 'dp-sec-v1',
        scanRunIds: [scanRun.id],
        referencedFindingRuleIds: [],
      },
      checklist: [
        { itemId: 'platform_hosting_only', status: 'pass', notes: 'Platform-hosted' },
        { itemId: 'manifest_matches_artifact', status: 'pass', notes: 'Manifest verified' },
        { itemId: 'declared_network_domains_match_observed_behavior', status: 'pass', notes: 'Network verified' },
        { itemId: 'tool_contract_matches_runtime_behavior', status: 'pass', notes: 'Tools verified' },
        { itemId: 'data_collection_and_permissions_disclosed', status: 'pass', notes: 'Disclosure verified' },
        { itemId: 'age_rating_and_student_safety_reviewed', status: 'pass', notes: 'Age rating reviewed' },
        { itemId: 'security_findings_triaged', status: 'pass', notes: 'Findings triaged' },
        { itemId: 'runtime_evidence_captured', status: 'pass', notes: 'Runtime evidence captured' },
      ],
      evidence: [
        {
          source: 'platform_scan',
          summary: 'Automated scan completed with no blockers.',
          location: scanRun.id,
          capturedAt: '2026-04-05T20:00:00.000Z',
          findingIds: [],
        },
        {
          source: 'reviewer_runtime_capture',
          summary: 'Runtime behavior matched the approved contract.',
          location: 's3://review-evidence/registry-lab/runtime-capture',
          capturedAt: '2026-04-05T20:05:00.000Z',
          findingIds: [],
        },
      ],
    },
  })

  await inject(server, {
    method: 'POST',
    url: `/api/v1/admin/plugins/${slug}/versions/${version.id}/publish`,
    payload: {},
  })

  return version
}

describe('developer-platform admin auth and registry hardening', () => {
  let tempDir: string
  let storePath: string
  let server: Awaited<ReturnType<typeof buildDeveloperPlatformServer>>

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'developer-platform-auth-'))
    storePath = path.join(tempDir, 'store.json')
    server = await buildDeveloperPlatformServer({
      storePath,
      logger: false,
      adminApiKey: ADMIN_API_KEY,
    })
  })

  afterEach(async () => {
    await server.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('fails closed when the admin API key is missing', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/review-rubric',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'admin_auth_required' })
  })

  it('rejects an invalid admin API key', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/review-rubric',
      headers: {
        [ADMIN_API_KEY_HEADER]: 'wrong-key',
      },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'admin_auth_invalid' })
  })

  it('keeps suspended plugins out of runtime version resolution while preserving policy visibility', async () => {
    await seedPublishedPlugin(server, 'suspend-lab')

    const suspendResponse = await inject(server, {
      method: 'POST',
      url: '/api/v1/admin/plugins/suspend-lab/suspend',
      payload: {
        reason: 'policy_violation',
      },
    })
    expect(suspendResponse.statusCode).toBe(200)

    const directAppResponse = await inject(server, {
      method: 'GET',
      url: '/api/v1/registry/apps/suspend-lab',
    })
    expect(directAppResponse.statusCode).toBe(200)
    expect(directAppResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: 'suspend-lab',
        status: 'suspended',
      }),
    )

    const directVersionResponse = await inject(server, {
      method: 'GET',
      url: '/api/v1/registry/apps/suspend-lab/version',
    })
    expect(directVersionResponse.statusCode).toBe(404)

    const policyResponse = await inject(server, {
      method: 'GET',
      url: '/api/v1/registry/policies/suspend-lab',
    })
    expect(policyResponse.statusCode).toBe(200)
    expect(policyResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: 'suspend-lab',
        status: 'suspended',
        killSwitchActive: true,
      }),
    )
  })

  it('parses boolean registry query parameters without relying on unsafe casts', async () => {
    await seedPublishedPlugin(server, 'query-lab')

    await inject(server, {
      method: 'POST',
      url: '/api/v1/admin/plugins/query-lab/suspend',
      payload: {
        reason: 'temporary_hold',
      },
    })

    const excludedResponse = await inject(server, {
      method: 'GET',
      url: '/api/v1/registry/apps?includeSuspended=false',
    })
    expect(excludedResponse.statusCode).toBe(200)
    expect(excludedResponse.json()).toEqual({ apps: [] })

    const includedResponse = await inject(server, {
      method: 'GET',
      url: '/api/v1/registry/apps?includeSuspended=true',
    })
    expect(includedResponse.statusCode).toBe(200)
    expect(includedResponse.json()).toEqual({ apps: [] })

    const invalidResponse = await inject(server, {
      method: 'GET',
      url: '/api/v1/registry/apps?includeSuspended=maybe',
    })
    expect(invalidResponse.statusCode).toBe(422)
  })
})
