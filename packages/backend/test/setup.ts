// Must be set before any imports that trigger rls.ts module loading
process.env.ALLOW_AUDIT_CLEANUP = '1' // Allow test afterAll to delete audit records

import { beforeAll, afterAll } from 'vitest'

// Set test environment
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge'
process.env.DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? 'postgresql://chatbridge_app:chatbridge_app@localhost:5433/chatbridge'
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380'
process.env.JWT_SECRET_KEY = 'test-secret-key'
process.env.PORT = '0' // Random port for tests
