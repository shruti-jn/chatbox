/**
 * WebSocket endpoints for real-time features
 *
 * WS /ws/chat — Student chat (streaming + app state)
 * WS /ws/mission-control — Teacher monitoring (student grid + alerts)
 * WS /ws/collab/:sessionId — Collaborative session (state sync)
 */

import type { FastifyInstance } from 'fastify'
import { verifyJWT } from '../middleware/auth.js'
import type { JWTPayload } from '@chatbridge/shared'
import { prisma, withTenantContext } from '../middleware/rls.js'
import { runSafetyPipeline } from '../safety/pipeline.js'
import { getRedisClient } from '../lib/redis.js'

/** Grade bands that require parental consent (under-13) — mirrors coppa.ts */
const COPPA_GRADE_BANDS = new Set(['k2', 'g35'])

/**
 * Check COPPA consent for a user. Returns true if access is allowed.
 * Teachers/admins and students in grade bands g68+ are always allowed.
 * Under-13 students need a 'granted' parental consent record.
 */
async function checkCoppaConsent(user: JWTPayload): Promise<boolean> {
  if (user.role !== 'student') return true
  if (!user.gradeBand || !COPPA_GRADE_BANDS.has(user.gradeBand)) return true

  const consent = await prisma.parentalConsent.findUnique({
    where: { studentId: user.userId },
  })
  return consent?.consentStatus === 'granted'
}

// Connection registries
const chatConnections = new Map<string, Set<WebSocket>>() // conversationId → sockets
const missionControlConnections = new Map<string, Set<WebSocket>>() // classroomId → sockets
const collabConnections = new Map<string, Set<WebSocket>>() // sessionId → sockets
const appInstanceConnections = new Map<string, WebSocket>() // instanceId → socket

/** Check if a WS client is connected for a given app instance */
export function hasActiveAppConnection(instanceId: string): boolean {
  return appInstanceConnections.has(instanceId)
}

/** Register a WS connection for a given app instance */
export function registerAppConnection(instanceId: string, socket: WebSocket): void {
  appInstanceConnections.set(instanceId, socket)
}

/** Remove a WS connection for a given app instance */
export function unregisterAppConnection(instanceId: string): void {
  appInstanceConnections.delete(instanceId)
}

/**
 * Send a CBP command to the WS client for the given instanceId.
 * Returns true if sent, false if no connection exists.
 */
export function sendCommandToApp(instanceId: string, command: Record<string, unknown>): boolean {
  const socket = appInstanceConnections.get(instanceId)
  if (!socket) return false
  try {
    socket.send(JSON.stringify(command))
    return true
  } catch {
    return false
  }
}

/**
 * Publish an app state update to Redis cbp:state:{instanceId}.
 * Called when the frontend sends an app_state_update WS message.
 */
export async function handleAppStateUpdate(
  instanceId: string,
  state: Record<string, unknown>,
  districtId?: string,
): Promise<void> {
  const client = getRedisClient()
  await client.connect().catch(() => { /* already connected */ })
  const channel = `cbp:state:${instanceId}`
  await client.publish(channel, JSON.stringify(state))

  // Persist state snapshot to DB so chat route can read it
  if (districtId) {
    try {
      await withTenantContext(districtId, async (tx) => {
        await tx.appInstance.update({
          where: { id: instanceId },
          data: { stateSnapshot: state as any },
        })
      })
    } catch (err) {
      console.warn(`[CBP] Failed to persist state for instance ${instanceId}:`, err)
    }
  }
}

