import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const baseUrl = 'http://127.0.0.1:3411'
const adminKey = 'test-admin-key'
const outDir = '/Users/shruti/Software/chatbox/output/playwright/shr175-hardening'
const shotDir = path.join(outDir, 'screenshots')

await mkdir(shotDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
})
const page = await context.newPage()

async function api(pathname, options = {}) {
  const { method = 'GET', json, admin = false } = options
  return await page.evaluate(async ({ baseUrl: requestBaseUrl, pathname: requestPath, method: requestMethod, json: requestJson, admin: adminRequest, adminKey: requestAdminKey }) => {
    const headers = {}
    if (requestJson !== undefined) {
      headers['content-type'] = 'application/json'
    }
    if (adminRequest) {
      headers['x-developer-platform-admin-key'] = requestAdminKey
    }

    const response = await fetch(`${requestBaseUrl}${requestPath}`, {
      method: requestMethod,
      headers,
      body: requestJson === undefined ? undefined : JSON.stringify(requestJson),
    })
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    return { status: response.status, data }
  }, {
    baseUrl,
    pathname,
    method,
    json,
    admin,
    adminKey,
  })
}

async function render(title, data, ok = true) {
  await page.setContent(
    `<!doctype html><html><body style="font-family: ui-monospace, monospace; background:${ok ? '#eefbf3' : '#fff2f2'}; padding:32px"><h1>${title}</h1><pre style="white-space:pre-wrap; background:white; padding:16px; border:1px solid #ddd; border-radius:12px">${JSON.stringify(data, null, 2)}</pre></body></html>`,
  )
}

await page.goto(`${baseUrl}/docs`, { waitUntil: 'networkidle' })
await page.screenshot({ path: path.join(shotDir, '01-docs.png'), fullPage: true })

const unauthorized = await api('/api/v1/admin/review-rubric')
if (unauthorized.status !== 401) {
  throw new Error(`expected 401, got ${unauthorized.status}`)
}
await render('Unauthorized Admin Access Blocked', unauthorized, true)
await page.screenshot({ path: path.join(shotDir, '02-unauthorized-admin.png'), fullPage: true })

const slug = `browser-hardening-lab-${Date.now()}`
const createPlugin = await api('/api/v1/developer/plugins', {
  method: 'POST',
  json: {
    slug,
    name: 'Browser Hardening Lab',
    description: 'browser verification plugin',
  },
})
if (createPlugin.status !== 201) {
  throw new Error(`create plugin failed: ${JSON.stringify(createPlugin)}`)
}

const createVersion = await api(`/api/v1/developer/plugins/${slug}/versions`, {
  method: 'POST',
  json: {
    version: '1.0.0',
    manifest: {
      pluginId: slug,
      name: 'Browser Hardening Lab',
      version: '1.0.0',
      description: 'browser verification plugin',
      entrypoint: '/index.html',
      ageRating: '8+',
      collectsInput: true,
      inputFields: [{ name: 'query', required: true, kind: 'text' }],
      permissions: ['weather.read'],
      networkDomains: ['api.weather.example'],
      dataPolicyUrl: 'https://example.com/privacy',
      externalResources: [],
      sriHashes: [],
      tools: [{ name: 'lookup_weather', description: 'Lookup weather data', inputSchema: { type: 'object' } }],
    },
  },
})
if (createVersion.status !== 201) {
  throw new Error(`create version failed: ${JSON.stringify(createVersion)}`)
}
const versionId = createVersion.data.id

const uploadResponse = await page.evaluate(async ({ baseUrl: requestBaseUrl, slug: requestSlug, versionId: requestVersionId }) => {
  const form = new FormData()
  form.append('artifact', new Blob(['console.log("browser hardening")'], { type: 'application/javascript' }), `${requestSlug}.js`)
  const response = await fetch(`${requestBaseUrl}/api/v1/developer/plugins/${requestSlug}/versions/${requestVersionId}/artifact`, {
    method: 'POST',
    body: form,
  })
  return { status: response.status, data: await response.json() }
}, { baseUrl, slug, versionId })
if (uploadResponse.status !== 201) {
  throw new Error(`upload failed: ${JSON.stringify(uploadResponse)}`)
}

