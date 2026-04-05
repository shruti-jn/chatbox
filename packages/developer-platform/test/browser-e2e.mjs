import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import JSZip from 'jszip'
import { chromium } from 'playwright'

const ROOT_DIR = path.resolve(new URL('../..', import.meta.url).pathname, '..')
const OUTPUT_DIR = path.join(ROOT_DIR, 'output', 'playwright', 'shr175-e2e')
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
const RUN_OUTPUT_DIR = path.join(OUTPUT_DIR, RUN_ID)
const SCREENSHOT_DIR = path.join(RUN_OUTPUT_DIR, 'screenshots')
const VIDEO_DIR = path.join(RUN_OUTPUT_DIR, 'video')

const reviewChecklist = [
  { itemId: 'platform_hosting_only', status: 'pass', notes: 'Hosted URL is platform-controlled.' },
  { itemId: 'manifest_matches_artifact', status: 'pass', notes: 'Manifest fields match the uploaded artifact.' },
  { itemId: 'declared_network_domains_match_observed_behavior', status: 'pass', notes: 'Observed requests stayed within declared domains.' },
  { itemId: 'tool_contract_matches_runtime_behavior', status: 'pass', notes: 'Tool behavior matches the reviewed contract.' },
  { itemId: 'data_collection_and_permissions_disclosed', status: 'pass', notes: 'Data collection and permissions are disclosed.' },
  { itemId: 'age_rating_and_student_safety_reviewed', status: 'pass', notes: 'Age rating is appropriate for the intended audience.' },
  { itemId: 'security_findings_triaged', status: 'pass', notes: 'All security findings were dispositioned.' },
  { itemId: 'runtime_evidence_captured', status: 'pass', notes: 'Reviewer captured runtime evidence during validation.' },
]

function buildManifest(pluginId, version, overrides = {}) {
  return {
    pluginId,
    name: `Plugin ${pluginId}`,
    version,
    description: `End-to-end validation plugin ${pluginId}`,
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
    ...overrides,
  }
}

function buildApproveDecision(scanRunId, overrides = {}) {
  return {
    decision: 'approve',
    reasonCode: 'clean_review',
    notes: 'Reviewer validated the hosted artifact, the manifest contract, and captured runtime evidence for the approved behavior.',
    reviewerId: 'reviewer-browser-e2e',
    scanContext: {
      rulesetVersion: 'dp-sec-v1',
      scanRunIds: [scanRunId],
      referencedFindingRuleIds: [],
    },
    checklist: reviewChecklist.map((item) => ({ ...item })),
    evidence: [
      {
        source: 'platform_scan',
        summary: 'Automated scan completed without unresolved blockers.',
        location: scanRunId,
        capturedAt: '2026-04-05T20:00:00.000Z',
        findingIds: [],
      },
      {
        source: 'reviewer_runtime_capture',
        summary: 'Reviewer observed only declared network traffic and expected tool behavior.',
        location: 's3://review-evidence/browser-e2e/runtime-capture',
        capturedAt: '2026-04-05T20:05:00.000Z',
        findingIds: [],
      },
    ],
    ...overrides,
  }
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`developer_platform_health_timeout:${baseUrl}`)
}

async function startServer() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'developer-platform-browser-e2e-'))
  const storePath = path.join(tempDir, 'store.json')
  const port = 3300 + Math.floor(Math.random() * 500)
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(
    'pnpm',
    ['--dir', 'packages/developer-platform', 'exec', 'tsx', 'src/server.ts'],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DEVELOPER_PLATFORM_PORT: String(port),
        DEVELOPER_PLATFORM_STORE_PATH: storePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  try {
    await waitForHealth(baseUrl)
    return { child, tempDir, storePath, baseUrl }
  } catch (error) {
    child.kill('SIGTERM')
    throw new Error(`${error instanceof Error ? error.message : 'server_start_failed'}\n${stderr}`)
  }
}

