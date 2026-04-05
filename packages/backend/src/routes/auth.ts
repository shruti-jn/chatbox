import type { FastifyInstance } from 'fastify'
import { signJWT, authenticate, requireRole, getUser } from '../middleware/auth.js'
import { requireCoppaConsent } from '../middleware/coppa.js'
import { prisma, ownerPrisma, withTenantContext } from '../middleware/rls.js'
import { LoginRequestSchema } from '@chatbridge/shared'
import crypto from 'crypto'
import * as jose from 'jose'

// ── LTI 1.3 Configuration ──────────────────────────────────────────
// In production these come from DB per-platform. For now, env-based.
interface LTIPlatformConfig {
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  clientId: string
}

function getLTIPlatformConfig(issuer: string): LTIPlatformConfig | null {
  // Known LTI platforms — extend via DB in production
  const platforms: Record<string, LTIPlatformConfig> = {
    'https://canvas.instructure.com': {
      authorizationEndpoint: 'https://canvas.instructure.com/api/lti/authorize_redirect',
      tokenEndpoint: 'https://canvas.instructure.com/login/oauth2/token',
      jwksUri: 'https://canvas.instructure.com/api/lti/security/jwks',
      clientId: process.env.LTI_CLIENT_ID ?? '',
    },
  }
  return platforms[issuer] ?? null
}

// ── Spotify PKCE helpers ────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

// ── AES-256-GCM encrypt/decrypt ─────────────────────────────────────

function getEncryptionKey(): Buffer {
  const key = process.env.OAUTH_ENCRYPTION_KEY ?? 'dev-key-32-bytes-long-for-aes256!'
  return Buffer.from(key.padEnd(32).slice(0, 32))
}

function encryptAES256GCM(plaintext: string): string {
  const iv = crypto.randomBytes(12) // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptAES256GCM(packed: string): string {
  const [ivHex, authTagHex, ciphertextHex] = packed.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

// ── LTI JWT Signature Verification ──────────────────────────────────

// Cache JWKS remotes per issuer to avoid re-fetching on every request
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jwksCache = new Map<string, any>()

/**
 * Verify an LTI id_token JWT signature against the platform's JWKS endpoint.
 * Returns the verified JWT payload, or throws on invalid/tampered tokens.
 */
export async function verifyLtiToken(
  idToken: string,
  platform: LTIPlatformConfig,
  expectedNonce?: string,
): Promise<Record<string, unknown>> {
  let jwks = jwksCache.get(platform.jwksUri)
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(platform.jwksUri)) as any
    jwksCache.set(platform.jwksUri, jwks!)
  }

  const { payload } = await jose.jwtVerify(idToken, jwks!, {
    audience: platform.clientId,
  })

  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error('LTI nonce mismatch')
  }

  return payload as Record<string, unknown>
}

// ── In-memory state stores (production: Redis) ──────────────────────
// Spotify OAuth state → { userId, codeVerifier, createdAt }
const spotifyStateStore = new Map<string, { userId: string; codeVerifier: string; createdAt: number }>()
// LTI OIDC state → { nonce, createdAt }
const ltiStateStore = new Map<string, { nonce: string; createdAt: number }>()

// Clean up expired entries every 5 minutes
const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes
function pruneExpired(store: Map<string, { createdAt: number }>) {
  const now = Date.now()
  for (const [key, val] of store) {
    if (now - val.createdAt > STATE_TTL_MS) store.delete(key)
  }
}
setInterval(() => {
  pruneExpired(spotifyStateStore as any)
  pruneExpired(ltiStateStore as any)
}, 5 * 60 * 1000).unref()

