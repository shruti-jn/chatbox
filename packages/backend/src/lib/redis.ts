import Redis from 'ioredis'

let redisClient: Redis | null = null

/**
 * Get or create the singleton Redis client.
 * Uses REDIS_URL from environment.
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL
    if (!url) {
      throw new Error('REDIS_URL is not set')
    }
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    })
  }
  return redisClient
}

/**
 * Disconnect and reset the Redis client (for graceful shutdown / tests).
 */
export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit()
    } catch {
      // Ignore errors on quit
    }
    redisClient = null
  }
}

/**
 * Reset the singleton (for tests that need a fresh client).
 */
export function resetRedisClient(): void {
  redisClient = null
}
