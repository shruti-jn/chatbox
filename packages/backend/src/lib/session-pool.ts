/**
 * Warm Session Pool — SHR-208
 *
 * Pre-warms student conversation contexts in Redis for fast cold-start.
 * On POST /chatbridge/completions, the context loader checks Redis first.
 * If cache hit, skips the DB queries for messages + prompt assembly.
 *
 * Cache key: session:{conversationId}
 * TTL: configurable via SESSION_CACHE_TTL_SEC (default: 900 = 15 min)
 */

import Redis from 'ioredis'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

const CACHE_TTL_SEC = parseInt(process.env.SESSION_CACHE_TTL_SEC ?? '900', 10)

let redis: Redis | null = null
let redisConnected = false

async function getRedis(): Promise<Redis> {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    })
    redis.on('error', () => {})
  }
  if (!redisConnected) {
    await redis.connect().catch(() => {})
    redisConnected = true
  }
  return redis
}

export interface CachedSessionContext {
  // systemPrompt is always assembled at request time (depends on whisper, config, etc.)
  recentMessages: Array<{ role: string; content: string }>
  activeAppName: string | null
  activeAppState: Record<string, unknown> | null
  cachedAt: string
}

/**
 * Get a cached session context from Redis.
 * Returns null on cache miss or Redis failure.
 */
export async function getCachedContext(conversationId: string): Promise<CachedSessionContext | null> {
  try {
    const client = await getRedis()
    const raw = await client.get(`session:${conversationId}`)
    if (!raw) return null
    return JSON.parse(raw) as CachedSessionContext
  } catch {
    return null // Cache miss is non-fatal
  }
}

/**
 * Store a session context in Redis cache.
 */
export async function cacheContext(conversationId: string, context: CachedSessionContext): Promise<void> {
  try {
    const client = await getRedis()
    await client.setex(`session:${conversationId}`, CACHE_TTL_SEC, JSON.stringify(context))
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Pre-warm all student sessions in a classroom.
 * Called by POST /admin/pre-warm or by a cron job.
 */
export async function preWarmClassroom(classroomId: string, districtId: string): Promise<{ warmed: number; errors: number }> {
  let warmed = 0
  let errors = 0

  try {
    const memberships = await prisma.classroomMembership.findMany({
      where: { classroomId },
      select: { studentId: true },
    })

    for (const { studentId } of memberships) {
      try {
        // Find the student's most recent conversation in this classroom
        const conv = await prisma.conversation.findFirst({
          where: { classroomId, studentId },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        })

        if (!conv) continue

        // Load recent messages
        const messages = await prisma.message.findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
        })

        const recentMessages = messages.reverse().map((m) => ({
          role: m.authorRole === 'student' ? 'user' : 'assistant',
          content: (m.contentParts as any[])?.[0]?.text ?? '',
        }))

        // Load active app state
        const activeApp = await prisma.appInstance.findFirst({
          where: { conversationId: conv.id, status: { in: ['active', 'suspended'] } },
          include: { app: { select: { name: true } } },
          orderBy: { updatedAt: 'desc' },
        })

        // Load classroom config for prompt assembly
        const classroom = await prisma.classroom.findUnique({
          where: { id: classroomId },
          select: { aiConfig: true, gradeBand: true },
        })

        const context: CachedSessionContext = {
          recentMessages,
          activeAppName: activeApp?.app?.name ?? null,
          activeAppState: activeApp?.status === 'active' ? (activeApp.stateSnapshot as any) : null,
          cachedAt: new Date().toISOString(),
        }

        await cacheContext(conv.id, context)
        warmed++
      } catch {
        errors++
      }
    }
  } catch {
    errors++
  }

  return { warmed, errors }
}

/**
 * Check if a conversation has a warm cache entry.
 */
export async function isCacheHit(conversationId: string): Promise<boolean> {
  try {
    const client = await getRedis()
    return (await client.exists(`session:${conversationId}`)) === 1
  } catch {
    return false
  }
}
