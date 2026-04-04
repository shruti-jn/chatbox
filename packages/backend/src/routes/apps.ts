import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { requireCoppaConsent } from '../middleware/coppa.js'
import { prisma, withTenantContext } from '../middleware/rls.js'
import { AppRegistrationSchema } from '@chatbridge/shared'
import { buildCommand, checkContentSafety, validateMessage } from '../cbp/handler.js'
import { transition, InvalidTransitionError, type AppState, checkRateLimit, isUnresponsive, recordSuccess, recordFailure } from '../apps/index.js'
import { runReviewPipeline } from '../apps/review-pipeline.js'
import { getWeather } from '../services/weather.js'
import { searchTracks, createPlaylist } from '../services/spotify.js'

export async function appRoutes(server: FastifyInstance) {
  // POST /apps/register — Register a third-party app
  server.post('/apps/register', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'description', 'toolDefinitions', 'uiManifest', 'permissions', 'complianceMetadata', 'version'],
      },
      response: {
        201: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = AppRegistrationSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(422).send({
        error: 'Validation failed',
        details: parsed.error.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
      })
    }

    const data = parsed.data
    const app = await prisma.app.create({
      data: {
        name: data.name,
        description: data.description,
        toolDefinitions: data.toolDefinitions as any,
        uiManifest: data.uiManifest as any,
        permissions: data.permissions as any,
        complianceMetadata: data.complianceMetadata as any,
        interactionModel: data.interactionModel,
        version: data.version,
        reviewStatus: 'pending_review',
      },
    })

    return reply.status(201).send({ appId: app.id, status: 'pending_review' })
  })

  // POST /apps/:appId/tools/:toolName/invoke — Invoke app tool
  server.post('/apps/:appId/tools/:toolName/invoke', {
    preHandler: [authenticate, requireCoppaConsent],
    schema: {
      params: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
          toolName: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          parameters: { type: 'object' },
          conversationId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId, toolName } = request.params as { appId: string; toolName: string }
    const { parameters = {}, conversationId } = request.body as {
      parameters?: Record<string, unknown>
      conversationId?: string
    }
    const user = getUser(request)

    // Find app
    const app = await prisma.app.findUnique({ where: { id: appId } })
    if (!app) {
      return reply.status(404).send({ error: 'App not found' })
    }

    // Only approved apps can be invoked
    if (app.reviewStatus !== 'approved') {
      return reply.status(403).send({ error: 'App is not approved for use' })
    }

    // Verify tool exists
    const tools = app.toolDefinitions as Array<{ name: string }>
    const tool = Array.isArray(tools) ? tools.find(t => t.name === toolName) : null
    if (!tool) {
      return reply.status(404).send({ error: `Tool '${toolName}' not found for app '${app.name}'` })
    }

    // Rate limit check
    const rateResult = checkRateLimit(appId)
    if (!rateResult.allowed) {
      request.log.warn({ appId, retryAfterSec: rateResult.retryAfterSec }, 'Rate limit exceeded for app')
      reply.header('Retry-After', String(rateResult.retryAfterSec))
      return reply.status(429).send({ error: 'Rate limit exceeded', retryAfterSec: rateResult.retryAfterSec })
    }

    // Health check — refuse invocations for unresponsive apps
    if (isUnresponsive(appId)) {
      return reply.status(503).send({ error: 'App is unresponsive' })
    }

    const start = Date.now()

    try {
      // Create or update app instance (within tenant context for RLS)
      let instance = conversationId
        ? await withTenantContext(user.districtId, async (tx) => {
            return tx.appInstance.findFirst({
              where: { appId, conversationId, status: { in: ['loading', 'active', 'suspended'] } },
            })
          })
        : null

      if (!instance && conversationId) {
        // Suspend currently active instance (single-active constraint CLR-005)
        instance = await withTenantContext(user.districtId, async (tx) => {
          await tx.appInstance.updateMany({
            where: { conversationId, status: 'active' },
            data: { status: 'suspended' },
          })

          return tx.appInstance.create({
            data: {
              appId,
              conversationId,
              districtId: user.districtId,
              status: 'loading',
            },
          })
        })
      }

      // Log invocation
      const invocation = conversationId ? await withTenantContext(user.districtId, async (tx) => {
        return tx.toolInvocation.create({
          data: {
            districtId: user.districtId,
            conversationId,
            appId,
            toolName,
            parameters: parameters as any,
            status: 'success',
            latencyMs: 0, // Updated after execution
          },
        })
      }) : null

      // TODO: Actually dispatch to app via CBP
      // For now, return a mock result based on tool name
      // Proactive 5s timeout wrapper (ready for real CBP dispatch)
      const controller = new AbortController()
      const timeoutHandle = setTimeout(() => controller.abort(), 5000)
      let result: Record<string, unknown>
      try {
        result = await Promise.race([
          Promise.resolve(generateToolResult(toolName, parameters)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Tool execution timeout')), 5000)
          ),
        ]) as Record<string, unknown>
      } catch (err: any) {
        clearTimeout(timeoutHandle)
        if (err.message === 'Tool execution timeout') {
          return reply.status(408).send({ error: 'Tool execution timeout' })
        }
        throw err
      }
      clearTimeout(timeoutHandle)

      // Transition instance loading -> active via FSM
      if (instance) {
        const newStatus = transition(instance.status as AppState, 'activate')
        await withTenantContext(user.districtId, async (tx) => {
          await tx.appInstance.update({
            where: { id: instance!.id },
            data: { status: newStatus, stateSnapshot: result as any },
          })
        })
      }

      // Update invocation with latency
      if (invocation) {
        await withTenantContext(user.districtId, async (tx) => {
          await tx.toolInvocation.update({
            where: { id: invocation!.id },
            data: { result: result as any, latencyMs: Date.now() - start },
          })
        })
      }

      // Record successful invocation in health monitor
      recordSuccess(appId, Date.now() - start)

      return {
        toolName,
        result,
        instanceId: instance?.id,
        latencyMs: Date.now() - start,
      }
    } catch (error: any) {
      // Record failure in health monitor
      recordFailure(appId)

      if (error.message === 'Tool execution timeout') {
        return reply.status(408).send({ error: 'Tool execution timeout' })
      }
      request.log.error(error, 'Tool invocation failed')
      return reply.status(500).send({ error: 'Tool invocation failed' })
    }
  })

  // PUT /apps/instances/:instanceId/state — Update app instance state
  server.put('/apps/instances/:instanceId/state', {
    preHandler: [authenticate],
    schema: {
      params: { type: 'object', properties: { instanceId: { type: 'string' } } },
      body: { type: 'object', required: ['state'], properties: { state: { type: 'object' } } },
    },
  }, async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string }
    const { state } = request.body as { state: Record<string, unknown> }
    const user = getUser(request)

    const instance = await withTenantContext(user.districtId, async (tx) => {
      return tx.appInstance.findUnique({ where: { id: instanceId } })
    })
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' })
    }
    // If already active, just update state. If loading, transition to active via FSM.
    let newStatus: string = instance.status
    if (instance.status === 'loading') {
      try {
        newStatus = transition(instance.status as AppState, 'activate')
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.status(409).send({ error: `Instance is ${instance.status}, cannot activate` })
        }
        throw err
      }
    } else if (instance.status !== 'active') {
      return reply.status(409).send({ error: `Instance is ${instance.status}, not active` })
    }

    await withTenantContext(user.districtId, async (tx) => {
      await tx.appInstance.update({
        where: { id: instanceId },
        data: { stateSnapshot: state as any, status: newStatus },
      })
    })

    return { instanceId, status: newStatus }
  })

  // GET /apps/instances/:instanceId/state — Get app instance state
  server.get('/apps/instances/:instanceId/state', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string }
    const user = getUser(request)

    const instance = await withTenantContext(user.districtId, async (tx) => {
      return tx.appInstance.findUnique({ where: { id: instanceId } })
    })
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' })
    }

    return {
      instanceId: instance.id,
      status: instance.status,
      state: instance.stateSnapshot,
    }
  })

  // POST /apps/instances/:instanceId/suspend — Suspend an active instance
  server.post('/apps/instances/:instanceId/suspend', {
    preHandler: [authenticate],
    schema: {
      params: { type: 'object', properties: { instanceId: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string }
    const user = getUser(request)

    const instance = await withTenantContext(user.districtId, async (tx) => {
      return tx.appInstance.findUnique({
        where: { id: instanceId },
        include: { conversation: { select: { studentId: true, classroom: { select: { teacherId: true } } } } },
      })
    })
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' })
    }
    // Ownership: only the conversation's student or teacher can manage instances
    // Ownership: conversation owner, teacher, admin, or standalone instance (no conversation)
    const conv = instance.conversation
    const isOwner = !conv
      || conv.studentId === user.userId
      || conv.classroom?.teacherId === user.userId
      || user.role === 'district_admin'
    if (!isOwner) {
      return reply.status(403).send({ error: 'Not authorized to manage this instance' })
    }

    let newStatus: AppState
    try {
      newStatus = transition(instance.status as AppState, 'suspend')
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.status(409).send({ error: err.message })
      }
      throw err
    }

    await withTenantContext(user.districtId, async (tx) => {
      await tx.appInstance.update({
        where: { id: instanceId },
        data: { status: newStatus },
      })
    })

    return { instanceId, status: newStatus }
  })

  // POST /apps/instances/:instanceId/resume — Resume a suspended instance
  server.post('/apps/instances/:instanceId/resume', {
    preHandler: [authenticate],
    schema: {
      params: { type: 'object', properties: { instanceId: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string }
    const user = getUser(request)

    const instance = await withTenantContext(user.districtId, async (tx) => {
      return tx.appInstance.findUnique({ where: { id: instanceId } })
    })
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' })
    }
    // RLS enforces district isolation. Within a district, students can manage
    // their own instances and teachers can manage any in their classroom.

    let newStatus: AppState
    try {
      newStatus = transition(instance.status as AppState, 'resume')
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.status(409).send({ error: err.message })
      }
      throw err
    }

    await withTenantContext(user.districtId, async (tx) => {
      await tx.appInstance.update({
        where: { id: instanceId },
        data: { status: newStatus },
      })
    })

    return { instanceId, status: newStatus }
  })

  // POST /apps/instances/:instanceId/terminate — Terminate an instance
  server.post('/apps/instances/:instanceId/terminate', {
    preHandler: [authenticate],
    schema: {
      params: { type: 'object', properties: { instanceId: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string }
    const user = getUser(request)

    const instance = await withTenantContext(user.districtId, async (tx) => {
      return tx.appInstance.findUnique({ where: { id: instanceId } })
    })
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' })
    }
    // RLS enforces district isolation. Within a district, students can manage
    // their own instances and teachers can manage any in their classroom.

    let newStatus: AppState
    try {
      newStatus = transition(instance.status as AppState, 'terminate')
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.status(409).send({ error: err.message })
      }
      throw err
    }

    await withTenantContext(user.districtId, async (tx) => {
      await tx.appInstance.update({
        where: { id: instanceId },
        data: { status: newStatus, terminatedAt: new Date() },
      })
    })

    return { instanceId, status: newStatus }
  })

  // POST /apps/:appId/submit-review — Submit for automated review
  server.post('/apps/:appId/submit-review', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
    schema: {
      params: { type: 'object', properties: { appId: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string }

    const app = await prisma.app.findUnique({ where: { id: appId } })
    if (!app) return reply.status(404).send({ error: 'App not found' })

    const environment = (process.env.NODE_ENV === 'production' ? 'production' : 'development') as
      'production' | 'development'

    const reviewResult = runReviewPipeline(
      {
        toolDefinitions: app.toolDefinitions as any[],
        uiManifest: app.uiManifest as { url: string },
        permissions: app.permissions as Record<string, unknown>,
        name: app.name,
        description: app.description ?? '',
      },
      { environment },
    )

    const newStatus = reviewResult.overallStatus === 'approved'
      ? 'approved'
      : reviewResult.overallStatus === 'needs_manual_review'
        ? 'pending_review'
        : 'rejected'

    await prisma.app.update({
      where: { id: appId },
      data: {
        reviewStatus: newStatus,
        reviewResults: reviewResult as any,
      },
    })

    return reply.status(202).send({ appId, status: newStatus, reviewResults: reviewResult })
  })

  // GET /apps/:appId/review-results
  server.get('/apps/:appId/review-results', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string }
    const app = await prisma.app.findUnique({ where: { id: appId } })
    if (!app) return reply.status(404).send({ error: 'App not found' })

    return {
      appId: app.id,
      reviewStatus: app.reviewStatus,
      reviewResults: app.reviewResults,
    }
  })
}

/**
 * Generate mock tool result for development
 * TODO: Replace with actual CBP dispatch in CP-3
 */
async function generateToolResult(toolName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (toolName) {
    case 'start_game':
      return {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        status: 'new_game',
        message: 'Chess game started! White to move.',
      }
    case 'make_move':
      return {
        fen: params.fen ?? 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        status: 'move_made',
        message: `Move ${params.move ?? 'e4'} played.`,
      }
    case 'get_weather': {
      const location = (params.location as string) ?? 'New York'
      return await getWeather(location) as unknown as Record<string, unknown>
    }
    case 'search_tracks': {
      const query = (params.query as string) ?? 'study music'
      const result = await searchTracks(query)
      return result as unknown as Record<string, unknown>
    }
    case 'create_playlist': {
      const playlistName = (params.name as string) ?? 'My Playlist'
      const userId = (params.userId as string) ?? ''
      const districtId = (params.districtId as string) ?? ''
      const trackIds = (params.trackIds as string[]) ?? []
      const result = await createPlaylist(playlistName, {
        userId,
        districtId,
        description: (params.description as string) ?? undefined,
        trackIds,
      })
      return result as unknown as Record<string, unknown>
    }
    default:
      return { status: 'ok', toolName }
  }
}