async function stopServer(server) {
  server.child.kill('SIGTERM')
  await new Promise((resolve) => server.child.once('exit', resolve))
  await rm(server.tempDir, { recursive: true, force: true })
}

function bytesToBase64(buffer) {
  return Buffer.from(buffer).toString('base64')
}

async function browserRequest(page, baseUrl, request) {
  return await page.evaluate(async ({ baseUrl: requestBaseUrl, request: req }) => {
    const init = {
      method: req.method ?? 'GET',
      headers: {},
    }

    if (req.json !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(req.json)
    } else if (req.multipart) {
      const form = new FormData()
      for (const file of req.multipart.files ?? []) {
        const binary = atob(file.base64)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        form.append(file.fieldName, new Blob([bytes], { type: file.contentType }), file.fileName)
      }
      for (const [key, value] of Object.entries(req.multipart.fields ?? {})) {
        form.append(key, value)
      }
      init.body = form
    }

    const response = await fetch(`${requestBaseUrl}${req.path}`, init)
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    return {
      status: response.status,
      data,
      ok: response.ok,
    }
  }, { baseUrl, request })
}

function expectStatus(response, status, label) {
  assert.equal(
    response.status,
    status,
    `${label} expected HTTP ${status} but received ${response.status}: ${JSON.stringify(response.data)}`,
  )
}

async function renderScenario(page, scenarioName, details, passed) {
  const html = `
    <html>
      <head>
        <style>
          body {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            padding: 32px;
            background: ${passed ? '#effaf2' : '#fff1f0'};
            color: #111827;
          }
          h1 { margin: 0 0 12px; font-size: 28px; }
          .status {
            display: inline-block;
            padding: 6px 10px;
            border-radius: 999px;
            background: ${passed ? '#15803d' : '#b91c1c'};
            color: white;
            font-weight: 700;
            margin-bottom: 16px;
          }
          pre {
            white-space: pre-wrap;
            background: white;
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #d1d5db;
            line-height: 1.45;
            font-size: 13px;
          }
        </style>
      </head>
      <body>
        <div class="status">${passed ? 'PASSED' : 'FAILED'}</div>
        <h1>${scenarioName}</h1>
        <pre>${details}</pre>
      </body>
    </html>
  `
  await page.setContent(html)
}

async function createPluginFlow(page, baseUrl, slug, version, artifact, manifestOverrides = {}, pluginOverrides = {}) {
  const createPluginResponse = await browserRequest(page, baseUrl, {
    method: 'POST',
    path: '/api/v1/developer/plugins',
    json: {
      slug,
      name: `Plugin ${slug}`,
      description: `Browser e2e plugin ${slug}`,
      ...pluginOverrides,
    },
  })
  expectStatus(createPluginResponse, 201, 'create plugin')

  const createVersionResponse = await browserRequest(page, baseUrl, {
    method: 'POST',
    path: `/api/v1/developer/plugins/${slug}/versions`,
    json: {
      version,
      manifest: buildManifest(slug, version, manifestOverrides),
    },
  })
  expectStatus(createVersionResponse, 201, 'create version')

  const uploadArtifactResponse = await browserRequest(page, baseUrl, {
    method: 'POST',
    path: `/api/v1/developer/plugins/${slug}/versions/${createVersionResponse.data.id}/artifact`,
    multipart: {
      files: [
        {
          fieldName: 'artifact',
          fileName: artifact.fileName,
          contentType: artifact.contentType,
          base64: bytesToBase64(artifact.bytes),
        },
      ],
    },
  })
  expectStatus(uploadArtifactResponse, 201, 'upload artifact')

  return {
    plugin: createPluginResponse.data,
    version: createVersionResponse.data,
    artifact: uploadArtifactResponse.data,
  }
}

