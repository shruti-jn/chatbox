import { describe, it, expect } from 'vitest'
import {
  CBPMessageSchema,
  CBPStateUpdateSchema,
  CBP_MAX_MESSAGE_SIZE,
} from '@chatbridge/shared'
import {
  AppRegistrationSchema,
  AppCardPartSchema,
  ContentPartSchema,
} from '@chatbridge/shared'
import {
  ClassroomCreateSchema,
  GradeBandSchema,
  AIConfigSchema,
} from '@chatbridge/shared'
import {
  JWTPayloadSchema,
  UserRoleSchema,
} from '@chatbridge/shared'

describe('CBP Protocol Schemas', () => {
  it('validates valid JSON-RPC 2.0 state_update message', () => {
    const msg = {
      jsonrpc: '2.0',
      method: 'state_update',
      params: {
        instance_id: '550e8400-e29b-41d4-a716-446655440000',
        state: { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
      },
    }
    const result = CBPStateUpdateSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  it('rejects message missing jsonrpc field', () => {
    const msg = { method: 'state_update', params: {} }
    const result = CBPMessageSchema.safeParse(msg)
    expect(result.success).toBe(false)
  })

  it('rejects message with invalid method', () => {
    const msg = { jsonrpc: '2.0', method: 'invalid_method', params: {} }
    const result = CBPMessageSchema.safeParse(msg)
    expect(result.success).toBe(false)
  })

  it('enforces 64KB max message size constant', () => {
    expect(CBP_MAX_MESSAGE_SIZE).toBe(65536)
  })
})

describe('App Schemas', () => {
  it('validates valid app registration', () => {
    const reg = {
      name: 'Chess',
      description: 'Interactive chess game',
      toolDefinitions: [{
        name: 'start_game',
        description: 'Start a new chess game',
        inputSchema: { type: 'object', properties: {} },
      }],
      uiManifest: { url: 'https://chess.chatbridge.app', width: 500, height: 500 },
      permissions: {},
      complianceMetadata: {},
      version: '1.0.0',
    }
    const result = AppRegistrationSchema.safeParse(reg)
    expect(result.success).toBe(true)
  })

  it('rejects registration with empty name', () => {
    const reg = {
      name: '',
      description: 'Test',
      toolDefinitions: [{ name: 't', description: 'd', inputSchema: {} }],
      uiManifest: { url: 'https://example.com' },
      permissions: {},
      complianceMetadata: {},
      version: '1.0.0',
    }
    const result = AppRegistrationSchema.safeParse(reg)
    expect(result.success).toBe(false)
  })

  it('validates app-card content part', () => {
    const part = {
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'active',
      url: 'https://chess.chatbridge.app',
    }
    const result = AppCardPartSchema.safeParse(part)
    expect(result.success).toBe(true)
  })

  it('discriminates content parts correctly', () => {
    const textPart = { type: 'text', text: 'Hello' }
    const appPart = {
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'loading',
    }
    expect(ContentPartSchema.safeParse(textPart).success).toBe(true)
    expect(ContentPartSchema.safeParse(appPart).success).toBe(true)
    expect(ContentPartSchema.safeParse({ type: 'invalid' }).success).toBe(false)
  })
})

describe('Classroom Schemas', () => {
  it('validates all grade bands', () => {
    for (const band of ['k2', 'g35', 'g68', 'g912']) {
      expect(GradeBandSchema.safeParse(band).success).toBe(true)
    }
    expect(GradeBandSchema.safeParse('invalid').success).toBe(false)
  })

  it('validates classroom creation', () => {
    const create = { name: 'Math 6th Grade', gradeBand: 'g68' }
    expect(ClassroomCreateSchema.safeParse(create).success).toBe(true)
  })

  it('validates AI config with defaults', () => {
    const config = {}
    const result = AIConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mode).toBe('socratic')
    }
  })
})

describe('Auth Schemas', () => {
  it('validates user roles', () => {
    for (const role of ['student', 'teacher', 'district_admin']) {
      expect(UserRoleSchema.safeParse(role).success).toBe(true)
    }
    expect(UserRoleSchema.safeParse('superadmin').success).toBe(false)
  })

  it('validates JWT payload', () => {
    const payload = {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'teacher',
      districtId: '550e8400-e29b-41d4-a716-446655440001',
      iat: 1700000000,
      exp: 1700028800,
    }
    expect(JWTPayloadSchema.safeParse(payload).success).toBe(true)
  })
})
