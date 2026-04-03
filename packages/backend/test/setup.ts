import { beforeAll, afterAll } from 'vitest'

// Set test environment
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge@localhost:5435/chatbridge'
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380'
process.env.JWT_SECRET_KEY = 'test-secret-key'
process.env.PORT = '0' // Random port for tests
