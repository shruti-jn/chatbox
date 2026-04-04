import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Redis from 'ioredis'
import {
  publishCommand,
  awaitStateUpdate,
  hasActiveSubscription,
  shutdown,
} from '../src/cbp/redis-dispatch.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380'

// A helper Redis client for test-side pub/sub verification
let helperRedis: Redis

beforeAll(async () => {
  helperRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
  await helperRedis.connect()
})

afterAll(async () => {
  await shutdown()
  await helperRedis.quit()
})

describe('redis-dispatch', () => {
  // 1. publishCommand publishes to correct channel
  it('publishCommand publishes to correct channel', async () => {
    const instanceId = `test-pub-${Date.now()}`
    const channel = `cbp:cmd:${instanceId}`
    const command = { action: 'navigate', url: '/home' }

    // Subscribe on the helper client to verify the message arrives
    const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
    await subscriber.connect()

    const received = new Promise<string>((resolve) => {
      subscriber.subscribe(channel, () => {
        subscriber.on('message', (_ch: string, msg: string) => {
          resolve(msg)
        })
      })
    })

    // Small delay to ensure subscription is active
    await new Promise((r) => setTimeout(r, 50))

    await publishCommand(instanceId, command)

    const msg = await received
    expect(JSON.parse(msg)).toEqual(command)

    await subscriber.quit()
  })

  // 2. awaitStateUpdate resolves when message arrives on state channel
  it('awaitStateUpdate resolves when message arrives on state channel', async () => {
    const instanceId = `test-state-${Date.now()}`
    const stateChannel = `cbp:state:${instanceId}`
    const payload = { status: 'ready', page: '/dashboard' }

    // Start awaiting (subscribes internally)
    const promise = awaitStateUpdate(instanceId, 5000)

    // Give subscription time to establish
    await new Promise((r) => setTimeout(r, 100))

    // Publish from helper client
    await helperRedis.publish(stateChannel, JSON.stringify(payload))

    const result = await promise
    expect(result).toEqual(payload)
  })

  // 3. awaitStateUpdate rejects with timeout error after specified ms
  it('awaitStateUpdate rejects with timeout error', async () => {
    const instanceId = `test-timeout-${Date.now()}`

    await expect(awaitStateUpdate(instanceId, 200)).rejects.toThrow(/timeout/i)
  })

  // 4. awaitStateUpdate unsubscribes after receiving first message
  it('awaitStateUpdate unsubscribes after receiving first message', async () => {
    const instanceId = `test-unsub-${Date.now()}`
    const stateChannel = `cbp:state:${instanceId}`

    const promise = awaitStateUpdate(instanceId, 5000)

    await new Promise((r) => setTimeout(r, 100))

    await helperRedis.publish(stateChannel, JSON.stringify({ done: true }))
    await promise

    // After resolving, there should be no active subscription
    expect(hasActiveSubscription(instanceId)).toBe(false)
  })

  // 5. Multiple concurrent awaitStateUpdate calls for different instances work
  it('multiple concurrent awaitStateUpdate calls for different instances', async () => {
    const id1 = `test-multi-1-${Date.now()}`
    const id2 = `test-multi-2-${Date.now()}`

    const promise1 = awaitStateUpdate(id1, 5000)
    const promise2 = awaitStateUpdate(id2, 5000)

    await new Promise((r) => setTimeout(r, 100))

    const payload1 = { instance: 1 }
    const payload2 = { instance: 2 }

    await helperRedis.publish(`cbp:state:${id1}`, JSON.stringify(payload1))
    await helperRedis.publish(`cbp:state:${id2}`, JSON.stringify(payload2))

    const [result1, result2] = await Promise.all([promise1, promise2])
    expect(result1).toEqual(payload1)
    expect(result2).toEqual(payload2)
  })

  // 6. hasActiveSubscription returns true while awaiting, false after resolve
  it('hasActiveSubscription reflects subscription lifecycle', async () => {
    const instanceId = `test-active-${Date.now()}`
    const stateChannel = `cbp:state:${instanceId}`

    expect(hasActiveSubscription(instanceId)).toBe(false)

    const promise = awaitStateUpdate(instanceId, 5000)

    // Give subscription time to establish
    await new Promise((r) => setTimeout(r, 100))

    expect(hasActiveSubscription(instanceId)).toBe(true)

    await helperRedis.publish(stateChannel, JSON.stringify({ ok: true }))
    await promise

    expect(hasActiveSubscription(instanceId)).toBe(false)
  })

  // 7. shutdown cleans up subscriber client
  it('shutdown cleans up subscriber client', async () => {
    const instanceId = `test-shutdown-${Date.now()}`

    // Start a subscription so the subscriber client is created
    const promise = awaitStateUpdate(instanceId, 5000)
    await new Promise((r) => setTimeout(r, 100))

    // Attach rejection handler BEFORE shutdown to avoid unhandled rejection warning
    const rejectionPromise = promise.catch((err: Error) => err)

    // Shutdown should clean up; the pending await should reject
    await shutdown()

    // After shutdown, hasActiveSubscription should return false
    expect(hasActiveSubscription(instanceId)).toBe(false)

    // The promise should have rejected since the subscriber was killed
    const error = await rejectionPromise
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/shutting down/i)
  })
})
