import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import Fastify, { type FastifyBaseLogger, type FastifyServerOptions } from 'fastify'
import {
  ArtifactInventorySchema,
  ArtifactUploadMetadataSchema,
  DistrictPluginOverrideRequestSchema,
  ManifestPolicyVerificationResultSchema,
  PluginSuspensionRequestSchema,
  PluginCreateRequestSchema,
  PluginVersionCreateRequestSchema,
  PublishVersionRequestSchema,
  RegistryAppsResponseSchema,
  RegistryContextRequestSchema,
  RegistryPolicyResponseSchema,
  RuntimeRegistryUpdateStreamRequestSchema,
  RuntimeEventIngestRequestSchema,
  RuntimeIncidentSchema,
  RollbackVersionRequestSchema,
  RuntimeRegistryVersionSchema,
  ScanEvaluationInputSchema,
  ScanEvaluationResultSchema,
  SecurityScanPolicySchema,
  ReviewDecisionRequestSchema,
  ReviewRubricSchema,
  ScanRunCreateRequestSchema,
  ScanRunSchema,
  ToolManifestResponseSchema,
} from '@chatbridge/shared'
import { createDeveloperPlatformStore } from './store.js'

type BuildDeveloperPlatformServerOptions = {
  logger?: FastifyServerOptions['logger'] | FastifyBaseLogger
  storePath?: string
  adminApiKey?: string
}

function mapStoreError(error: unknown) {
  if (!(error instanceof Error)) {
    return { statusCode: 500, body: { error: 'unknown_error' } }
  }

  if (error.message.startsWith('plugin_slug_conflict:') || error.message.startsWith('plugin_version_conflict:')) {
    return { statusCode: 409, body: { error: error.message } }
  }

  if (error.message.startsWith('plugin_not_found:') || error.message.startsWith('plugin_version_not_found:')) {
    return { statusCode: 404, body: { error: error.message } }
  }

  if (error.message.startsWith('artifact_required:')) {
    return { statusCode: 400, body: { error: error.message } }
  }

  if (error.message.startsWith('manifest_plugin_id_mismatch:')) {
    return { statusCode: 422, body: { error: error.message } }
  }

  if (error.message.startsWith('artifact_inventory_unsafe_path:')) {
    return { statusCode: 400, body: { error: error.message } }
  }

  if (error.message === 'approve_without_review_decision') {
    return { statusCode: 400, body: { error: error.message } }
  }

  if (error.message.startsWith('review_state_invalid:')) {
    return { statusCode: 409, body: { error: error.message } }
  }

  if (error.message.startsWith('publish_state_invalid:') || error.message.startsWith('rollback_state_invalid:')) {
    return { statusCode: 409, body: { error: error.message } }
  }

  if (error.message.startsWith('scan_state_invalid:')) {
    return { statusCode: 409, body: { error: error.message } }
  }

  if (error.message.startsWith('scan_ruleset_unknown:')) {
    return { statusCode: 404, body: { error: error.message } }
  }

  if (error.message.startsWith('scan_run_not_found:')) {
    return { statusCode: 404, body: { error: error.message } }
  }

  return { statusCode: 500, body: { error: error.message } }
}

