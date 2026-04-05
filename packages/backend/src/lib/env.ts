/**
 * Startup environment validation (F4).
 * Throws if any required env var is missing.
 */

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET_KEY',
  'ANTHROPIC_API_KEY',
] as const

export function validateEnv(): void {
  const missing: string[] = []

  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) {
      missing.push(key)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'Server cannot start without these.'
    )
  }
}
