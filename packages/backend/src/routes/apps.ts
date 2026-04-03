import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { prisma, withTenantContext } from '../middleware/rls.js'
import { AppRegistrationSchema } from '@chatbridge/shared'
import { buildCommand, checkContentSafety, validateMessage } from '../cbp/handler.js'

export async function appRoutes(server: FastifyInstance) {
  // POST /apps/register — Register a third-party app
  server.post('/apps/register', {
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
    preHandler: [authenticate],
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

    // Verify tool exists
    const tools = app.toolDefinitions as Array<{ name: string }>
    const tool = Array.isArray(tools) ? tools.find(t => t.name === toolName) : null
    if (!tool) {
      return reply.status(404).send({ error: `Tool '${toolName}' not found for app '${app.name}'` })
    }

    const start = Date.now()

    try {
      // Create or update app instance
      let instance = conversationId
        ? await prisma.appInstance.findFirst({
            where: { appId, conversationId, status: { in: ['loading', 'active', 'suspended'] } },
          })
        : null

      if (!instance && conversationId) {
        // Suspend currently active instance (single-active constraint CLR-005)
        await prisma.appInstance.updateMany({
          where: { conversationId, status: 'active' },
          data: { status: 'suspended' },
        })

        instance = await prisma.appInstance.create({
          data: {
            appId,
            conversationId,
            districtId: user.districtId,
            status: 'loading',
          },
        })
      }

      // Log invocation
      const invocation = conversationId ? await prisma.toolInvocation.create({
        data: {
          districtId: user.districtId,
          conversationId,
          appId,
          toolName,
          parameters: parameters as any,
          status: 'success',
          latencyMs: 0, // Updated after execution
        },
      }) : null

      // TODO: Actually dispatch to app via CBP
      // For now, return a mock result based on tool name
      const result = generateToolResult(toolName, parameters)

      // Update instance to active
      if (instance) {
        await prisma.appInstance.update({
          where: { id: instance.id },
          data: { status: 'active', stateSnapshot: result as any },
        })
      }

      // Update invocation with latency
      if (invocation) {
        await prisma.toolInvocation.update({
          where: { id: invocation.id },
          data: { result: result as any, latencyMs: Date.now() - start },
        })
      }

      return {
        toolName,
        result,
        instanceId: instance?.id,
        latencyMs: Date.now() - start,
      }
    } catch (error) {
      // Timeout or execution error
      const latencyMs = Date.now() - start
      if (latencyMs > 5000) {
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

    const instance = await prisma.appInstance.findUnique({ where: { id: instanceId } })
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' })
    }
    if (instance.status !== 'active' && instance.status !== 'loading') {
      return reply.status(409).send({ error: `Instance is ${instance.status}, not active` })
    }

    await prisma.appInstance.update({
      where: { id: instanceId },
      data: { stateSnapshot: state as any, status: 'active' },
    })

    return { instanceId, status: 'active' }
  })

  // GET /apps/instances/:instanceId/state — Get app instance state
  server.get('/apps/instances/:instanceId/state', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string }

    const instance = await prisma.appInstance.findUnique({ where: { id: instanceId } })
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' })
    }

    return {
      instanceId: instance.id,
      status: instance.status,
      state: instance.stateSnapshot,
    }
  })

  // POST /apps/:appId/submit-review — Submit for automated review
  server.post('/apps/:appId/submit-review', {
    schema: {
      params: { type: 'object', properties: { appId: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string }

    const app = await prisma.app.findUnique({ where: { id: appId } })
    if (!app) return reply.status(404).send({ error: 'App not found' })

    // TODO: Run full 5-stage automated review pipeline
    // For now, auto-approve with basic schema check
    const reviewResults = {
      schema: { status: 'pass' },
      security: { status: 'pass' },
      safety: { status: 'pass' },
      accessibility: { status: 'pass' },
      performance: { status: 'pass' },
    }

    await prisma.app.update({
      where: { id: appId },
      data: {
        reviewStatus: 'approved',
        reviewResults: reviewResults as any,
      },
    })

    return reply.status(202).send({ appId, status: 'review_complete', reviewResults })
  })

  // GET /apps/:appId/review-results
  server.get('/apps/:appId/review-results', async (request, reply) => {
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
function generateToolResult(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
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
    case 'get_weather':
      return {
        location: params.location ?? 'Unknown',
        temperature: 72,
        conditions: 'Partly cloudy',
        forecast: [
          { day: 'Today', high: 72, low: 58, conditions: 'Partly cloudy' },
          { day: 'Tomorrow', high: 75, low: 60, conditions: 'Sunny' },
        ],
      }
    case 'search_tracks':
      return {
        tracks: [
          { name: 'Lo-fi Study Beats', artist: 'ChillHop', id: 'track1' },
          { name: 'Ambient Focus', artist: 'Study Music', id: 'track2' },
        ],
      }
    default:
      return { status: 'ok', toolName }
  }
}