export async function buildDeveloperPlatformServer(options: BuildDeveloperPlatformServerOptions = {}) {
  const server = Fastify({ logger: options.logger ?? true })
  const developerPlatformStore = await createDeveloperPlatformStore(options.storePath)
  const adminApiKey = options.adminApiKey?.trim() || null

  await server.register(cors, {
    origin: true,
  })
  await server.register(multipart)

  await server.register(swagger, {
    openapi: {
      info: {
        title: 'ChatBridge Developer Platform API',
        version: '0.1.0',
      },
    },
  })

  await server.register(swaggerUI, { routePrefix: '/docs' })

  server.addHook('preHandler', async (request, reply) => {
    const routeUrl = request.routeOptions.url ?? ''
    if (!routeUrl.startsWith('/api/v1/admin/')) {
      return
    }

    if (!adminApiKey) {
      return
    }

    const providedApiKey = request.headers['x-developer-platform-admin-key']
    const normalizedApiKey = Array.isArray(providedApiKey) ? providedApiKey[0] : providedApiKey

    if (!normalizedApiKey) {
      return reply.status(401).send({ error: 'admin_auth_required' })
    }

    if (normalizedApiKey !== adminApiKey) {
      return reply.status(403).send({ error: 'admin_auth_invalid' })
    }
  })

  server.get('/health', async () => {
    return { ok: true, service: 'developer-platform' }
  })

  server.get('/api/v1/admin/review-rubric', async (_request, reply) => {
    const rubric = developerPlatformStore.getReviewRubric()
    const parsed = ReviewRubricSchema.safeParse(rubric)
    if (!parsed.success) {
      return reply.status(500).send({ error: 'review_rubric_invalid', details: parsed.error.issues })
    }

    return reply.send(parsed.data)
  })

  server.get('/api/v1/admin/plugins', async (_request, reply) => {
    const plugins = await developerPlatformStore.listAdminPlugins()
    return reply.send({ plugins })
  })

  server.get('/api/v1/admin/plugins/:pluginId', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const plugin = await developerPlatformStore.getAdminPluginDetail(pluginId)
    if (!plugin) {
      return reply.status(404).send({ error: `plugin_not_found:${pluginId}` })
    }

    return reply.send(plugin)
  })

  server.get('/api/v1/admin/security-scan-policy', async (_request, reply) => {
    const policy = developerPlatformStore.getSecurityScanPolicy()
    const parsed = SecurityScanPolicySchema.safeParse(policy)
    if (!parsed.success) {
      return reply.status(500).send({ error: 'security_scan_policy_invalid', details: parsed.error.issues })
    }

    return reply.send(parsed.data)
  })

  server.post('/api/v1/admin/security-scan-policy/evaluate', async (request, reply) => {
    const parsed = ScanEvaluationInputSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const result = developerPlatformStore.evaluateScanFindings(parsed.data.findings, parsed.data.rulesetVersion)
      const resultParsed = ScanEvaluationResultSchema.safeParse(result)
      if (!resultParsed.success) {
        return reply.status(500).send({ error: 'scan_evaluation_invalid', details: resultParsed.error.issues })
      }

      return reply.send(resultParsed.data)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/developer/plugins', async (request, reply) => {
    const parsed = PluginCreateRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const plugin = await developerPlatformStore.createPlugin(parsed.data)
      return reply.status(201).send(plugin)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/developer/plugins/:pluginId/versions', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const parsed = PluginVersionCreateRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const version = await developerPlatformStore.createVersion(pluginId, parsed.data)
      return reply.status(201).send(version)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/developer/plugins/:pluginId/versions/:versionId/artifact-metadata', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }
    const parsed = ArtifactUploadMetadataSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const version = await developerPlatformStore.attachArtifact(pluginId, versionId, parsed.data)
      return reply.send(version)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/developer/plugins/:pluginId/versions/:versionId/artifact', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }

    try {
      const upload = await request.file()
      if (!upload) {
        return reply.status(400).send({ error: 'artifact_file_required' })
      }

      const body = await upload.toBuffer()
      const artifact = await developerPlatformStore.saveArtifactUpload(pluginId, versionId, {
        fileName: upload.filename,
        contentType: upload.mimetype,
        body,
      })
      return reply.status(201).send(artifact)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.get('/api/v1/admin/plugins/:pluginId/versions/:versionId/artifact-inventory', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }

    try {
      const inventory = await developerPlatformStore.getArtifactInventory(pluginId, versionId)
      if (!inventory) {
        return reply.status(404).send({ error: `artifact_inventory_not_found:${pluginId}:${versionId}` })
      }

      const parsed = ArtifactInventorySchema.safeParse(inventory)
      if (!parsed.success) {
        return reply.status(500).send({ error: 'artifact_inventory_invalid', details: parsed.error.issues })
      }

      return reply.send(parsed.data)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.get('/api/v1/admin/plugins/:pluginId/versions/:versionId/policy-verification', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }

    try {
      const verification = await developerPlatformStore.verifyManifestAgainstArtifact(pluginId, versionId)
      const parsed = ManifestPolicyVerificationResultSchema.safeParse(verification)
      if (!parsed.success) {
        return reply.status(500).send({ error: 'policy_verification_invalid', details: parsed.error.issues })
      }

      return reply.send(parsed.data)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/admin/plugins/:pluginId/versions/:versionId/scan-runs', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }
    const parsed = ScanRunCreateRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const scanRun = await developerPlatformStore.createScanRun(pluginId, versionId, parsed.data.findings)
      const scanRunParsed = ScanRunSchema.safeParse(scanRun)
      if (!scanRunParsed.success) {
        return reply.status(500).send({ error: 'scan_run_invalid', details: scanRunParsed.error.issues })
      }

      return reply.status(201).send(scanRunParsed.data)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.get('/api/v1/admin/plugins/:pluginId/versions/:versionId/scan-runs', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }

    try {
      const scanRuns = await developerPlatformStore.listScanRuns(pluginId, versionId)
      const parsed = scanRuns.map((scanRun) => ScanRunSchema.parse(scanRun))
      return reply.send(parsed)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/developer/plugins/:pluginId/versions/:versionId/submit', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }

    try {
      const version = await developerPlatformStore.submitVersion(pluginId, versionId)
      return reply.send(version)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/admin/plugins/:pluginId/versions/:versionId/review-decisions', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }
    const parsed = ReviewDecisionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const result = await developerPlatformStore.reviewVersion(pluginId, versionId, parsed.data)
      return reply.send(result)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/admin/district-plugin-overrides', async (request, reply) => {
    const parsed = DistrictPluginOverrideRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const override = await developerPlatformStore.setDistrictPluginOverride(parsed.data)
      return reply.send(override)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/admin/plugins/:pluginId/versions/:versionId/publish', async (request, reply) => {
    const { pluginId, versionId } = request.params as { pluginId: string; versionId: string }
    const parsed = PublishVersionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const version = await developerPlatformStore.publishVersion(pluginId, versionId)
      return reply.send(version)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/admin/plugins/:pluginId/rollback', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const parsed = RollbackVersionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const version = await developerPlatformStore.rollbackPublishedVersion(pluginId, parsed.data.targetVersionId)
      return reply.send(version)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/admin/plugins/:pluginId/suspend', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const parsed = PluginSuspensionRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const plugin = await developerPlatformStore.suspendPlugin(pluginId, parsed.data)
      return reply.send(plugin)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.post('/api/v1/admin/plugins/:pluginId/reinstate', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const parsed = PluginSuspensionRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const plugin = await developerPlatformStore.reinstatePlugin(pluginId, parsed.data)
      return reply.send(plugin)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.get('/api/v1/admin/plugins/:pluginId/audit', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const audit = await developerPlatformStore.getPluginAudit(pluginId)
    if (!audit) {
      return reply.status(404).send({ error: `plugin_not_found:${pluginId}` })
    }

    return reply.send(audit)
  })

  server.get('/api/v1/admin/plugins/:pluginId/runtime-incidents', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }

    try {
      const incidents = await developerPlatformStore.listRuntimeIncidents(pluginId)
      const parsed = incidents.map((incident) => RuntimeIncidentSchema.parse(incident))
      return reply.send(parsed)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  server.get('/api/v1/registry/apps', async (request, reply) => {
    const parsedContext = RegistryContextRequestSchema.safeParse((request as any).query ?? {})
    if (!parsedContext.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsedContext.error.issues })
    }

    const response = { apps: await developerPlatformStore.listRegistryAppsForContext(parsedContext.data) }
    const parsed = RegistryAppsResponseSchema.safeParse(response)
    if (!parsed.success) {
      return reply.status(500).send({ error: 'registry_response_invalid', details: parsed.error.issues })
    }

    return reply.send(parsed.data)
  })

  server.get('/api/v1/registry/apps/:pluginId', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const app = await developerPlatformStore.getRegistryApp(pluginId, { includeSuspended: true })
    if (!app) {
      return reply.status(404).send({ error: `plugin_not_found:${pluginId}` })
    }

    return reply.send(app)
  })

  server.get('/api/v1/registry/apps/:pluginId/version', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const version = await developerPlatformStore.getRegistryVersion(pluginId)
    if (!version) {
      return reply.status(404).send({ error: `plugin_not_found:${pluginId}` })
    }

    const parsed = RuntimeRegistryVersionSchema.safeParse(version)
    if (!parsed.success) {
      return reply.status(500).send({ error: 'registry_version_invalid', details: parsed.error.issues })
    }

    return reply.send(parsed.data)
  })

  server.get('/api/v1/registry/policies/:pluginId', async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string }
    const policy = await developerPlatformStore.getRegistryPolicy(pluginId)
    if (!policy) {
      return reply.status(404).send({ error: `plugin_not_found:${pluginId}` })
    }

    const parsed = RegistryPolicyResponseSchema.safeParse(policy)
    if (!parsed.success) {
      return reply.status(500).send({ error: 'registry_policy_invalid', details: parsed.error.issues })
    }

    return reply.send(parsed.data)
  })

  server.get('/api/v1/registry/tool-manifest', async (request, reply) => {
    const parsedContext = RegistryContextRequestSchema.safeParse((request as any).query ?? {})
    if (!parsedContext.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsedContext.error.issues })
    }

    const manifest = await developerPlatformStore.getToolManifest(parsedContext.data)
    const parsed = ToolManifestResponseSchema.safeParse(manifest)
    if (!parsed.success) {
      return reply.status(500).send({ error: 'tool_manifest_invalid', details: parsed.error.issues })
    }

    return reply.send(parsed.data)
  })

  server.get('/api/v1/registry/updates', async (request, reply) => {
    const parsed = RuntimeRegistryUpdateStreamRequestSchema.safeParse((request as any).query ?? {})
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    const updates = await developerPlatformStore.listRegistryUpdates(parsed.data)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })

    const writeEvent = (event: (typeof updates)[number]) => {
      reply.raw.write(`id: ${event.id}\n`)
      reply.raw.write(`event: ${event.type}\n`)
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    for (const event of updates) {
      writeEvent(event)
    }

    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n')
    }, 15_000)

    const unsubscribe = developerPlatformStore.subscribeRegistryUpdates(parsed.data, (event) => {
      writeEvent(event)
    })

    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }

    request.raw.on('close', cleanup)
    request.raw.on('error', cleanup)
  })

  server.post('/api/v1/registry/runtime-events', async (request, reply) => {
    const parsed = RuntimeEventIngestRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'validation_failed', details: parsed.error.issues })
    }

    try {
      const incident = await developerPlatformStore.ingestRuntimeEvent(parsed.data)
      const incidentParsed = RuntimeIncidentSchema.safeParse(incident)
      if (!incidentParsed.success) {
        return reply.status(500).send({ error: 'runtime_incident_invalid', details: incidentParsed.error.issues })
      }

      return reply.status(202).send(incidentParsed.data)
    } catch (error) {
      const mapped = mapStoreError(error)
      return reply.status(mapped.statusCode).send(mapped.body)
    }
  })

  return server
}
