import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import type { PluginManifest } from '@chatbridge/shared'
import { createDeveloperPlatformStore } from '../src/store.js'

const baseManifest: PluginManifest = {
  pluginId: 'corpus-lab',
  name: 'Corpus Lab',
  version: '1.0.0',
  description: 'Malicious corpus fixture',
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
      name: 'corpus_tool',
      description: 'Corpus tool',
      inputSchema: { type: 'object' },
    },
  ],
}

async function createSubmittedVersion(
  dbPath: string,
  slug: string,
  artifactName: string,
  artifactBytes: Buffer,
  manifestOverrides: Partial<PluginManifest> = {},
) {
  const store = await createDeveloperPlatformStore(dbPath)
  await store.createPlugin({
    slug,
    name: slug,
    description: `${slug} fixture`,
  })
  const version = await store.createVersion(slug, {
    version: '1.0.0',
    manifest: {
      ...baseManifest,
      pluginId: slug,
      name: slug,
      ...manifestOverrides,
    },
  })
  await store.saveArtifactUpload(slug, version.id, {
    fileName: artifactName,
    contentType: artifactName.endsWith('.zip') ? 'application/zip' : 'application/javascript',
    body: artifactBytes,
  })
  await store.submitVersion(slug, version.id)

  let submittedVersion = (await store.getDebugSnapshot()).versions.find((entry) => entry.id === version.id)!
  let scanRun = (await store.listScanRuns(slug, version.id))[0]
  for (let attempt = 0; attempt < 50; attempt += 1) {
    submittedVersion = (await store.getDebugSnapshot()).versions.find((entry) => entry.id === version.id)!
    scanRun = (await store.listScanRuns(slug, version.id))[0]
    if (scanRun && ['completed', 'failed'].includes(scanRun.status) && submittedVersion.status !== 'scanning') {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  return { store, version, submittedVersion, scanRun }
}

describe('malicious plugin corpus', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'developer-platform-corpus-'))
    dbPath = path.join(tempDir, 'store.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('fails a fixture that uses dynamic code execution in the artifact itself', async () => {
    const { submittedVersion, scanRun } = await createSubmittedVersion(
      dbPath,
      'dynamic-exec-fixture',
      'dynamic-exec.js',
      Buffer.from('const fn = new Function("return window.location.href"); fn(); eval("console.log(1)")', 'utf8'),
    )

    expect(submittedVersion.status).toBe('scan_failed')
    expect(scanRun.overallDisposition).toBe('fail')
    expect(scanRun.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'static-dynamic-code-exec',
          disposition: 'fail',
        }),
      ]),
    )
  })

  it('fails a fixture that bundles tracking-sdk signatures', async () => {
    const { submittedVersion, scanRun } = await createSubmittedVersion(
      dbPath,
      'tracking-sdk-fixture',
      'tracking.js',
      Buffer.from('import mixpanel from "mixpanel-browser"; mixpanel.track("student_opened_plugin")', 'utf8'),
    )

    expect(submittedVersion.status).toBe('scan_failed')
    expect(scanRun.overallDisposition).toBe('fail')
    expect(scanRun.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'static-tracking-sdk',
          disposition: 'fail',
        }),
      ]),
    )
  })

  it('routes obfuscated fixtures into manual review instead of passing them silently', async () => {
    const zip = new JSZip()
    zip.file(
      'index.js',
      'const payload = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".repeat(20); const decoded = atob("ZXZhbA==");',
    )
    const zipBytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

    const { submittedVersion, scanRun } = await createSubmittedVersion(
      dbPath,
      'obfuscation-fixture',
      'obfuscation.zip',
      zipBytes,
    )

    expect(submittedVersion.status).toBe('awaiting_review')
    expect(scanRun.overallDisposition).toBe('manual_review')
    expect(scanRun.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'bundle-obfuscation',
          disposition: 'manual_review',
        }),
      ]),
    )
  })

  it('routes nested archive loader fixtures into manual review instead of treating the nested payload as invisible', async () => {
    const innerZip = new JSZip()
    innerZip.file('payload.js', 'console.log("second stage")')
    const innerZipBytes = Buffer.from(await innerZip.generateAsync({ type: 'nodebuffer' }))

    const outerZip = new JSZip()
    outerZip.file(
      'loader.js',
      'const nested = "assets/payload.zip"; fetch("/plugins/runtime").then(() => nested)',
    )
    outerZip.file('assets/payload.zip', innerZipBytes)
    const outerZipBytes = Buffer.from(await outerZip.generateAsync({ type: 'nodebuffer' }))

    const { submittedVersion, scanRun } = await createSubmittedVersion(
      dbPath,
      'nested-loader-fixture',
      'nested-loader.zip',
      outerZipBytes,
    )

    expect(submittedVersion.status).toBe('awaiting_review')
    expect(scanRun.overallDisposition).toBe('manual_review')
    expect(scanRun.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'bundle-suspicious-loader',
          disposition: 'manual_review',
        }),
      ]),
    )
  })

  it('keeps a benign fixture reviewable when no malicious patterns are detected', async () => {
    const { submittedVersion, scanRun } = await createSubmittedVersion(
      dbPath,
      'benign-fixture',
      'benign.js',
      Buffer.from('export function greet() { return "hello classroom"; }', 'utf8'),
    )

    expect(submittedVersion.status).toBe('awaiting_review')
    expect(scanRun.overallDisposition).toBe('pass')
    expect(scanRun.findings).toEqual([])
  })
})
