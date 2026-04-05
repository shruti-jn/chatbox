import { describe, expect, it } from 'vitest'
import { GOLDEN_DATASET } from '../src/eval/golden-dataset.js'
import { evaluateScenario, formatEvalSummary, getEvalThresholds, runEvalHarness } from '../src/eval/harness.js'

describe('Golden Dataset', () => {
  it('loads 20 scenarios from the dataset file with sequential GD ids', () => {
    expect(GOLDEN_DATASET.length).toBeGreaterThanOrEqual(20)
    expect(GOLDEN_DATASET.map((s) => s.id)).toEqual([
      'GD-001', 'GD-002', 'GD-003', 'GD-004', 'GD-005',
      'GD-006', 'GD-007', 'GD-008', 'GD-009', 'GD-010',
      'GD-011', 'GD-012', 'GD-013', 'GD-014', 'GD-015',
      'GD-016', 'GD-017', 'GD-018', 'GD-019', 'GD-020',
    ])
  })

  it('covers chat_quality, routing_accuracy, and safety categories', () => {
    const categories = new Set(GOLDEN_DATASET.map((s) => s.category))
    expect(categories.has('chat_quality')).toBe(true)
    expect(categories.has('routing_accuracy')).toBe(true)
    expect(categories.has('safety')).toBe(true)
  })
})

describe('Eval Harness', () => {
  it('evaluates a scenario into 0-1 rubric scores', async () => {
    const result = await evaluateScenario(GOLDEN_DATASET[0], { mode: 'stub' })

    expect(result.scenario_id).toBe('GD-001')
    expect(result.scores.routing_accuracy).toBeGreaterThanOrEqual(0)
    expect(result.scores.routing_accuracy).toBeLessThanOrEqual(1)
    expect(result.pass === true || result.pass === false).toBe(true)
  })

  it('calculates safety precision and recall for a safety scenario', async () => {
    const result = await evaluateScenario(GOLDEN_DATASET[7], { mode: 'stub' })

    expect(result.scenario_id).toBe('GD-008')
    expect(result.scores.safety_precision).toBeGreaterThanOrEqual(0)
    expect(result.scores.safety_precision).toBeLessThanOrEqual(1)
    expect(result.scores.safety_recall).toBeGreaterThanOrEqual(0)
    expect(result.scores.safety_recall).toBeLessThanOrEqual(1)
  })

  it('runs the harness end-to-end with a stable output format', async () => {
    const summary = await runEvalHarness({ mode: 'stub' })

    expect(summary.total_scenarios).toBeGreaterThanOrEqual(20)
    expect(summary.results).toHaveLength(summary.total_scenarios)
    expect(summary.mode).toBe('stub')
    expect(summary.dimension_averages.chat_quality).toBeGreaterThanOrEqual(0)
    expect(summary.dimension_averages.chat_quality).toBeLessThanOrEqual(1)
    expect(summary.dimension_averages.routing_accuracy).toBeGreaterThanOrEqual(0)
    expect(summary.dimension_averages.routing_accuracy).toBeLessThanOrEqual(1)

    const rendered = formatEvalSummary(summary)
    expect(rendered).toContain('Eval harness mode: stub')
    expect(rendered).toContain('Dimension averages:')
  })

  it('uses configurable thresholds instead of hardcoded pass bars', () => {
    const thresholds = getEvalThresholds()
    expect(thresholds.chat_quality).toBeGreaterThan(0)
    expect(thresholds.chat_quality).toBeLessThanOrEqual(1)
    expect(thresholds.routing_accuracy).toBeGreaterThan(0)
    expect(thresholds.routing_accuracy).toBeLessThanOrEqual(1)
    expect(thresholds.safety_precision).toBeGreaterThan(0)
    expect(thresholds.safety_precision).toBeLessThanOrEqual(1)
    expect(thresholds.safety_recall).toBeGreaterThan(0)
    expect(thresholds.safety_recall).toBeLessThanOrEqual(1)
  })
})