export async function websocketRoutes(server: FastifyInstance) {
  // WS /ws/chat — Student chat
  server.get('/ws/chat', { websocket: true }, async (socket, request) => {
    const token = (request.query as Record<string, string>)?.token
    let user: JWTPayload

    try {
      user = verifyJWT(token)
    } catch {
      socket.close(4001, 'Authentication failed')
      return
    }

    // COPPA consent gate for under-13 students
    const coppaAllowed = await checkCoppaConsent(user)
    if (!coppaAllowed) {
      socket.close(4003, 'COPPA_CONSENT_REQUIRED')
      return
    }

    const conversationId = (request.query as Record<string, string>)?.conversationId
    const instanceId = (request.query as Record<string, string>)?.instanceId

    if (conversationId) {
      if (!chatConnections.has(conversationId)) {
        chatConnections.set(conversationId, new Set())
      }
      chatConnections.get(conversationId)!.add(socket as any)
    }

    // Register app instance connection if instanceId provided
    if (instanceId) {
      registerAppConnection(instanceId, socket as any)
    }

    socket.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())

        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }))
          return
        }

        // Handle app state updates — forward to Redis for CBP dispatch + persist to DB
        if (msg.type === 'app_state_update' && typeof msg.instanceId === 'string' && msg.state) {
          await handleAppStateUpdate(msg.instanceId, msg.state, user.districtId)
          return
        }

        // Handle typing indicator
        if (msg.type === 'typing') {
          broadcastToMissionControl(user.districtId, {
            type: 'student_typing',
            studentId: user.userId,
            conversationId,
          })
          return
        }

        // Handle chat messages — run safety pipeline before processing
        if (msg.type === 'chat_message' && typeof msg.text === 'string') {
          const safetyResult = await runSafetyPipeline(msg.text)

          // Log safety event for non-safe messages
          if (safetyResult.severity !== 'safe') {
            await withTenantContext(user.districtId, async (tx) => {
              await tx.safetyEvent.create({
                data: {
                  districtId: user.districtId,
                  userId: user.userId,
                  eventType: safetyResult.category === 'crisis' ? 'crisis_detected'
                    : safetyResult.category === 'injection_detected' ? 'injection_detected'
                    : safetyResult.category === 'pii_detected' ? 'pii_detected'
                    : 'content_blocked',
                  severity: safetyResult.severity,
                  messageContextRedacted: safetyResult.redactedMessage.slice(0, 500),
                  actionTaken: safetyResult.severity === 'blocked' ? 'message_rejected'
                    : safetyResult.severity === 'critical' ? 'crisis_resources_returned'
                    : 'message_processed_with_warning',
                },
              })
            })
          }

          if (safetyResult.severity === 'blocked') {
            socket.send(JSON.stringify({
              type: 'safety_blocked',
              category: safetyResult.category,
              error: 'Message could not be processed',
            }))
            return
          }

          if (safetyResult.severity === 'critical') {
            socket.send(JSON.stringify({
              type: 'crisis_resources',
              severity: 'critical',
              crisisResources: safetyResult.crisisResources,
              message: "It sounds like you might be going through a difficult time. Here are some resources that can help:",
            }))
            return
          }

          // Safe or warning — forward with redacted text for AI processing
          socket.send(JSON.stringify({
            type: 'safety_passed',
            severity: safetyResult.severity,
            redactedText: safetyResult.redactedMessage,
          }))
        }
      } catch {
        // Ignore invalid messages
      }
    })

    socket.on('close', () => {
      if (conversationId) {
        chatConnections.get(conversationId)?.delete(socket as any)
      }
      if (instanceId) {
        unregisterAppConnection(instanceId)
      }
    })
  })

  // WS /ws/mission-control — Teacher monitoring
  server.get('/ws/mission-control', { websocket: true }, (socket, request) => {
    const token = (request.query as Record<string, string>)?.token
    let user: JWTPayload

    try {
      user = verifyJWT(token)
      if (user.role !== 'teacher' && user.role !== 'district_admin') {
        socket.close(4001, 'Teacher or admin role required')
        return
      }
    } catch {
      socket.close(4001, 'Authentication failed')
      return
    }

    const classroomId = (request.query as Record<string, string>)?.classroomId

    if (classroomId) {
      if (!missionControlConnections.has(classroomId)) {
        missionControlConnections.set(classroomId, new Set())
      }
      missionControlConnections.get(classroomId)!.add(socket as any)
    }

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }))
        }
      } catch {}
    })

    socket.on('close', () => {
      if (classroomId) {
        missionControlConnections.get(classroomId)?.delete(socket as any)
      }
    })
  })

  // WS /ws/collab/:sessionId — Collaborative session
  server.get('/ws/collab/:sessionId', { websocket: true }, (socket, request) => {
    const token = (request.query as Record<string, string>)?.token
    const { sessionId } = request.params as { sessionId: string }
    let user: JWTPayload

    try {
      user = verifyJWT(token)
    } catch {
      socket.close(4001, 'Authentication failed')
      return
    }

    if (!collabConnections.has(sessionId)) {
      collabConnections.set(sessionId, new Set())
    }
    collabConnections.get(sessionId)!.add(socket as any)

    // Notify other participants
    broadcastToCollab(sessionId, {
      type: 'participant_joined',
      userId: user.userId,
    }, socket as any)

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())

        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }))
          return
        }

        // Broadcast state updates to all participants
        if (msg.type === 'player_action') {
          broadcastToCollab(sessionId, {
            type: 'state_update',
            ...msg,
            userId: user.userId,
          }, socket as any)
        }
      } catch {}
    })

    socket.on('close', () => {
      collabConnections.get(sessionId)?.delete(socket as any)
      broadcastToCollab(sessionId, {
        type: 'participant_left',
        userId: user.userId,
      })
    })
  })
}

// Broadcast to Mission Control connections for a classroom/district
function broadcastToMissionControl(districtId: string, data: Record<string, unknown>) {
  const msg = JSON.stringify(data)
  for (const [, sockets] of missionControlConnections) {
    for (const socket of sockets) {
      try { socket.send(msg) } catch {}
    }
  }
}

// Broadcast to collaborative session participants (except sender)
function broadcastToCollab(sessionId: string, data: Record<string, unknown>, exclude?: WebSocket) {
  const msg = JSON.stringify(data)
  const sockets = collabConnections.get(sessionId)
  if (!sockets) return
  for (const socket of sockets) {
    if (socket !== exclude) {
      try { socket.send(msg) } catch {}
    }
  }
}

// Export for use by other modules (e.g., safety alerts, AI streaming)
export function broadcastToChatConversation(conversationId: string, data: Record<string, unknown>) {
  const msg = JSON.stringify(data)
  const sockets = chatConnections.get(conversationId)
  if (!sockets) return
  for (const socket of sockets) {
    try { socket.send(msg) } catch {}
  }
}

export function sendSafetyAlert(classroomId: string, alert: Record<string, unknown>) {
  const msg = JSON.stringify({ type: 'safety_alert', ...alert })
  const sockets = missionControlConnections.get(classroomId)
  if (!sockets) return
  for (const socket of sockets) {
    try { socket.send(msg) } catch {}
  }
}
