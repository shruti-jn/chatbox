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

// Connection registries
const chatConnections = new Map<string, Set<WebSocket>>() // conversationId → sockets
const missionControlConnections = new Map<string, Set<WebSocket>>() // classroomId → sockets
const collabConnections = new Map<string, Set<WebSocket>>() // sessionId → sockets

export async function websocketRoutes(server: FastifyInstance) {
  // WS /ws/chat — Student chat
  server.get('/ws/chat', { websocket: true }, (socket, request) => {
    const token = (request.query as Record<string, string>)?.token
    let user: JWTPayload

    try {
      user = verifyJWT(token)
    } catch {
      socket.close(4001, 'Authentication failed')
      return
    }

    const conversationId = (request.query as Record<string, string>)?.conversationId

    if (conversationId) {
      if (!chatConnections.has(conversationId)) {
        chatConnections.set(conversationId, new Set())
      }
      chatConnections.get(conversationId)!.add(socket as any)
    }

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())

        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }))
          return
        }

        // Handle typing indicator
        if (msg.type === 'typing') {
          // Broadcast to Mission Control for this classroom
          broadcastToMissionControl(user.districtId, {
            type: 'student_typing',
            studentId: user.userId,
            conversationId,
          })
        }
      } catch {
        // Ignore invalid messages
      }
    })

    socket.on('close', () => {
      if (conversationId) {
        chatConnections.get(conversationId)?.delete(socket as any)
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
