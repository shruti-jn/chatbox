import { describe, it, expect } from 'vitest'
import { runEvalHarness } from '../src/eval/harness.js'
import { GOLDEN_DATASET } from '../src/eval/golden-dataset.js'

describe('Golden Dataset', () => {
  it('has 20 scenarios', () => {
    expect(GOLDEN_DATASET).toHaveLength(20)
  })

  it('covers all required categories', () => {
    const categories = new Set(GOLDEN_DATASET.map(s => s.category))
    expect(categories.has('tool_routing')).toBe(true)
    expect(categories.has('safety_pii')).toBe(true)
    expect(categories.has('safety_injection')).toBe(true)
    expect(categories.has('safety_crisis')).toBe(true)
    expect(categories.has('safety_content')).toBe(true)
    expect(categories.has('state_analysis')).toBe(true)
    expect(categories.has('context_retention')).toBe(true)
    expect(categories.has('grade_adaptation')).toBe(true)
    expect(categories.has('data_isolation')).toBe(true)
    expect(categories.has('collaboration')).toBe(true)
  })

  it('every scenario has scoring dimensions', () => {
    for (const scenario of GOLDEN_DATASET) {
      expect(scenario.scoringDimensions.length).toBeGreaterThan(0)
    }
  })
})

describe('Eval Harness (non-AI scenarios)', () => {
  it('runs eval harness and produces summary', async () => {
    const summary = await runEvalHarness()

    expect(summary.totalScenarios).toBe(20)
    expect(summary.results).toHaveLength(20)
    expect(summary.passRate).toBeGreaterThanOrEqual(0)
    expect(summary.timestamp).toBeDefined()
    expect(summary.dimensionAverages).toBeDefined()

    // Safety scenarios should pass (they use regex, not AI)
    const safetyResults = summary.results.filter(r =>
      r.category.startsWith('safety_') && r.category !== 'safety_content'
    )
    for (const result of safetyResults) {
      expect(result.passed).toBe(true)
    }

    // Tool routing (keyword-based) should pass
    const routingResults = summary.results.filter(r => r.category === 'tool_routing')
    const routingPassed = routingResults.filter(r => r.passed).length
    expect(routingPassed).toBeGreaterThanOrEqual(3) // At least 3 of 4

    // Print summary
    console.log(`\n=== EVAL SUMMARY ===`)
    console.log(`Pass rate: ${summary.passRate}%`)
    console.log(`Passed: ${summary.passed}/${summary.totalScenarios}`)
    console.log(`\nDimension averages:`)
    for (const [dim, avg] of Object.entries(summary.dimensionAverages)) {
      console.log(`  ${dim}: ${avg}`)
    }
    console.log(`\nFailed scenarios:`)
    for (const r of summary.results.filter(r => !r.passed)) {
      console.log(`  #${r.scenarioId} (${r.category}): ${r.details}`)
    }
  })
})
