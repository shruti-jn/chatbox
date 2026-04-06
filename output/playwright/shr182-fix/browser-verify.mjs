import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const baseUrl = 'http://127.0.0.1:3412'
const outDir = '/Users/shruti/Software/chatbox/output/playwright/shr182-fix'
const shotDir = path.join(outDir, 'screenshots')

await mkdir(shotDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
})
const page = await context.newPage()

async function api(pathname, options = {}) {
  const { method = 'GET', json } = options
  return await page.evaluate(async ({ baseUrl: requestBaseUrl, pathname: requestPath, method: requestMethod, json: requestJson }) => {
    const headers = {}
    if (requestJson !== undefined) {
      headers['content-type'] = 'application/json'
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
  })
}

async function render(title, data, ok = true) {
  await page.setContent(
    `<!doctype html><html><body style="font-family: ui-monospace, monospace; background:${ok ? '#eefbf3' : '#fff2f2'}; padding:32px"><h1>${title}</h1><pre style="white-space:pre-wrap; background:white; padding:16px; border:1px solid #ddd; border-radius:12px">${JSON.stringify(data, null, 2)}</pre></body></html>`,
  )
}

const slug = `shr182-live-stream-${Date.now()}`
await page.goto(`${baseUrl}/docs`, { waitUntil: 'networkidle' })
await page.screenshot({ path: path.join(shotDir, '01-docs.png'), fullPage: true })

const plugin = await api('/api/v1/developer/plugins', {
  method: 'POST',
  json: {
    slug,
    name: 'SHR 182 Live Stream',
    description: 'runtime control verification',
  },
})
if (plugin.status !== 201) {
  throw new Error(`plugin create failed: ${JSON.stringify(plugin)}`)
}

const version = await api(`/api/v1/developer/plugins/${slug}/versions`, {
  method: 'POST',
  json: {
    version: '1.0.0',
    manifest: {
      pluginId: slug,
      name: 'SHR 182 Live Stream',
      version: '1.0.0',
      description: 'runtime control verification',
      entrypoint: '/index.html',
      ageRating: '8+',
      collectsInput: false,
      inputFields: [],
      permissions: [],
      networkDomains: [],
      dataPolicyUrl: 'https://example.com/privacy',
      externalResources: [],
      sriHashes: [],
      tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }],
    },
  },
})
if (version.status !== 201) {
  throw new Error(`version create failed: ${JSON.stringify(version)}`)
}

const upload = await page.evaluate(async ({ baseUrl: requestBaseUrl, slug: requestSlug, versionId }) => {
  const form = new FormData()
  form.append('artifact', new Blob(['console.log("shr182")'], { type: 'application/javascript' }), `${requestSlug}.js`)
  const response = await fetch(`${requestBaseUrl}/api/v1/developer/plugins/${requestSlug}/versions/${versionId}/artifact`, {
    method: 'POST',
    body: form,
  })
  return { status: response.status, data: await response.json() }
}, { baseUrl, slug, versionId: version.data.id })
if (upload.status !== 201) {
  throw new Error(`upload failed: ${JSON.stringify(upload)}`)
}

const submit = await api(`/api/v1/developer/plugins/${slug}/versions/${version.data.id}/submit`, { method: 'POST' })
if (submit.status !== 200) {
  throw new Error(`submit failed: ${JSON.stringify(submit)}`)
}

const scanRuns = await api(`/api/v1/admin/plugins/${slug}/versions/${version.data.id}/scan-runs`)
if (scanRuns.status !== 200) {
  throw new Error(`scan runs failed: ${JSON.stringify(scanRuns)}`)
}
const scanRun = scanRuns.data.at(-1)

const review = await api(`/api/v1/admin/plugins/${slug}/versions/${version.data.id}/review-decisions`, {
  method: 'POST',
  json: {
    decision: 'approve',
    reasonCode: 'clean_review',
    notes: 'browser verification',
    reviewerId: 'shr182-browser',
    scanContext: { rulesetVersion: 'dp-sec-v1', scanRunIds: [scanRun.id], referencedFindingRuleIds: [] },
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
      { source: 'reviewer_runtime_capture', summary: 'clean', location: 's3://runtime', capturedAt: '2026-04-05T20:05:00.000Z', findingIds: [] },
    ],
  },
})
if (review.status !== 200) {
  throw new Error(`review failed: ${JSON.stringify(review)}`)
}

const publish = await api(`/api/v1/admin/plugins/${slug}/versions/${version.data.id}/publish`, {
  method: 'POST',
  json: {},
})
if (publish.status !== 200) {
  throw new Error(`publish failed: ${JSON.stringify(publish)}`)
}

await page.evaluate(({ baseUrl: requestBaseUrl, slug: requestSlug }) => {
  window.__shr182Events = []
  window.__shr182Source = new EventSource(`${requestBaseUrl}/api/v1/registry/updates?pluginId=${requestSlug}`)
  window.__shr182Source.addEventListener('plugin_suspended', (event) => {
    window.__shr182Events.push({ type: event.type, data: event.data })
  })
}, { baseUrl, slug })

await page.waitForTimeout(300)
const suspend = await api(`/api/v1/admin/plugins/${slug}/suspend`, {
  method: 'POST',
  json: {
    actor: 'ops-admin',
    reason: 'browser verification',
  },
})
if (suspend.status !== 200) {
  throw new Error(`suspend failed: ${JSON.stringify(suspend)}`)
}

await page.waitForFunction(() => Array.isArray(window.__shr182Events) && window.__shr182Events.length > 0)
const events = await page.evaluate(() => window.__shr182Events)
await render('Live Runtime Update Event', events, true)
await page.screenshot({ path: path.join(shotDir, '02-live-event.png'), fullPage: true })

const blocked = await api(`/api/v1/registry/apps/${slug}/version`)
if (blocked.status !== 404) {
  throw new Error(`expected direct lookup kill switch, got ${JSON.stringify(blocked)}`)
}
await render('Direct Runtime Lookup Blocked After Suspension', blocked, true)
await page.screenshot({ path: path.join(shotDir, '03-kill-switch.png'), fullPage: true })

await page.evaluate(() => window.__shr182Source?.close())
await context.close()
await browser.close()
