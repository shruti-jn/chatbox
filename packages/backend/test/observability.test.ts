import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the Langfuse constructor — Langfuse is an external paid service (acceptable mock).
// We test our wrapper logic (PII rejection, scrubbing, graceful degradation) directly.
const mockGeneration = vi.fn().mockReturnValue({ end: vi.fn() })
const mockSpan = vi.fn().mockReturnValue({ end: vi.fn() })
const mockTrace = vi.fn().mockReturnValue({
  generation: mockGeneration,
  span: mockSpan,
})
const mockFlushAsync = vi.fn().mockResolvedValue(undefined)

vi.mock('langfuse', () => ({
  Langfuse: vi.fn().mockImplementation(() => ({
    trace: mockTrace,
    flushAsync: mockFlushAsync,
    on: vi.fn(),
  })),
}))

// Import AFTER mocking
import {
  initLangfuse,
  createTrace,
  createGeneration,
  endGeneration,
  createSafetySpan,
  flushTraces,
  getLangfuse,
} from '../src/observability/langfuse.js'

describe('Observability: Langfuse integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the module-level langfuse instance by re-initializing
  })

  afterEach(() => {
    // Clean up env vars set during tests
    delete process.env.LANGFUSE_PUBLIC_KEY
    delete process.env.LANGFUSE_SECRET_KEY
    delete process.env.LANGFUSE_BASE_URL
  })

  describe('Graceful degradation (non-blocking)', () => {
    it('createTrace returns null when Langfuse is not configured', async () => {
      // Ensure no credentials are set
      delete process.env.LANGFUSE_PUBLIC_KEY
      delete process.env.LANGFUSE_SECRET_KEY

      // Re-import to get fresh module state — use dynamic import with cache bust
      // Instead, we rely on the module state: without calling initLangfuse with
      // valid creds, the internal langfuse instance is null.
      const result = createTrace('test-trace', {
        userId: 'user-abc-123',
        sessionId: 'session-001',
      })

      expect(result).toBeNull()
    })

    it('createGeneration returns null when trace is null', () => {
      const result = createGeneration(null, 'test-gen', {
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'Hello' }],
      })

      expect(result).toBeNull()
    })

    it('createSafetySpan returns null when trace is null', () => {
      const result = createSafetySpan(null, 'test input')
      expect(result).toBeNull()
    })

    it('endGeneration does not throw when generation is null', () => {
      expect(() => {
        endGeneration(null, { response: 'test' })
      }).not.toThrow()
    })

    it('flushTraces does not throw when Langfuse is not configured', async () => {
      await expect(flushTraces()).resolves.not.toThrow()
    })
  })

  describe('Trace creation with valid pseudonymous userId', () => {
    beforeEach(() => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key'
      process.env.LANGFUSE_SECRET_KEY = 'sk-test-key'
      initLangfuse()
    })

    it('creates a trace with a pseudonymous UUID userId', () => {
      const trace = createTrace('conversation_turn', {
        userId: 'usr-550e8400-e29b-41d4-a716-446655440000',
        sessionId: 'sess-001',
        conversationId: 'conv-001',
        classroomId: 'class-001',
        districtId: 'dist-001',
      })

      expect(trace).not.toBeNull()
      expect(mockTrace).toHaveBeenCalledWith({
        name: 'conversation_turn',
        userId: 'usr-550e8400-e29b-41d4-a716-446655440000',
        sessionId: 'sess-001',
        metadata: {
          conversationId: 'conv-001',
          classroomId: 'class-001',
          districtId: 'dist-001',
        },
      })
    })

    it('creates a trace with simple alphanumeric userId', () => {
      const trace = createTrace('test_trace', {
        userId: 'student-42',
        sessionId: 'sess-002',
      })

      expect(trace).not.toBeNull()
      expect(mockTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'student-42',
        }),
      )
    })
  })

  describe('PII rejection in userId', () => {
    beforeEach(() => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key'
      process.env.LANGFUSE_SECRET_KEY = 'sk-test-key'
      initLangfuse()
    })

    it('rejects userId containing an email address and returns null', () => {
      const trace = createTrace('test_trace', {
        userId: 'student@school.edu',
        sessionId: 'sess-001',
      })

      expect(trace).toBeNull()
      // The Langfuse trace method should NOT have been called
      expect(mockTrace).not.toHaveBeenCalled()
    })

    it('rejects userId with embedded email pattern', () => {
      const trace = createTrace('test_trace', {
        userId: 'john.doe@example.com',
        sessionId: 'sess-001',
      })

      expect(trace).toBeNull()
      expect(mockTrace).not.toHaveBeenCalled()
    })
  })

  describe('PII scrubbing in generation input', () => {
    beforeEach(() => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key'
      process.env.LANGFUSE_SECRET_KEY = 'sk-test-key'
      initLangfuse()
    })

    it('redacts phone numbers from message content', () => {
      const trace = createTrace('test_trace', {
        userId: 'user-001',
        sessionId: 'sess-001',
      })

      createGeneration(trace, 'llm_call', {
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'user', content: 'Call me at 555-123-4567 for help' },
        ],
      })

      expect(mockGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [
            expect.objectContaining({
              content: expect.not.stringContaining('555-123-4567'),
            }),
          ],
        }),
      )

      // Verify the redaction placeholder is present
      const callArgs = mockGeneration.mock.calls[0][0]
      expect(callArgs.input[0].content).toContain('[REDACTED]')
    })

    it('redacts SSN patterns from message content', () => {
      const trace = createTrace('test_trace', {
        userId: 'user-002',
        sessionId: 'sess-001',
      })

      createGeneration(trace, 'llm_call', {
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'user', content: 'My SSN is 123-45-6789' },
        ],
      })

      const callArgs = mockGeneration.mock.calls[0][0]
      expect(callArgs.input[0].content).not.toContain('123-45-6789')
      expect(callArgs.input[0].content).toContain('[REDACTED]')
    })

    it('redacts email addresses from message content', () => {
      const trace = createTrace('test_trace', {
        userId: 'user-003',
        sessionId: 'sess-001',
      })

      createGeneration(trace, 'llm_call', {
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'user', content: 'Email me at student@school.edu' },
        ],
      })

      const callArgs = mockGeneration.mock.calls[0][0]
      expect(callArgs.input[0].content).not.toContain('student@school.edu')
      expect(callArgs.input[0].content).toContain('[REDACTED]')
    })

    it('handles plain string messages in scrubbing', () => {
      const trace = createTrace('test_trace', {
        userId: 'user-004',
        sessionId: 'sess-001',
      })

      createGeneration(trace, 'llm_call', {
        model: 'claude-haiku-4-5-20251001',
        messages: ['My phone is 555-999-1234'],
      })

      const callArgs = mockGeneration.mock.calls[0][0]
      expect(callArgs.input[0]).not.toContain('555-999-1234')
      expect(callArgs.input[0]).toContain('[REDACTED]')
    })

    it('stores the scrubbed system prompt in metadata when provided', () => {
      const trace = createTrace('test_trace', {
        userId: 'user-005',
        sessionId: 'sess-001',
      })

      createGeneration(trace, 'llm_call', {
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'Analyze this board' }],
        systemPrompt: 'FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR student@school.edu',
      })

      const callArgs = mockGeneration.mock.calls[0][0]
      expect(callArgs.metadata.systemPrompt).toContain('FEN:')
      expect(callArgs.metadata.systemPrompt).toContain('[REDACTED]')
      expect(callArgs.metadata.systemPrompt).not.toContain('student@school.edu')
    })
  })

  describe('Generation span creation', () => {
    beforeEach(() => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key'
      process.env.LANGFUSE_SECRET_KEY = 'sk-test-key'
      initLangfuse()
    })

    it('creates a generation span with model and tool metadata', () => {
      const trace = createTrace('test_trace', {
        userId: 'user-001',
        sessionId: 'sess-001',
      })

      const gen = createGeneration(trace, 'haiku_call', {
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
        tools: [{ name: 'calculator' }, { name: 'search' }],
      })

      expect(gen).not.toBeNull()
      expect(mockGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'haiku_call',
          model: 'claude-haiku-4-5-20251001',
          metadata: { toolCount: 2 },
        }),
      )
    })

    it('endGeneration records output and token usage', () => {
      const trace = createTrace('test_trace', {
        userId: 'user-001',
        sessionId: 'sess-001',
      })

      const gen = createGeneration(trace, 'llm_call', {
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'Hello' }],
      })

      const mockEnd = gen!.end as ReturnType<typeof vi.fn>

      endGeneration(gen, {
        response: 'Hello! How can I help?',
        tokenUsage: { input: 10, output: 15 },
        toolCalls: [{ name: 'search', args: { q: 'math' } }],
        guardrailResult: { severity: 'safe', category: 'safe' },
      })

      expect(mockEnd).toHaveBeenCalledWith({
        output: 'Hello! How can I help?',
        usage: { input: 10, output: 15 },
        metadata: {
          toolCalls: [{ name: 'search', args: { q: 'math' } }],
          guardrailResult: { severity: 'safe', category: 'safe' },
        },
      })
    })
  })
})
