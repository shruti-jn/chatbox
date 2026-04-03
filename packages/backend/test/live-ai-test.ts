/**
 * Live AI test: Run safety pipeline + AI generation with Langfuse tracing
 */
import { initLangfuse, createTrace, createGeneration, createSafetySpan, endGeneration, flushTraces } from '../src/observability/langfuse.js'
import { runSafetyPipeline } from '../src/safety/pipeline.js'
import { generateResponse } from '../src/ai/service.js'

async function main() {
  initLangfuse()

  const testMessages = [
    'What is photosynthesis?',
    "Let's play chess!",
    'My phone number is 555-123-4567',
  ]

  for (const msg of testMessages) {
    console.log(`\n=== Testing: "${msg}" ===`)

    const trace = createTrace('live_ai_test', {
      userId: 'test-student-001',
      sessionId: 'test-session',
      conversationId: 'test-conv',
      districtId: 'test-district',
    })

    // Safety pipeline
    const safetySpan = createSafetySpan(trace, msg)
    const safety = await runSafetyPipeline(msg)
    if (safetySpan) {
      try {
        safetySpan.end({
          output: { severity: safety.severity, category: safety.category, processingTimeMs: safety.processingTimeMs },
        })
      } catch {}
    }
    console.log(`  Safety: ${safety.severity} (${safety.category}) [${safety.processingTimeMs}ms]`)

    if (safety.severity === 'blocked' || safety.severity === 'critical') {
      console.log(`  Blocked/Critical — skipping AI`)
      continue
    }

    // AI generation
    const gen = createGeneration(trace, 'ai_chat_response', {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: safety.redactedMessage }],
    })

    try {
      const result = await generateResponse({
        messages: [{ role: 'user', content: safety.redactedMessage }],
        classroomConfig: { mode: 'direct' },
        gradeBand: 'g68',
        activeAppState: null,
        activeAppName: null,
        enabledToolSchemas: {},
        whisperGuidance: null,
        asyncGuidance: null,
      })

      let fullText = ''
      for await (const chunk of result.textStream) {
        fullText += chunk
      }

      endGeneration(gen, {
        response: fullText,
        guardrailResult: { severity: safety.severity, category: safety.category },
      })

      console.log(`  AI Response (${fullText.length} chars): ${fullText.slice(0, 100)}...`)
    } catch (err) {
      console.error(`  AI Error: ${err instanceof Error ? err.message : err}`)
      endGeneration(gen, { response: 'Error' })
    }
  }

  console.log('\nFlushing traces to Langfuse...')
  await flushTraces()
  await new Promise(r => setTimeout(r, 2000))
  console.log('Done! Check https://us.cloud.langfuse.com')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
