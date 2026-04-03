/**
 * Manual test: Send a trace to Langfuse and verify it arrives
 * Run: npx tsx test/langfuse-trace-test.ts
 */
import { initLangfuse, createTrace, createGeneration, endGeneration, flushTraces } from '../src/observability/langfuse.js'

async function main() {
  initLangfuse()

  console.log('Creating trace...')
  const trace = createTrace('manual_test_trace', {
    userId: 'test-user-001',
    sessionId: 'test-session-001',
    conversationId: 'test-conv-001',
    districtId: 'test-district-001',
  })

  if (!trace) {
    console.error('Failed to create trace — Langfuse not configured')
    process.exit(1)
  }

  console.log('Creating generation span...')
  const gen = createGeneration(trace, 'test_haiku_call', {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'What is 2+2?' }],
  })

  endGeneration(gen, {
    response: '2 + 2 = 4! Great question.',
    tokenUsage: { input: 12, output: 20 },
  })

  console.log('Flushing to Langfuse...')
  await flushTraces()

  // Small delay to ensure flush completes
  await new Promise(r => setTimeout(r, 2000))

  console.log('Done! Check https://us.cloud.langfuse.com for traces.')
  console.log('Look for trace named "manual_test_trace"')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