const submitResponse = await api(`/api/v1/developer/plugins/${slug}/versions/${versionId}/submit`, { method: 'POST' })
if (submitResponse.status !== 200) {
  throw new Error(`submit failed: ${JSON.stringify(submitResponse)}`)
}

const scanRuns = await api(`/api/v1/admin/plugins/${slug}/versions/${versionId}/scan-runs`, { admin: true })
if (scanRuns.status !== 200) {
  throw new Error(`scan runs failed: ${JSON.stringify(scanRuns)}`)
}
const scanRun = scanRuns.data.at(-1)

const reviewResponse = await api(`/api/v1/admin/plugins/${slug}/versions/${versionId}/review-decisions`, {
  method: 'POST',
  admin: true,
  json: {
    decision: 'approve',
    reasonCode: 'clean_review',
    notes: 'Browser verification review decision.',
    reviewerId: 'browser-reviewer',
    scanContext: {
      rulesetVersion: 'dp-sec-v1',
      scanRunIds: [scanRun.id],
      referencedFindingRuleIds: [],
    },
    checklist: [
      { itemId: 'platform_hosting_only', status: 'pass', notes: 'ok' },
      { itemId: 'manifest_matches_artifact', status: 'pass', notes: 'ok' },
      { itemId: 'declared_network_domains_match_observed_behavior', status: 'pass', notes: 'ok' },
      { itemId: 'tool_contract_matches_runtime_behavior', status: 'pass', notes: 'ok' },
      { itemId: 'data_collection_and_permissions_disclosed', status: 'pass', notes: 'ok' },
      { itemId: 'age_rating_and_student_safety_reviewed', status: 'pass', notes: 'ok' },
      { itemId: 'security_findings_triaged', status: 'pass', notes: 'ok' },
      { itemId: 'runtime_evidence_captured', status: 'pass', notes: 'ok' },
    ],
    evidence: [
      { source: 'platform_scan', summary: 'clean', location: scanRun.id, capturedAt: '2026-04-05T20:00:00.000Z', findingIds: [] },
      { source: 'reviewer_runtime_capture', summary: 'clean', location: 's3://browser-proof/runtime', capturedAt: '2026-04-05T20:05:00.000Z', findingIds: [] },
    ],
  },
})
if (reviewResponse.status !== 200) {
  throw new Error(`review failed: ${JSON.stringify(reviewResponse)}`)
}

const publishResponse = await api(`/api/v1/admin/plugins/${slug}/versions/${versionId}/publish`, {
  method: 'POST',
  admin: true,
  json: {},
})
if (publishResponse.status !== 200) {
  throw new Error(`publish failed: ${JSON.stringify(publishResponse)}`)
}
await render('Published Version', publishResponse, true)
await page.screenshot({ path: path.join(shotDir, '03-published-version.png'), fullPage: true })

const registryResponse = await api('/api/v1/registry/apps')
if (registryResponse.status !== 200) {
  throw new Error(`registry failed: ${JSON.stringify(registryResponse)}`)
}
await render('Runtime Registry Listing', registryResponse, true)
await page.screenshot({ path: path.join(shotDir, '04-registry-listing.png'), fullPage: true })

const suspendResponse = await api(`/api/v1/admin/plugins/${slug}/suspend`, {
  method: 'POST',
  admin: true,
  json: { reason: 'browser_verification' },
})
if (suspendResponse.status !== 200) {
  throw new Error(`suspend failed: ${JSON.stringify(suspendResponse)}`)
}

const blockedVersion = await api(`/api/v1/registry/apps/${slug}/version`)
if (blockedVersion.status !== 404) {
  throw new Error(`suspended version should be hidden: ${JSON.stringify(blockedVersion)}`)
}
await render('Suspended Plugin Hidden From Direct Registry Lookup', blockedVersion, true)
await page.screenshot({ path: path.join(shotDir, '05-suspended-hidden.png'), fullPage: true })

await context.close()
await browser.close()
