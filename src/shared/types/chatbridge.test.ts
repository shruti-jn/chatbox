/**
 * Shared schema validation tests for ChatBridge types
 *
 * Tests: app-card content part schema, integration with Chatbox session types
 */

import { describe, it, expect } from 'vitest'
import { AppCardPartSchema, ContentPartSchema } from '../../../packages/shared/src/schemas/messages'
import { MessageAppCardPartSchema, MessageContentPartSchema } from './session'

describe('AppCardPartSchema (@chatbridge/shared)', () => {
  it('validates a correct app-card part', () => {
    const valid = {
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'active',
    }

    const result = AppCardPartSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('validates app-card with optional fields', () => {
    const valid = {
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Weather Dashboard',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'loading',
      url: 'https://apps.chatbridge.example.com/weather',
      height: 400,
      summary: 'Current weather in LA',
      stateSnapshot: { temperature: 72 },
    }

    const result = AppCardPartSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects app-card with invalid status', () => {
    const invalid = {
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'invalid_status',
    }

    const result = AppCardPartSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('rejects app-card with missing required fields', () => {
    const invalid = {
      type: 'app-card',
      appName: 'Chess',
      // Missing appId, instanceId, status
    }

    const result = AppCardPartSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('rejects app-card with invalid UUID for appId', () => {
    const invalid = {
      type: 'app-card',
      appId: 'not-a-uuid',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'active',
    }

    const result = AppCardPartSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})

describe('ContentPartSchema discriminated union (@chatbridge/shared)', () => {
  it('accepts text parts', () => {
    const result = ContentPartSchema.safeParse({ type: 'text', text: 'Hello' })
    expect(result.success).toBe(true)
  })

  it('accepts tool-call parts', () => {
    const result = ContentPartSchema.safeParse({
      type: 'tool-call',
      state: 'call',
      toolCallId: 'tc1',
      toolName: 'search',
    })
    expect(result.success).toBe(true)
  })

  it('accepts app-card parts', () => {
    const result = ContentPartSchema.safeParse({
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'active',
    })
    expect(result.success).toBe(true)
  })
})

describe('MessageAppCardPartSchema (Chatbox session extension)', () => {
  it('validates an app-card part in Chatbox format', () => {
    const valid = {
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'active',
    }

    const result = MessageAppCardPartSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('is included in the Chatbox MessageContentPart discriminated union', () => {
    const appCard = {
      type: 'app-card',
      appId: '550e8400-e29b-41d4-a716-446655440000',
      appName: 'Chess',
      instanceId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'active',
    }

    const result = MessageContentPartSchema.safeParse(appCard)
    expect(result.success).toBe(true)
  })

  it('coexists with existing Chatbox content part types', () => {
    const textPart = { type: 'text', text: 'Hello' }
    const imagePart = { type: 'image', storageKey: 'key123' }
    const infoPart = { type: 'info', text: 'Info message' }
    const reasoningPart = { type: 'reasoning', text: 'Thinking...' }

    expect(MessageContentPartSchema.safeParse(textPart).success).toBe(true)
    expect(MessageContentPartSchema.safeParse(imagePart).success).toBe(true)
    expect(MessageContentPartSchema.safeParse(infoPart).success).toBe(true)
    expect(MessageContentPartSchema.safeParse(reasoningPart).success).toBe(true)
  })
})
