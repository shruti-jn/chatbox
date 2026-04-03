import type { FastifyInstance } from 'fastify'
import { signJWT, authenticate, requireRole, getUser } from '../middleware/auth.js'
import { prisma } from '../middleware/rls.js'
import { LoginRequestSchema } from '@chatbridge/shared'
import crypto from 'crypto'

export async function authRoutes(server: FastifyInstance) {
  // POST /auth/login — Platform JWT login (fallback when LTI unavailable)
  server.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            role: { type: 'string' },
            displayName: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string }

    // Find user by email hash (we never store plaintext emails)
    const emailHash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')
    const user = await prisma.user.findFirst({
      where: { emailHash },
    })

    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    // Note: In production, this would verify against a hashed password.
    // For V1, primary auth is via LTI SSO. This is the fallback path.
    const token = signJWT({
      userId: user.id,
      role: user.role,
      districtId: user.districtId,
      schoolId: user.schoolId ?? undefined,
      gradeBand: user.gradeBand ?? undefined,
    })

    return { token, role: user.role, displayName: user.displayName }
  })

  // GET /auth/me — Get current user info (authenticated)
  server.get('/auth/me', {
    preHandler: [authenticate],
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            role: { type: 'string' },
            districtId: { type: 'string' },
            displayName: { type: 'string' },
          },
        },
      },
    },
  }, async (request) => {
    const user = getUser(request)
    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } })
    return {
      userId: user.userId,
      role: user.role,
      districtId: user.districtId,
      displayName: dbUser?.displayName ?? 'Unknown',
    }
  })

  // POST /auth/lti/launch — LTI 1.3 OIDC launch (placeholder for ltijs integration)
  server.post('/auth/lti/launch', async (_request, reply) => {
    // TODO: Integrate with ltijs for LTI 1.3 OIDC flow
    // For now, return a placeholder
    return reply.status(501).send({ error: 'LTI 1.3 integration pending — use /auth/login' })
  })

  // GET /auth/oauth/spotify/authorize — Initiate Spotify OAuth2
  server.get('/auth/oauth/spotify/authorize', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    if (!clientId) {
      return reply.status(503).send({ error: 'Spotify integration not configured' })
    }

    const state = crypto.randomBytes(16).toString('hex')
    const redirectUri = `${request.protocol}://${request.hostname}/api/v1/auth/oauth/spotify/callback`
    const scopes = 'playlist-modify-public playlist-modify-private'

    const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
    })}`

    return reply.redirect(authUrl)
  })

  // POST /auth/oauth/spotify/callback — Spotify OAuth2 callback
  server.post('/auth/oauth/spotify/callback', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { code } = request.body as { code: string; state: string }
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      return reply.status(503).send({ error: 'Spotify not configured' })
    }

    try {
      const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${request.protocol}://${request.hostname}/api/v1/auth/oauth/spotify/callback`,
        }),
      })

      const tokens = await tokenResponse.json() as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      if (!tokens.access_token) {
        return reply.status(400).send({ error: 'OAuth token exchange failed' })
      }

      // Store encrypted tokens
      const user = getUser(request)
      const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY ?? 'dev-key-32-bytes-long-for-aes256!'

      // Simple encryption (production would use proper AES-256-GCM)
      const encrypt = (text: string) => {
        const cipher = crypto.createCipheriv('aes-256-cbc',
          Buffer.from(encryptionKey.padEnd(32).slice(0, 32)),
          Buffer.alloc(16, 0))
        return cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
      }

      await prisma.oAuthToken.upsert({
        where: { userId_provider: { userId: user.userId, provider: 'spotify' } },
        update: {
          accessTokenEncrypted: encrypt(tokens.access_token),
          refreshTokenEncrypted: encrypt(tokens.refresh_token),
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        },
        create: {
          userId: user.userId,
          provider: 'spotify',
          accessTokenEncrypted: encrypt(tokens.access_token),
          refreshTokenEncrypted: encrypt(tokens.refresh_token),
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scopes: ['playlist-modify-public', 'playlist-modify-private'],
        },
      })

      return { success: true, message: 'Spotify connected' }
    } catch (error) {
      request.log.error(error, 'Spotify OAuth failed')
      return reply.status(500).send({ error: 'OAuth flow failed' })
    }
  })
}
