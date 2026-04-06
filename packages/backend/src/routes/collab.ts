import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { prisma, withTenantContext } from '../middleware/rls.js'
import crypto from 'crypto'

export async function collabRoutes(server: FastifyInstance) {
  // POST /collaborative-sessions — Create session
  server.post('/collaborative-sessions', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['appId', 'interactionModel'],
        properties: {
          appId: { type: 'string' },
          interactionModel: { type: 'string', enum: ['turn_based', 'concurrent'] },
          conversationId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const user = getUser(request)
    const { appId, interactionModel, conversationId } = request.body as {
      appId: string; interactionModel: 'turn_based' | 'concurrent'; conversationId?: string
    }

    // Create app instance if conversation provided
    let appInstanceId: string | undefined
    if (conversationId) {
      const instance = await withTenantContext(user.districtId, async (tx) => {
        return tx.appInstance.create({
          data: { appId, conversationId, districtId: user.districtId, status: 'active' },
        })
      })
      appInstanceId = instance.id
    }

    if (!appInstanceId) {
      return reply.status(400).send({ error: 'conversationId required' })
    }

    const sessionCode = crypto.randomBytes(3).toString('hex').toUpperCase()

    const session = await withTenantContext(user.districtId, async (tx) => {
      const s = await tx.collaborativeSession.create({
        data: {
          districtId: user.districtId,
          appInstanceId,
          sessionCode,
          interactionModel,
          createdBy: user.userId,
        },
      })

      // Add creator as first participant
      await tx.sessionParticipant.create({
        data: {
          sessionId: s.id,
          userId: user.userId,
          colorAssignment: 'white',
          turnOrder: 1,
        },
      })

      return s
    })

    return reply.status(201).send({
      sessionId: session.id,
      sessionCode,
      interactionModel,
    })
  })

  // POST /collaborative-sessions/:code/join — Join session
  server.post('/collaborative-sessions/:code/join', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const user = getUser(request)

    const session = await withTenantContext(user.districtId, async (tx) => {
      return tx.collaborativeSession.findUnique({
        where: { sessionCode: code },
        include: { participants: true },
      })
    })

    if (!session) return reply.status(404).send({ error: 'Session not found' })
    if (session.status !== 'active') return reply.status(409).send({ error: 'Session is closed' })

    // Check if already joined
    const existing = session.participants.find(p => p.userId === user.userId)
    if (existing) {
      return { sessionId: session.id, participantId: existing.id, color: existing.colorAssignment }
    }

    const participant = await withTenantContext(user.districtId, async (tx) => {
      return tx.sessionParticipant.create({
        data: {
          sessionId: session.id,
          userId: user.userId,
          colorAssignment: session.participants.length === 0 ? 'white' : 'black',
          turnOrder: session.participants.length + 1,
        },
      })
    })

    return {
      sessionId: session.id,
      participantId: participant.id,
      color: participant.colorAssignment,
      participants: session.participants.length + 1,
    }
  })

  // GET /collaborative-sessions/:id — Get session detail with participants
  server.get('/collaborative-sessions/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = getUser(request)

    const session = await withTenantContext(user.districtId, async (tx) => {
      return tx.collaborativeSession.findUnique({
        where: { id },
        include: { participants: true },
      })
    })

    if (!session) return reply.status(404).send({ error: 'Session not found' })

    return {
      sessionId: session.id,
      sessionCode: session.sessionCode,
      status: session.status,
      interactionModel: session.interactionModel,
      participants: session.participants.map(p => ({
        userId: p.userId,
        color: p.colorAssignment,
        turnOrder: p.turnOrder,
      })),
    }
  })

  // POST /collaborative-sessions/:id/close — Close session (teacher)
  server.post('/collaborative-sessions/:id/close', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
  }, async (request) => {
    const { id } = request.params as { id: string }

    const user = getUser(request)
    await withTenantContext(user.districtId, async (tx) => {
      await tx.collaborativeSession.update({
        where: { id },
        data: { status: 'closed', closedAt: new Date() },
      })
    })

    return { sessionId: id, status: 'closed' }
  })
}