export async function authRoutes(server: FastifyInstance) {
  // ================================================================
  // POST /auth/login — Dev/test-only fallback (F4)
  // ================================================================
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
    const env = process.env.NODE_ENV ?? 'development'
    if (env === 'production') {
      return reply.status(403).send({
        error: 'Login endpoint is only available in development/test environments. Use LTI SSO in production.',
      })
    }

    const { email, password } = request.body as { email: string; password: string }

    // Find user by email hash (we never store plaintext emails)
    // ownerPrisma bypasses RLS — necessary here because we don't have districtId yet
    const emailHash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')
    const user = await ownerPrisma.user.findFirst({
      where: { emailHash },
    })

    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const token = signJWT({
      userId: user.id,
      role: user.role,
      districtId: user.districtId,
      schoolId: user.schoolId ?? undefined,
      gradeBand: user.gradeBand ?? undefined,
    })

    return { token, role: user.role, displayName: user.displayName }
  })

  // ================================================================
  // GET /auth/me — Current user info
  // ================================================================
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
    const dbUser = await withTenantContext(user.districtId, async (tx) => {
      return tx.user.findUnique({ where: { id: user.userId } })
    })
    return {
      userId: user.userId,
      role: user.role,
      districtId: user.districtId,
      displayName: dbUser?.displayName ?? 'Unknown',
    }
  })

  // ================================================================
  // F1: LTI 1.3 OIDC Initiation
  // GET /auth/lti/oidc/initiate — Step 1 of LTI 1.3 launch
  // ================================================================
  server.get('/auth/lti/oidc/initiate', {
    schema: {
      querystring: {
        type: 'object',
        required: ['iss', 'login_hint', 'target_link_uri'],
        properties: {
          iss: { type: 'string' },
          login_hint: { type: 'string' },
          target_link_uri: { type: 'string' },
          lti_message_hint: { type: 'string' },
          client_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { iss, login_hint, target_link_uri, lti_message_hint } = request.query as {
      iss: string
      login_hint: string
      target_link_uri: string
      lti_message_hint?: string
    }

    const platform = getLTIPlatformConfig(iss)
    if (!platform) {
      return reply.status(400).send({ error: `Unknown LTI platform issuer: ${iss}` })
    }

    // Generate state and nonce for CSRF + replay protection
    const state = crypto.randomBytes(32).toString('hex')
    const nonce = crypto.randomBytes(32).toString('hex')

    ltiStateStore.set(state, { nonce, createdAt: Date.now() })

    // Build the OIDC auth request
    const params = new URLSearchParams({
      scope: 'openid',
      response_type: 'id_token',
      client_id: platform.clientId,
      redirect_uri: target_link_uri,
      login_hint,
      state,
      response_mode: 'form_post',
      nonce,
      prompt: 'none',
    })

    if (lti_message_hint) {
      params.set('lti_message_hint', lti_message_hint)
    }

    const authUrl = `${platform.authorizationEndpoint}?${params.toString()}`
    return reply.redirect(authUrl)
  })

  // ================================================================
  // F1: LTI 1.3 Launch callback
  // POST /auth/lti/launch — Step 2: validate id_token, issue JWT
  // ================================================================
  server.post('/auth/lti/launch', {
    schema: {
      body: {
        type: 'object',
        required: ['id_token', 'state'],
        properties: {
          id_token: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id_token, state } = request.body as { id_token: string; state: string }

    // Validate state (CSRF protection)
    const storedState = ltiStateStore.get(state)
    if (!storedState) {
      return reply.status(400).send({ error: 'Invalid or expired LTI state parameter' })
    }
    ltiStateStore.delete(state)

    // Check state age
    if (Date.now() - storedState.createdAt > STATE_TTL_MS) {
      return reply.status(400).send({ error: 'LTI state expired' })
    }

    // Step 1: Decode the JWT (unverified) to extract the issuer for platform lookup
    let rawClaims: Record<string, any>
    try {
      const parts = id_token.split('.')
      if (parts.length !== 3) {
        return reply.status(400).send({ error: 'Invalid LTI id_token format' })
      }
      rawClaims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    } catch {
      return reply.status(400).send({ error: 'Failed to decode LTI id_token' })
    }

    // Step 2: Look up the platform config from the issuer claim
    const issuer = rawClaims.iss as string | undefined
    if (!issuer) {
      return reply.status(400).send({ error: 'Missing iss claim in LTI id_token' })
    }

    const platform = getLTIPlatformConfig(issuer)
    if (!platform) {
      return reply.status(400).send({ error: `Unknown LTI platform issuer: ${issuer}` })
    }

    // Step 3: Verify the JWT signature against the platform's JWKS endpoint
    let claims: Record<string, any>
    try {
      claims = await verifyLtiToken(id_token, platform, storedState.nonce)
    } catch (err: any) {
      const message = err?.message ?? 'unknown'
      if (message.includes('nonce')) {
        return reply.status(400).send({ error: 'LTI nonce mismatch — possible replay attack' })
      }
      request.log.warn({ err: message }, 'LTI id_token verification failed')
      return reply.status(401).send({ error: 'LTI id_token signature verification failed' })
    }

    // Extract LTI claims
    const sub = claims.sub as string | undefined
    const iss = claims.iss as string | undefined
    const ltiClaims = claims['https://purl.imsglobal.org/spec/lti/claim/roles'] as string[] | undefined
    const name = (claims.name ?? claims.given_name ?? 'LTI User') as string

    if (!sub || !iss) {
      return reply.status(400).send({ error: 'Missing required LTI claims (sub, iss)' })
    }

    // Determine role from LTI roles
    const isInstructor = ltiClaims?.some(r =>
      r.includes('Instructor') || r.includes('TeachingAssistant'),
    )
    const isAdmin = ltiClaims?.some(r => r.includes('Administrator'))
    const role = isAdmin ? 'district_admin' : isInstructor ? 'teacher' : 'student'

    // Find or create user by external ID
    // ownerPrisma bypasses RLS — necessary here because we don't know the district yet
    const externalId = `${iss}::${sub}`
    let user = await ownerPrisma.user.findUnique({ where: { externalId } })

    if (!user) {
      // Auto-provision. In production, district mapping comes from platform registration.
      const defaultDistrict = await ownerPrisma.district.findFirst()
      if (!defaultDistrict) {
        return reply.status(500).send({ error: 'No district configured for LTI provisioning' })
      }

      user = await ownerPrisma.user.create({
        data: {
          externalId,
          districtId: defaultDistrict.id,
          role: role as any,
          displayName: typeof name === 'string' ? name : 'LTI User',
        },
      })
    }

    const token = signJWT({
      userId: user.id,
      role: user.role,
      districtId: user.districtId,
      schoolId: user.schoolId ?? undefined,
      gradeBand: user.gradeBand ?? undefined,
    })

    return { token, role: user.role, displayName: user.displayName }
  })

  // ================================================================
  // F2: Spotify OAuth — returns 200 JSON with URL (not redirect)
  // ================================================================
  server.get('/auth/oauth/spotify/authorize', {
    preHandler: [authenticate, requireCoppaConsent],
  }, async (request, reply) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    if (!clientId) {
      return reply.status(503).send({ error: 'Spotify integration not configured' })
    }

    const user = getUser(request)
    const state = crypto.randomBytes(16).toString('hex')
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)

    // Store state → { userId, codeVerifier } for callback validation
    spotifyStateStore.set(state, { userId: user.userId, codeVerifier, createdAt: Date.now() })

    const redirectUri = `${request.protocol}://${request.hostname}/api/v1/auth/oauth/spotify/callback`
    const scopes = 'playlist-modify-public playlist-modify-private user-read-private'

    const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })}`

    // Return 200 JSON for window.open() — NOT a 302 redirect
    return reply.status(200).send({ url: authUrl, state })
  })

  // ================================================================
  // F2: Spotify OAuth callback — state validation + AES-256-GCM
  // ================================================================
  server.post('/auth/oauth/spotify/callback', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { code, state } = request.body as { code: string; state: string }
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      return reply.status(503).send({ error: 'Spotify not configured' })
    }

    // Validate state (CSRF protection)
    const storedState = spotifyStateStore.get(state)
    if (!storedState) {
      return reply.status(400).send({ error: 'Invalid or expired OAuth state — possible CSRF' })
    }
    spotifyStateStore.delete(state)

    // Check state age
    if (Date.now() - storedState.createdAt > STATE_TTL_MS) {
      return reply.status(400).send({ error: 'OAuth state expired' })
    }

    // Verify the state belongs to the authenticated user
    const user = getUser(request)
    if (storedState.userId !== user.userId) {
      return reply.status(400).send({ error: 'OAuth state user mismatch' })
    }

    try {
      const redirectUri = `${request.protocol}://${request.hostname}/api/v1/auth/oauth/spotify/callback`

      const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: storedState.codeVerifier,
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

      // Store encrypted tokens using AES-256-GCM within tenant context for RLS
      await withTenantContext(user.districtId, async (tx) => {
        return tx.oAuthToken.upsert({
          where: { userId_provider: { userId: user.userId, provider: 'spotify' } },
          update: {
            accessTokenEncrypted: encryptAES256GCM(tokens.access_token),
            refreshTokenEncrypted: encryptAES256GCM(tokens.refresh_token),
            expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          },
          create: {
            userId: user.userId,
            provider: 'spotify',
            accessTokenEncrypted: encryptAES256GCM(tokens.access_token),
            refreshTokenEncrypted: encryptAES256GCM(tokens.refresh_token),
            expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
            scopes: ['playlist-modify-public', 'playlist-modify-private'],
          },
        })
      })

      return { success: true, message: 'Spotify connected' }
    } catch (error) {
      request.log.error(error, 'Spotify OAuth failed')
      return reply.status(500).send({ error: 'OAuth flow failed' })
    }
  })
  // ================================================================
  // F5: Spotify token refresh — POST /auth/oauth/spotify/refresh
  // ================================================================
  server.post('/auth/oauth/spotify/refresh', {
    preHandler: [authenticate],
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            expires_in: { type: 'number' },
          },
        },
        400: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
        401: {
          type: 'object',
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      return reply.status(503).send({ error: 'Spotify integration not configured' })
    }

    const user = getUser(request)

    // Look up the user's stored Spotify token using withTenantContext to satisfy RLS
    const oauthToken = await withTenantContext(user.districtId, async (tx) => {
      return tx.oAuthToken.findUnique({
        where: { userId_provider: { userId: user.userId, provider: 'spotify' } },
      })
    })

    if (!oauthToken) {
      return reply.status(400).send({ error: 'No Spotify connection found. Please connect Spotify first.' })
    }

    // Decrypt the stored refresh token
    let refreshToken: string
    try {
      refreshToken = decryptAES256GCM(oauthToken.refreshTokenEncrypted)
    } catch {
      return reply.status(400).send({ error: 'Failed to decrypt stored token. Please reconnect Spotify.' })
    }

    try {
      // Call Spotify's token endpoint with grant_type=refresh_token
      const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      })

      const tokens = await tokenResponse.json() as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        error?: string
        error_description?: string
      }

      // Handle Spotify rejection (revoked token, invalid grant, etc.)
      if (!tokenResponse.ok || !tokens.access_token) {
        request.log.warn({ spotifyError: tokens.error }, 'Spotify token refresh rejected')
        return reply.status(401).send({
          error: 'SPOTIFY_REAUTH_REQUIRED',
          message: 'Spotify refresh token is invalid or revoked. Please reconnect Spotify.',
        })
      }

      // Encrypt and store the new tokens
      const updateData: {
        accessTokenEncrypted: string
        expiresAt: Date
        refreshTokenEncrypted?: string
      } = {
        accessTokenEncrypted: encryptAES256GCM(tokens.access_token),
        expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      }

      // Spotify may issue a new refresh token — store it if provided
      if (tokens.refresh_token) {
        updateData.refreshTokenEncrypted = encryptAES256GCM(tokens.refresh_token)
      }

      await withTenantContext(user.districtId, async (tx) => {
        return tx.oAuthToken.update({
          where: { userId_provider: { userId: user.userId, provider: 'spotify' } },
          data: updateData,
        })
      })

      return {
        access_token: tokens.access_token,
        expires_in: tokens.expires_in ?? 3600,
      }
    } catch (error) {
      request.log.error(error, 'Spotify token refresh failed')
      return reply.status(502).send({ error: 'Failed to reach Spotify. Please try again.' })
    }
  })
}

// Export for testing
export { encryptAES256GCM, decryptAES256GCM, spotifyStateStore, ltiStateStore, getLTIPlatformConfig }
