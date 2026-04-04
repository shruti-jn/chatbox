/**
 * Conversation Context Builder
 *
 * Loads all context needed for a ChatBridge AI generation:
 * - Conversation + classroom config
 * - Recent messages (excluding whispers for students)
 * - Active app instance state
 * - Pending teacher whisper
 * - Enabled app tool definitions
 *
 * Used by both chat.ts (existing) and chatbridge-completions.ts (native endpoint).
 */

import { withTenantContext } from '../middleware/rls.js'

export interface ConversationContext {
  conversation: {
    id: string
    classroomId: string
    classroom: {
      name: string
      gradeBand: string
      teacherId: string
      aiConfig: Record<string, any>
    }
  } | null

  recentMessages: Array<{
    id: string
    authorRole: string
    contentParts: any
    createdAt: Date
  }>

  activeAppInstance: {
    id: string
    appId: string
    status: string
    stateSnapshot: any
    updatedAt: Date
    app: {
      name: string
      toolDefinitions: any
    }
  } | null

  whisperGuidance: string | null

  enabledApps: Array<{
    appId: string
    app: {
      id: string
      name: string
      toolDefinitions: any
      uiManifest: any
      reviewStatus: string
    }
  }>

  aiConfig: {
    mode: string
    subject?: string
    tone?: string
    complexity?: string
    asyncGuidance?: string
  }

  gradeBand: string
}

/**
 * Load all conversation context needed for AI generation.
 *
 * @param conversationId - The conversation UUID
 * @param districtId - The tenant district UUID (from JWT)
 * @param userRole - The requesting user's role (affects message visibility)
 */
export async function loadConversationContext(
  conversationId: string,
  districtId: string,
  userRole: string = 'student',
): Promise<ConversationContext> {
  // Load conversation with classroom
  const conversation = await withTenantContext(districtId, async (tx) => {
    return tx.conversation.findUnique({
      where: { id: conversationId },
      include: {
        classroom: {
          select: {
            id: true,
            name: true,
            gradeBand: true,
            teacherId: true,
            aiConfig: true,
          },
        },
      },
    })
  })

  // Load recent messages (exclude whispers for students)
  const recentMessages = await withTenantContext(districtId, async (tx) => {
    return tx.message.findMany({
      where: {
        conversationId,
        ...(userRole === 'student' ? { authorRole: { not: 'teacher_whisper' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
  })

  // Load active/suspended app instance
  const activeAppInstance = await withTenantContext(districtId, async (tx) => {
    return tx.appInstance.findFirst({
      where: {
        conversationId,
        status: { in: ['active', 'suspended'] },
      },
      include: { app: { select: { name: true, toolDefinitions: true } } },
      orderBy: { updatedAt: 'desc' },
    })
  })

  // Load pending teacher whisper (last 5 minutes)
  const whisper = await withTenantContext(districtId, async (tx) => {
    return tx.message.findFirst({
      where: {
        conversationId,
        authorRole: 'teacher_whisper',
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  const whisperGuidance = whisper
    ? ((whisper.contentParts as any[])?.[0]?.text ?? null)
    : null

  // Load enabled apps for this classroom
  const enabledApps = conversation?.classroomId
    ? await withTenantContext(districtId, async (tx) => {
        return tx.classroomAppConfig.findMany({
          where: { classroomId: conversation.classroomId, enabled: true },
          include: {
            app: {
              select: {
                id: true,
                name: true,
                toolDefinitions: true,
                uiManifest: true,
                reviewStatus: true,
              },
            },
          },
        })
      })
    : []

  // Derive AI config
  const classroomConfig = conversation?.classroom?.aiConfig as Record<string, any> ?? {}
  const aiConfig = {
    mode: classroomConfig.mode ?? 'direct',
    subject: classroomConfig.subject,
    tone: classroomConfig.tone,
    complexity: classroomConfig.complexity,
    asyncGuidance: classroomConfig.asyncGuidance,
  }

  const gradeBand = conversation?.classroom?.gradeBand ?? 'g68'

  return {
    conversation: conversation ? {
      id: conversation.id,
      classroomId: conversation.classroomId,
      classroom: {
        name: conversation.classroom?.name ?? '',
        gradeBand: conversation.classroom?.gradeBand ?? 'g68',
        teacherId: conversation.classroom?.teacherId ?? '',
        aiConfig: classroomConfig,
      },
    } : null,
    recentMessages,
    activeAppInstance: activeAppInstance as any,
    whisperGuidance,
    enabledApps: enabledApps as any,
    aiConfig,
    gradeBand,
  }
}