async function submitAndGetScanRun(page, baseUrl, slug, versionId) {
  const submitResponse = await browserRequest(page, baseUrl, {
    method: 'POST',
    path: `/api/v1/developer/plugins/${slug}/versions/${versionId}/submit`,
  })
  expectStatus(submitResponse, 200, 'submit version')

  const scanRunsResponse = await browserRequest(page, baseUrl, {
    method: 'GET',
    path: `/api/v1/admin/plugins/${slug}/versions/${versionId}/scan-runs`,
  })
  expectStatus(scanRunsResponse, 200, 'list scan runs')
  assert.ok(Array.isArray(scanRunsResponse.data), 'scan runs response must be an array')
  assert.equal(scanRunsResponse.data.length, 1, 'expected one scan run after submission')

  return {
    submittedVersion: submitResponse.data,
    scanRun: scanRunsResponse.data[0],
  }
}

function buildScenarioSlug(index, name) {
  return `shr175-${index}-${name}-${RUN_ID}`.toLowerCase()
}

async function safeArtifact(script = 'console.log("safe plugin")') {
  return {
    fileName: 'plugin.js',
    contentType: 'application/javascript',
    bytes: Buffer.from(script, 'utf8'),
  }
}

async function unsafeZipArtifact() {
  const zip = new JSZip()
  zip.file('../escape.js', 'alert("bad")')
  return {
    fileName: 'unsafe-plugin.zip',
    contentType: 'application/zip',
    bytes: Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })),
  }
}

