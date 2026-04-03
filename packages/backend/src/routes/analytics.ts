import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { prisma, withTenantContext } from '../middleware/rls.js'

export async function analyticsRoutes(server: FastifyInstance) {
  // GET /classrooms/:id/analytics — Learning analytics
  server.get('/classrooms/:classroomId/analytics', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
    schema: {
      params: { type: 'object', properties: { classroomId: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string' },
          endDate: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { classroomId } = request.params as { classroomId: string }
    const user = getUser(request)
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string }

    const dateFilter = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    }

    const [messageCount, safetyEvents, toolInvocations, conversations] = await Promise.all([
      withTenantContext(user.districtId, (tx) =>
        tx.message.count({
          where: {
            conversation: { classroomId },
            ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
          },
        })
      ),
      withTenantContext(user.districtId, (tx) =>
        tx.safetyEvent.count({
          where: {
            ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
          },
        })
      ),
      withTenantContext(user.districtId, (tx) =>
        tx.toolInvocation.count({
          where: {
            conversation: { classroomId },
            ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
          },
        })
      ),
      withTenantContext(user.districtId, (tx) =>
        tx.conversation.findMany({
          where: { classroomId },
          include: {
            student: { select: { id: true, displayName: true } },
            _count: { select: { messages: true } },
          },
        })
      ),
    ])

    // Per-student metrics
    const studentMetrics = conversations.map(conv => ({
      studentId: conv.student.id,
      displayName: conv.student.displayName,
      messageCount: conv._count.messages,
      lastActive: conv.updatedAt,
    }))

    return {
      classroomId,
      period: { startDate, endDate },
      summary: {
        totalMessages: messageCount,
        totalSafetyEvents: safetyEvents,
        totalToolInvocations: toolInvocations,
        activeStudents: conversations.length,
      },
      students: studentMetrics,
    }
  })
}
