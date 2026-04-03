import type { FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { JWTPayloadSchema, type JWTPayload, type UserRole } from '@chatbridge/shared'

const JWT_SECRET = process.env.JWT_SECRET_KEY ?? 'dev-secret'

export function signJWT(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' }) // School day session
}

export function verifyJWT(token: string): JWTPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>
  return JWTPayloadSchema.parse(decoded)
}

/**
 * Fastify preHandler hook: authenticate via JWT
 * Supports: Authorization header OR ?token= query param (WebSocket)
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization
  const queryToken = (request.query as Record<string, string>)?.token

  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : queryToken

  if (!token) {
    return reply.status(401).send({ error: 'Authentication required' })
  }

  try {
    const payload = verifyJWT(token)
    // Attach to request for downstream use
    ;(request as any).user = payload
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }
}

/**
 * RBAC preHandler: require specific role(s)
 */
export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user as JWTPayload | undefined
    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' })
    }
    if (!roles.includes(user.role)) {
      return reply.status(403).send({ error: 'Insufficient permissions' })
    }
  }
}

/**
 * Extract user from request (after authenticate middleware)
 */
export function getUser(request: FastifyRequest): JWTPayload {
  const user = (request as any).user as JWTPayload | undefined
  if (!user) throw new Error('User not authenticated — ensure authenticate middleware runs first')
  return user
}