const scenarios = [
  {
    name: 'clean-publish-and-registry-contract',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'clean')
      const created = await createPluginFlow(
        page,
        baseUrl,
        slug,
        '1.0.0',
        await safeArtifact(),
        {},
        {
          developer: {
            name: 'Clean Flow Dev',
            email: `${slug}@example.com`,
            organization: 'Clean Flow Dev',
          },
          dpaRecord: {
            status: 'approved',
            documentUrl: 'https://example.com/dpa/clean.pdf',
            approvedAt: '2026-04-05T20:00:00.000Z',
          },
        },
      )
      const { submittedVersion, scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)
      assert.equal(submittedVersion.status, 'awaiting_review')
      assert.equal(scanRun.status, 'completed')
      assert.equal(scanRun.overallDisposition, 'pass')

      const reviewResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/review-decisions`,
        json: buildApproveDecision(scanRun.id),
      })
      expectStatus(reviewResponse, 200, 'approve review')

      const publishResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      })
      expectStatus(publishResponse, 200, 'publish version')

      const registryVersion = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps/${slug}/version`,
      })
      expectStatus(registryVersion, 200, 'registry version')
      assert.equal(registryVersion.data.activeVersion, '1.0.0')

      const registryPolicy = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/policies/${slug}`,
      })
      expectStatus(registryPolicy, 200, 'registry policy')
      assert.equal(registryPolicy.data.killSwitchActive, false)

      const toolManifest = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: '/api/v1/registry/tool-manifest',
      })
      expectStatus(toolManifest, 200, 'tool manifest')
      assert.ok(toolManifest.data.tools.some((tool) => tool.pluginId === slug), 'tool manifest should include published plugin')

      const auditResponse = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/admin/plugins/${slug}/audit`,
      })
      expectStatus(auditResponse, 200, 'audit response')
      assert.equal(auditResponse.data.developer.email, `${slug}@example.com`)
      assert.equal(auditResponse.data.dpaRecords[0].status, 'approved')

      return {
        slug,
        scanRunStatus: scanRun.status,
        publishedUrl: publishResponse.data.publishMetadata.hostedUrl,
        toolCount: toolManifest.data.tools.filter((tool) => tool.pluginId === slug).length,
      }
    },
  },
  {
    name: 'scan-blocker-stops-pipeline',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'blocker')
      const artifact = {
        fileName: 'plugin.zip',
        contentType: 'application/zip',
        bytes: Buffer.from(await (async () => {
          const zip = new JSZip()
          zip.file('index.html', '<input name="student_name" /><script src="https://evil.example/app.js"></script>')
          return zip.generateAsync({ type: 'nodebuffer' })
        })()),
      }
      const created = await createPluginFlow(
        page,
        baseUrl,
        slug,
        '1.0.0',
        artifact,
        {
          collectsInput: false,
          inputFields: [],
          networkDomains: ['api.weather.example'],
        },
      )
      const { submittedVersion, scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)
      assert.equal(submittedVersion.status, 'scan_failed')
      assert.equal(scanRun.overallDisposition, 'fail')

      const publishResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      })
      expectStatus(publishResponse, 409, 'publish blocked on scan failure')

      return {
        slug,
        versionStatus: submittedVersion.status,
        scanDisposition: scanRun.overallDisposition,
      }
    },
  },
  {
    name: 'review-reject-blocks-publish',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'reject')
      const created = await createPluginFlow(page, baseUrl, slug, '1.0.0', await safeArtifact())
      const { scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)

      const reviewResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/review-decisions`,
        json: buildApproveDecision(scanRun.id, {
          decision: 'reject',
          reasonCode: 'manifest_mismatch',
          checklist: reviewChecklist.map((item) => (
            item.itemId === 'manifest_matches_artifact'
              ? { ...item, status: 'fail', notes: 'Manifest no longer matches the artifact.' }
              : { ...item }
          )),
        }),
      })
      expectStatus(reviewResponse, 200, 'reject review')
      assert.equal(reviewResponse.data.version.status, 'rejected')

      const publishResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      })
      expectStatus(publishResponse, 409, 'publish blocked after reject')

      const registryResponse = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps/${slug}`,
      })
      expectStatus(registryResponse, 404, 'rejected plugin absent from registry')

      return {
        slug,
        reviewOutcome: reviewResponse.data.decision.outcome,
      }
    },
  },
  {
    name: 'waiver-publish-records-controls',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'waive')
      const created = await createPluginFlow(page, baseUrl, slug, '1.0.0', await safeArtifact())
      const { scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)

      const reviewResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/review-decisions`,
        json: buildApproveDecision(scanRun.id, {
          decision: 'waive',
          reasonCode: 'student_safety_risk',
          checklist: reviewChecklist.map((item) => (
            item.itemId === 'age_rating_and_student_safety_reviewed'
              ? { ...item, status: 'waived', notes: 'Pilot waiver approved with compensating controls.' }
              : { ...item }
          )),
          waiver: {
            rationale: 'Limited district pilot is allowed while non-blocking wording updates are prepared.',
            approvedBy: 'platform-admin',
            scope: 'Pilot district only',
            compensatingControls: ['District allowlist', 'Weekly reviewer check-in'],
          },
        }),
      })
      expectStatus(reviewResponse, 200, 'waive review')
      assert.equal(reviewResponse.data.version.status, 'approved')

      const publishResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      })
      expectStatus(publishResponse, 200, 'publish waived version')

      const auditResponse = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/admin/plugins/${slug}/audit`,
      })
      expectStatus(auditResponse, 200, 'audit response')
      assert.equal(auditResponse.data.reviewDecisions[0].decision, 'waive')

      return {
        slug,
        publishedUrl: publishResponse.data.publishMetadata.hostedUrl,
        waiverApprovedBy: auditResponse.data.reviewDecisions[0].waiver.approvedBy,
      }
    },
  },
  {
    name: 'security-escalation-blocks-release',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'escalate')
      const created = await createPluginFlow(page, baseUrl, slug, '1.0.0', await safeArtifact())
      const { scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)

      const reviewResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/review-decisions`,
        json: buildApproveDecision(scanRun.id, {
          decision: 'escalate',
          reasonCode: 'needs_security_escalation',
          escalation: {
            path: 'security',
            severity: 'critical',
            summary: 'Potential obfuscated bootstrap behavior needs security review.',
            blocking: true,
          },
        }),
      })
      expectStatus(reviewResponse, 200, 'escalate review')
      assert.equal(reviewResponse.data.version.status, 'awaiting_review')

      const publishResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      })
      expectStatus(publishResponse, 409, 'publish blocked after escalation')

      return {
        slug,
        reviewOutcome: reviewResponse.data.decision.outcome,
        versionStatus: reviewResponse.data.version.status,
      }
    },
  },
  {
    name: 'rollback-switches-active-version',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'rollback')

      const versionOne = await createPluginFlow(page, baseUrl, slug, '1.0.0', await safeArtifact('console.log("v1")'))
      const submittedOne = await submitAndGetScanRun(page, baseUrl, slug, versionOne.version.id)
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${versionOne.version.id}/review-decisions`,
        json: buildApproveDecision(submittedOne.scanRun.id),
      }).then((response) => expectStatus(response, 200, 'approve v1'))
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${versionOne.version.id}/publish`,
        json: {},
      }).then((response) => expectStatus(response, 200, 'publish v1'))

      const versionTwo = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/developer/plugins/${slug}/versions`,
        json: {
          version: '1.1.0',
          manifest: buildManifest(slug, '1.1.0'),
        },
      })
      expectStatus(versionTwo, 201, 'create version two')
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/developer/plugins/${slug}/versions/${versionTwo.data.id}/artifact`,
        multipart: {
          files: [
            {
              fieldName: 'artifact',
              fileName: 'plugin-v2.js',
              contentType: 'application/javascript',
              base64: bytesToBase64(Buffer.from('console.log("v2")', 'utf8')),
            },
          ],
        },
      }).then((response) => expectStatus(response, 201, 'upload version two'))
      const submittedTwo = await submitAndGetScanRun(page, baseUrl, slug, versionTwo.data.id)
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${versionTwo.data.id}/review-decisions`,
        json: buildApproveDecision(submittedTwo.scanRun.id),
      }).then((response) => expectStatus(response, 200, 'approve v2'))
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${versionTwo.data.id}/publish`,
        json: {},
      }).then((response) => expectStatus(response, 200, 'publish v2'))

      const beforeRollback = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps/${slug}/version`,
      })
      expectStatus(beforeRollback, 200, 'registry version before rollback')
      assert.equal(beforeRollback.data.activeVersion, '1.1.0')

      const rollbackResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/rollback`,
        json: { targetVersionId: versionOne.version.id },
      })
      expectStatus(rollbackResponse, 200, 'rollback version')

      const afterRollback = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps/${slug}/version`,
      })
      expectStatus(afterRollback, 200, 'registry version after rollback')
      assert.equal(afterRollback.data.activeVersion, '1.0.0')

      return {
        slug,
        beforeRollback: beforeRollback.data.activeVersion,
        afterRollback: afterRollback.data.activeVersion,
      }
    },
  },
  {
    name: 'district-override-scopes-runtime-visibility',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'district')
      const created = await createPluginFlow(page, baseUrl, slug, '1.0.0', await safeArtifact())
      const { scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/review-decisions`,
        json: buildApproveDecision(scanRun.id),
      }).then((response) => expectStatus(response, 200, 'approve district plugin'))
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      }).then((response) => expectStatus(response, 200, 'publish district plugin'))

      const districtA = '550e8400-e29b-41d4-a716-446655440010'
      const districtB = '550e8400-e29b-41d4-a716-446655440011'
      const beforeOverride = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps?districtId=${districtA}`,
      })
      expectStatus(beforeOverride, 200, 'registry before district override')
      assert.ok(beforeOverride.data.apps.some((app) => app.pluginId === slug), 'district A should see plugin before override')

      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: '/api/v1/admin/district-plugin-overrides',
        json: {
          districtId: districtA,
          pluginId: slug,
          enabled: false,
        },
      }).then((response) => expectStatus(response, 200, 'set district override'))

      const afterOverrideA = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps?districtId=${districtA}`,
      })
      expectStatus(afterOverrideA, 200, 'registry after district override A')
      assert.ok(afterOverrideA.data.apps.every((app) => app.pluginId !== slug), 'district A should not see disabled plugin')

      const afterOverrideB = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps?districtId=${districtB}`,
      })
      expectStatus(afterOverrideB, 200, 'registry after district override B')
      assert.ok(afterOverrideB.data.apps.some((app) => app.pluginId === slug), 'district B should still see plugin')

      return {
        slug,
        districtAVisible: afterOverrideA.data.apps.some((app) => app.pluginId === slug),
        districtBVisible: afterOverrideB.data.apps.some((app) => app.pluginId === slug),
      }
    },
  },
  {
    name: 'suspend-and-reinstate-controls-runtime',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'suspend')
      const created = await createPluginFlow(page, baseUrl, slug, '1.0.0', await safeArtifact())
      const { scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/review-decisions`,
        json: buildApproveDecision(scanRun.id),
      }).then((response) => expectStatus(response, 200, 'approve suspend plugin'))
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      }).then((response) => expectStatus(response, 200, 'publish suspend plugin'))

      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/suspend`,
        json: { actor: 'ops-admin', reason: 'kill switch exercise' },
      }).then((response) => expectStatus(response, 200, 'suspend plugin'))

      const suspendedList = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: '/api/v1/registry/apps',
      })
      expectStatus(suspendedList, 200, 'registry list after suspension')
      assert.ok(suspendedList.data.apps.every((app) => app.pluginId !== slug), 'suspended plugin should not appear in registry list')

      const suspendedDirect = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/apps/${slug}`,
      })
      expectStatus(suspendedDirect, 200, 'direct registry lookup after suspension')
      assert.equal(suspendedDirect.data.status, 'suspended')

      const policyDuringSuspension = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/registry/policies/${slug}`,
      })
      expectStatus(policyDuringSuspension, 200, 'policy during suspension')
      assert.equal(policyDuringSuspension.data.killSwitchActive, true)

      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/reinstate`,
        json: { actor: 'ops-admin', reason: 'issue resolved' },
      }).then((response) => expectStatus(response, 200, 'reinstate plugin'))

      const reinstatedList = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: '/api/v1/registry/apps',
      })
      expectStatus(reinstatedList, 200, 'registry list after reinstatement')
      assert.ok(reinstatedList.data.apps.some((app) => app.pluginId === slug), 'reinstated plugin should return to registry list')

      return {
        slug,
        killSwitchActiveDuringSuspension: policyDuringSuspension.data.killSwitchActive,
      }
    },
  },
  {
    name: 'runtime-violation-threshold-auto-suspends',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'runtime')
      const created = await createPluginFlow(page, baseUrl, slug, '1.0.0', await safeArtifact())
      const { scanRun } = await submitAndGetScanRun(page, baseUrl, slug, created.version.id)
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/review-decisions`,
        json: buildApproveDecision(scanRun.id),
      }).then((response) => expectStatus(response, 200, 'approve runtime plugin'))
      await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/admin/plugins/${slug}/versions/${created.version.id}/publish`,
        json: {},
      }).then((response) => expectStatus(response, 200, 'publish runtime plugin'))

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const runtimeEvent = await browserRequest(page, baseUrl, {
          method: 'POST',
          path: '/api/v1/registry/runtime-events',
          json: {
            pluginId: slug,
            pluginVersionId: created.version.id,
            eventType: 'unexpected_network_request',
            metadata: {
              severity: 'high',
              destination: `https://unexpected-${attempt}.example`,
            },
          },
        })
        expectStatus(runtimeEvent, 202, `runtime event ${attempt + 1}`)
      }

      const incidentsResponse = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: `/api/v1/admin/plugins/${slug}/runtime-incidents`,
      })
      expectStatus(incidentsResponse, 200, 'runtime incidents')
      assert.equal(incidentsResponse.data.length, 3)
      assert.ok(incidentsResponse.data.every((incident) => incident.suspensionTriggered), 'all threshold incidents should record suspension')

      const registryResponse = await browserRequest(page, baseUrl, {
        method: 'GET',
        path: '/api/v1/registry/apps',
      })
      expectStatus(registryResponse, 200, 'runtime-suspended plugin absent from registry list')
      assert.ok(registryResponse.data.apps.every((app) => app.pluginId !== slug), 'auto-suspended plugin should be absent from registry list')

      return {
        slug,
        incidentCount: incidentsResponse.data.length,
        suspended: true,
      }
    },
  },
  {
    name: 'unsafe-archive-is-rejected',
    async run(page, baseUrl, index) {
      const slug = buildScenarioSlug(index, 'unsafe')
      const createPluginResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: '/api/v1/developer/plugins',
        json: {
          slug,
          name: `Plugin ${slug}`,
          description: `Browser e2e plugin ${slug}`,
        },
      })
      expectStatus(createPluginResponse, 201, 'create unsafe plugin')

      const createVersionResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/developer/plugins/${slug}/versions`,
        json: {
          version: '1.0.0',
          manifest: buildManifest(slug, '1.0.0'),
        },
      })
      expectStatus(createVersionResponse, 201, 'create unsafe version')

      const artifact = await unsafeZipArtifact()
      const uploadResponse = await browserRequest(page, baseUrl, {
        method: 'POST',
        path: `/api/v1/developer/plugins/${slug}/versions/${createVersionResponse.data.id}/artifact`,
        multipart: {
          files: [
            {
              fieldName: 'artifact',
              fileName: artifact.fileName,
              contentType: artifact.contentType,
              base64: bytesToBase64(artifact.bytes),
            },
          ],
        },
      })
      expectStatus(uploadResponse, 400, 'unsafe archive upload')
      assert.equal(uploadResponse.data.error, `artifact_inventory_unsafe_path:${slug}`)

      return {
        slug,
        error: uploadResponse.data.error,
      }
    },
  },
]

async function run() {
  await mkdir(SCREENSHOT_DIR, { recursive: true })
  await mkdir(VIDEO_DIR, { recursive: true })

  const server = await startServer()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 1280, height: 900 },
    },
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  const video = page.video()
  const results = []

  try {
    await page.goto(`${server.baseUrl}/docs`)

    for (const [index, scenario] of scenarios.entries()) {
      try {
        const summary = await scenario.run(page, server.baseUrl, index + 1)
        const details = JSON.stringify(summary, null, 2)
        await renderScenario(page, scenario.name, details, true)
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${String(index + 1).padStart(2, '0')}-${scenario.name}.png`),
          fullPage: true,
        })
        results.push({ name: scenario.name, passed: true, summary })
      } catch (error) {
        const details = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
        await renderScenario(page, scenario.name, details, false)
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${String(index + 1).padStart(2, '0')}-${scenario.name}-failed.png`),
          fullPage: true,
        })
        results.push({ name: scenario.name, passed: false, error: details })
        throw error
      }
    }

    await renderScenario(page, 'shr-175-summary', JSON.stringify(results, null, 2), true)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'summary.png'),
      fullPage: true,
    })
  } finally {
    await writeFile(path.join(RUN_OUTPUT_DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
    await context.close()
    await browser.close()
    await stopServer(server)
  }

  const videoPath = await video.path()
  const gifPath = path.join(RUN_OUTPUT_DIR, 'shr175-browser-e2e.gif')
  const ffmpeg = spawnSync('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-vf',
    'fps=6,scale=720:-1:flags=lanczos',
    gifPath,
  ], { cwd: ROOT_DIR, encoding: 'utf8' })

  if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg_gif_failed:${ffmpeg.stderr}`)
  }

  const failed = results.filter((result) => !result.passed)
  if (failed.length > 0) {
    throw new Error(`browser_e2e_failed:${failed.map((result) => result.name).join(',')}`)
  }

  console.log(JSON.stringify({
    runId: RUN_ID,
    scenarios: results.length,
    outputDir: RUN_OUTPUT_DIR,
    gifPath,
  }, null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
