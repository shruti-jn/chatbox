/**
 * Queue Admission Control — SHR-207
 *
 * Backpressure policy for tool invocation jobs:
 * - Queue depth < 100: accept all priorities
 * - Queue depth 100-500: shed P2 (new sessions), accept P0/P1
 * - Queue depth > 500: shed P1+P2, only P0 (mid-lesson) accepted
 * - App degraded (circuit breaker open): reject with "temporarily unavailable"
 *
 * Retry-After header: 3-10 seconds with jitter
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

function getP2ShedThreshold() { return parseInt(process.env.QUEUE_P2_SHED_THRESHOLD ?? '100', 10) }
function getAllShedThreshold() { return parseInt(process.env.QUEUE_ALL_SHED_THRESHOLD ?? '500', 10) }

export interface AdmissionResult {
  admitted: boolean
  reason?: string
  retryAfterSeconds?: number
  queueDepth?: number
}

/**
 * Check if a job should be admitted to the queue.
 */
export async function checkAdmission(priority: number): Promise<AdmissionResult> {
  const queueDepth = await prisma.appInvocationJob.count({
    where: { status: { in: ['queued', 'running'] } },
  })

  const p2Threshold = getP2ShedThreshold()
  const allThreshold = getAllShedThreshold()

  // Under threshold: admit all
  if (queueDepth < p2Threshold) {
    return { admitted: true, queueDepth }
  }

  // P0 (mid-lesson) is never shed
  if (priority === 0) {
    return { admitted: true, queueDepth }
  }

  // 100-500: shed P2 only
  if (queueDepth < allThreshold && priority <= 1) {
    return { admitted: true, queueDepth }
  }

  // Over threshold for this priority — shed with Retry-After
  const retryAfterSeconds = 3 + Math.random() * 7 // 3-10s with jitter
  return {
    admitted: false,
    reason: queueDepth >= allThreshold
      ? 'queue_overloaded'
      : 'queue_saturated_low_priority',
    retryAfterSeconds: Math.round(retryAfterSeconds * 10) / 10,
    queueDepth,
  }
}

/**
 * Assign priority based on conversation recency.
 * P0: message in last 5 min (mid-lesson)
 * P1: existing conversation (returning student)
 * P2: new session
 */
export async function assignPriority(conversationId: string, districtId: string): Promise<0 | 1 | 2> {
  // Check for recent messages in this conversation (scoped to district)
  const recentMessage = await prisma.message.findFirst({
    where: {
      conversationId,
      districtId,
      createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) },
    },
    select: { id: true },
  })

  if (recentMessage) return 0 // Mid-lesson

  // Check if conversation has any messages at all (scoped to district)
  const hasMessages = await prisma.message.findFirst({
    where: { conversationId, districtId },
    select: { id: true },
  })

  if (hasMessages) return 1 // Returning student

  return 2 // New session
}

/**
 * Get current queue stats for monitoring.
 */
export async function getQueueStats() {
  const [queued, running, completed, failed, timedOut] = await Promise.all([
    prisma.appInvocationJob.count({ where: { status: 'queued' } }),
    prisma.appInvocationJob.count({ where: { status: 'running' } }),
    prisma.appInvocationJob.count({ where: { status: 'completed' } }),
    prisma.appInvocationJob.count({ where: { status: 'failed' } }),
    prisma.appInvocationJob.count({ where: { status: 'timed_out' } }),
  ])

  return {
    pendingJobs: queued + running,
    queued,
    running,
    completed,
    failed,
    timedOut,
    p2ShedThreshold: getP2ShedThreshold(),
    allShedThreshold: getAllShedThreshold(),
  }
}
