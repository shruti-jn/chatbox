/**
 * CBP Redis Pub/Sub Dispatch — Layer 1
 *
 * Publishes commands to cbp:cmd:{instanceId} channels and
 * awaits state updates on cbp:state:{instanceId} channels.
 *
 * Uses a shared ioredis subscriber client with a resolver map
 * to dispatch incoming messages to the correct awaitStateUpdate caller.
 */

import Redis from 'ioredis'
import { getRedisClient } from '../lib/redis.js'

interface PendingEntry {
  resolve: (message: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Map of instanceId -> pending entry for awaitStateUpdate calls */
const pending = new Map<string, PendingEntry>()

/** The dedicated subscriber client (ioredis requires separate client for sub) */
let subscriberClient: Redis | null = null

function getSubscriberClient(): Redis {
  if (!subscriberClient) {
    const url = process.env.REDIS_URL
    if (!url) {
      throw new Error('REDIS_URL is not set')
    }
    subscriberClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    })

    subscriberClient.on('message', (channel: string, message: string) => {
      const prefix = 'cbp:state:'
      if (!channel.startsWith(prefix)) return
      const instanceId = channel.slice(prefix.length)
      const entry = pending.get(instanceId)
      if (entry) {
        entry.resolve(message)
      }
    })
  }
  return subscriberClient
}

/**
 * Publish a command to the CBP command channel for the given instance.
 */
export async function publishCommand(
  instanceId: string,
  command: Record<string, unknown>,
): Promise<void> {
  const client = getRedisClient()
  await client.connect().catch(() => {
    /* already connected */
  })
  const channel = `cbp:cmd:${instanceId}`
  await client.publish(channel, JSON.stringify(command))
}

/**
 * Subscribe to the state channel for the given instance and resolve
 * when the first message arrives. Rejects on timeout. Cleans up after.
 */
export async function awaitStateUpdate(
  instanceId: string,
  timeoutMs: number,
): Promise<unknown> {
  const sub = getSubscriberClient()
  await sub.connect().catch(() => {
    /* already connected */
  })

  const channel = `cbp:state:${instanceId}`

  return new Promise<unknown>((resolve, reject) => {
    let settled = false

    const settle = () => {
      if (settled) return false
      settled = true
      return true
    }

    const cleanup = () => {
      pending.delete(instanceId)
      clearTimeout(entry.timer)
      sub.unsubscribe(channel).catch(() => {
        /* ignore errors during cleanup */
      })
    }

    const entry: PendingEntry = {
      resolve: (message: string) => {
        if (!settle()) return
        cleanup()
        try {
          resolve(JSON.parse(message))
        } catch {
          resolve(message)
        }
      },
      reject: (err: Error) => {
        if (!settle()) return
        cleanup()
        reject(err)
      },
      timer: setTimeout(() => {
        if (!settle()) return
        cleanup()
        reject(new Error(`Timeout waiting for state update on ${channel} after ${timeoutMs}ms`))
      }, timeoutMs),
    }

    pending.set(instanceId, entry)

    sub.subscribe(channel).catch((err: Error) => {
      if (!settle()) return
      cleanup()
      reject(err)
    })
  })
}

/**
 * Check if there is an active subscription awaiting a state update
 * for the given instance.
 */
export function hasActiveSubscription(instanceId: string): boolean {
  return pending.has(instanceId)
}

/**
 * Shut down the subscriber client and reject all pending awaiters.
 */
export async function shutdown(): Promise<void> {
  // Reject all pending entries
  const entries = Array.from(pending.entries())
  for (const [, entry] of entries) {
    entry.reject(new Error('Redis dispatch shutting down'))
  }
  pending.clear()

  if (subscriberClient) {
    try {
      await subscriberClient.quit()
    } catch {
      // Ignore errors on quit
    }
    subscriberClient = null
  }
}
