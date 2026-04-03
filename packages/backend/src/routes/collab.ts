import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { prisma } from '../middleware/rls.js'
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
      const instance = await prisma.appInstance.create({
        data: { appId, conversationId, districtId: user.districtId, status: 'active' },
      })
      appInstanceId = instance.id
    }

    if (!appInstanceId) {
      return reply.status(400).send({ error: 'conversationId required' })
    }

    const sessionCode = crypto.randomBytes(3).toString('hex').toUpperCase()

    const session = await prisma.collaborativeSession.create({
      data: {
        districtId: user.districtId,
        appInstanceId,
        sessionCode,
        interactionModel,
        createdBy: user.userId,
      },
    })

    // Add creator as first participant
    await prisma.sessionParticipant.create({
      data: {
        sessionId: session.id,
        userId: user.userId,
        colorAssignment: 'white',
        turnOrder: 1,
      },
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

    const session = await prisma.collaborativeSession.findUnique({
      where: { sessionCode: code },
      include: { participants: true },
    })

    if (!session) return reply.status(404).send({ error: 'Session not found' })
    if (session.status !== 'active') return reply.status(409).send({ error: 'Session is closed' })

    // Check if already joined
    const existing = session.participants.find(p => p.userId === user.userId)
    if (existing) {
      return { sessionId: session.id, participantId: existing.id, color: existing.colorAssignment }
    }

    const participant = await prisma.sessionParticipant.create({
      data: {
        sessionId: session.id,
        userId: user.userId,
        colorAssignment: session.participants.length === 0 ? 'white' : 'black',
        turnOrder: session.participants.length + 1,
      },
    })

    return {
      sessionId: session.id,
      participantId: participant.id,
      color: participant.colorAssignment,
      participants: session.participants.length + 1,
    }
  })

  // POST /collaborative-sessions/:id/close — Close session (teacher)
  server.post('/collaborative-sessions/:id/close', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
  }, async (request) => {
    const { id } = request.params as { id: string }

    await prisma.collaborativeSession.update({
      where: { id },
      data: { status: 'closed', closedAt: new Date() },
    })

    return { sessionId: id, status: 'closed' }
  })
}
