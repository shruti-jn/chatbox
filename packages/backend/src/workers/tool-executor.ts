/**
 * Tool Execution Worker — SHR-205
 *
 * Processes AppInvocationJobs from the queue:
 * 1. Picks highest-priority job (P0 > P1 > P2), oldest first within priority
 * 2. Executes tool with deadline enforcement
 * 3. Updates job with result or error
 * 4. Retries retryable failures up to maxAttempts
 *
 * IMPORTANT: This worker must run as a single instance.
 * Per-app concurrency is tracked in-process. Running multiple instances
 * will multiply the effective concurrency limit.
 *
 * Polling interval: 500ms when idle, immediate when jobs found
 */

import { PrismaClient } from '@prisma/client'
import { broadcastToChatConversation } from '../routes/websocket.js'

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

const PER_APP_CONCURRENCY = parseInt(process.env.TOOL_WORKER_CONCURRENCY ?? '20', 10)
const POLL_INTERVAL_MS = 500
const BACKOFF_BASE_MS = 1000

/** Track running jobs per app for concurrency control (single-instance only) */
const runningPerApp = new Map<string, number>()

function appKey(toolName: string): string {
  return toolName.split('__')[0] ?? toolName
}

function getRunningCount(toolName: string): number {
  return runningPerApp.get(appKey(toolName)) ?? 0
}

function incrementRunning(toolName: string): void {
  const k = appKey(toolName)
  runningPerApp.set(k, (runningPerApp.get(k) ?? 0) + 1)
}

function decrementRunning(toolName: string): void {
  const k = appKey(toolName)
  runningPerApp.set(k, Math.max(0, (runningPerApp.get(k) ?? 0) - 1))
}

/**
 * Pick the next job to execute.
 * Skips apps at concurrency limit and tries the next eligible job.
 */
async function pickNextJob() {
  const candidates = await prisma.appInvocationJob.findMany({
    where: {
      status: 'queued',
      deadlineAt: { gt: new Date() },
    },
    orderBy: [
      { priority: 'asc' },
      { queuedAt: 'asc' },
    ],
    take: 10, // Check up to 10 candidates to find one with capacity
  })

  for (const candidate of candidates) {
    if (getRunningCount(candidate.toolName) >= PER_APP_CONCURRENCY) {
      continue // This app is at capacity — try the next candidate
    }

    // Atomically claim the job
    const claimed = await prisma.appInvocationJob.updateMany({
      where: { id: candidate.id, status: 'queued' },
      data: { status: 'running', startedAt: new Date() },
    })

    if (claimed.count === 0) continue // Someone else claimed it

    // Increment running BEFORE returning — prevents micro-race in fire-and-forget loop
    incrementRunning(candidate.toolName)

    return prisma.appInvocationJob.findUnique({ where: { id: candidate.id } })
  }

  return null
}

/**
 * Execute a tool and update the job with the result.
 */
async function executeJob(job: NonNullable<Awaited<ReturnType<typeof pickNextJob>>>) {
  // Note: incrementRunning already called in pickNextJob

  try {
    const timeoutMs = Math.max(0, job.deadlineAt.getTime() - Date.now())

    const result = await Promise.race([
      executeToolByName(job.toolName, job.parameters as Record<string, unknown>),
      new Promise<{ error: true; message: string }>((resolve) =>
        setTimeout(() => resolve({ error: true, message: 'Tool execution timed out' }), timeoutMs),
      ),
    ])

    const isError = (result as any).error === true
    const status = isError ? 'timed_out' as const : 'completed' as const

    await prisma.appInvocationJob.update({
      where: { id: job.id },
      data: {
        status,
        completedAt: new Date(),
        result: result as any,
        attemptCount: job.attemptCount + 1,
        ...(isError ? { errorCode: 'TOOL_TIMEOUT' } : {}),
      },
    })

    broadcastToChatConversation(job.conversationId, {
      type: 'job_completed',
      jobId: job.id,
      status,
      resumeToken: job.resumeToken,
    })
  } catch (err) {
    const attemptCount = job.attemptCount + 1
    const shouldRetry = job.retryable && attemptCount < job.maxAttempts

    if (shouldRetry) {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1)
      // Extend deadline on retry so the re-queued job isn't instantly filtered out
      const newDeadline = new Date(Date.now() + backoffMs + 15_000)

      await prisma.appInvocationJob.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          attemptCount,
          queuedAt: new Date(Date.now() + backoffMs),
          startedAt: null,
          deadlineAt: newDeadline,
        },
      })
    } else {
      await prisma.appInvocationJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          attemptCount,
          errorCode: 'EXECUTION_FAILED',
          result: { error: true, message: err instanceof Error ? err.message : 'Unknown error' } as any,
        },
      })

      broadcastToChatConversation(job.conversationId, {
        type: 'job_completed',
        jobId: job.id,
        status: 'failed',
        resumeToken: job.resumeToken,
      })
    }
  } finally {
    decrementRunning(job.toolName)
  }
}

/**
 * Execute a tool by name.
 */
async function executeToolByName(
  toolName: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case 'start_game':
      return { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', status: 'new_game' }
    case 'get_weather': {
      const { getWeather } = await import('../services/weather.js')
      return getWeather(String(params.location ?? 'New York')) as any
    }
    case 'search_tracks': {
      const { searchTracks } = await import('../services/spotify.js')
      return searchTracks(String(params.query ?? 'study music')) as any
    }
    default:
      return { error: true, message: `Unknown tool: ${toolName}` }
  }
}

/**
 * Sweep timed-out jobs and notify clients.
 */
async function sweepTimedOutJobs() {
  // Find affected jobs BEFORE sweeping (need IDs for broadcast)
  const stuckJobs = await prisma.appInvocationJob.findMany({
    where: { status: 'running', deadlineAt: { lt: new Date() } },
    select: { id: true, conversationId: true, resumeToken: true, attemptCount: true },
  })

  if (stuckJobs.length === 0) return

  // Update by collected IDs to avoid TOCTOU race with pickNextJob
  await prisma.appInvocationJob.updateMany({
    where: { id: { in: stuckJobs.map(j => j.id) }, status: 'running' },
    data: {
      status: 'timed_out',
      completedAt: new Date(),
      errorCode: 'DEADLINE_EXCEEDED',
      result: { error: true, message: 'The app did not respond in time.' } as any,
    },
  })

  // Notify clients for each swept job
  for (const job of stuckJobs) {
    broadcastToChatConversation(job.conversationId, {
      type: 'job_completed',
      jobId: job.id,
      status: 'timed_out',
      resumeToken: job.resumeToken,
    })
  }

  console.log(`[tool-executor] Swept ${stuckJobs.length} timed-out jobs`)
}

/**
 * Main worker loop.
 */
export async function startToolExecutorWorker() {
  console.log(`[tool-executor] Worker started (concurrency: ${PER_APP_CONCURRENCY}/app, poll: ${POLL_INTERVAL_MS}ms)`)
  console.log(`[tool-executor] WARNING: This worker must run as a single instance`)

  setInterval(sweepTimedOutJobs, 5000)

  while (true) {
    try {
      const job = await pickNextJob()
      if (job) {
        // Fire-and-forget — incrementRunning already called in pickNextJob
        executeJob(job).catch((err) => {
          console.error(`[tool-executor] Unhandled error in job ${job.id}:`, err)
        })
        continue
      }
    } catch (err) {
      console.error('[tool-executor] Error in worker loop:', err)
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export { pickNextJob, executeJob, sweepTimedOutJobs, runningPerApp }
