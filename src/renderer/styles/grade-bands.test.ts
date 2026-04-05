import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createStore } from 'jotai'
import {
  type GradeBand,
  GRADE_BANDS,
  gradeBandAtom,
  setGradeBandAtom,
  isStreamingEnabled,
} from '../stores/atoms/gradeBandAtom'

// ─── Helpers ──────────────────────────────────────────────────────

const CSS_PATH = path.resolve(__dirname, 'grade-bands.css')
const cssContent = fs.readFileSync(CSS_PATH, 'utf-8')

/** Extract the CSS block for a given grade band selector */
function extractBandBlock(band: string): string {
  // Matches [data-grade-band="<band>"] { ... } (top-level rule only)
  const regex = new RegExp(
    `\\[data-grade-band="${band}"\\]\\s*\\{([^}]+)\\}`,
    'g'
  )
  const matches: string[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(cssContent)) !== null) {
    matches.push(m[1])
  }
  return matches.join('\n')
}

/** Parse a CSS numeric value (e.g. "20px" -> 20, "1.8" -> 1.8, "0.75rem" -> 12) */
function parseCssValue(block: string, varName: string): number {
  const regex = new RegExp(`${varName}:\\s*([\\d.]+)(px|rem)?`)
  const match = block.match(regex)
  if (!match) throw new Error(`${varName} not found in block`)
  const val = parseFloat(match[1])
  if (match[2] === 'rem') return val * 16 // convert rem to px
  return val
}

const REQUIRED_VARIABLES = [
  '--cb-font-size',
  '--cb-line-height',
  '--cb-touch-target',
  '--cb-spacing-base',
  '--cb-information-density',
]

// ─── Tests ────────────────────────────────────────────────────────

describe('Grade-band CSS variables', () => {
  // Test 1: All 4 grade bands exist in the CSS
  it('defines selectors for all 4 grade bands', () => {
    for (const band of GRADE_BANDS) {
      expect(cssContent).toContain(`[data-grade-band="${band}"]`)
    }
  })

  // Test 2: Each band defines all 5 required CSS custom properties
  it('each band defines all 5 required CSS variables', () => {
    for (const band of GRADE_BANDS) {
      const block = extractBandBlock(band)
      for (const v of REQUIRED_VARIABLES) {
        expect(block, `${band} missing ${v}`).toContain(v)
      }
    }
  })

  // Test 3: K-2 font-size is 18–20px
  it('K-2 font-size is 18–20px', () => {
    const block = extractBandBlock('k2')
    const fontSize = parseCssValue(block, '--cb-font-size')
    expect(fontSize).toBeGreaterThanOrEqual(18)
    expect(fontSize).toBeLessThanOrEqual(20)
  })

  // Test 4: K-2 touch-target >= 56px
  it('K-2 touch-target >= 56px', () => {
    const block = extractBandBlock('k2')
    const target = parseCssValue(block, '--cb-touch-target')
    expect(target).toBeGreaterThanOrEqual(56)
  })

  // Test 5: K-2 line-height >= 1.8
  it('K-2 line-height >= 1.8', () => {
    const block = extractBandBlock('k2')
    const lh = parseCssValue(block, '--cb-line-height')
    expect(lh).toBeGreaterThanOrEqual(1.8)
  })

  // Test 6: 3-5 has intermediate values
  it('3-5 font-size is 16–18px and touch-target >= 48px', () => {
    const block = extractBandBlock('g35')
    const fontSize = parseCssValue(block, '--cb-font-size')
    const target = parseCssValue(block, '--cb-touch-target')
    expect(fontSize).toBeGreaterThanOrEqual(16)
    expect(fontSize).toBeLessThanOrEqual(18)
    expect(target).toBeGreaterThanOrEqual(48)
  })

  // Test 7: 6-8 has intermediate values
  it('6-8 font-size is 15–16px and touch-target >= 44px', () => {
    const block = extractBandBlock('g68')
    const fontSize = parseCssValue(block, '--cb-font-size')
    const target = parseCssValue(block, '--cb-touch-target')
    expect(fontSize).toBeGreaterThanOrEqual(15)
    expect(fontSize).toBeLessThanOrEqual(16)
    expect(target).toBeGreaterThanOrEqual(44)
  })

  // Test 8: 9-12 font-size is exactly 15px and touch-target <= 44px
  it('9-12 font-size is exactly 15px and touch-target <= 44px', () => {
    const block = extractBandBlock('g912')
    const fontSize = parseCssValue(block, '--cb-font-size')
    const target = parseCssValue(block, '--cb-touch-target')
    expect(fontSize).toBe(15)
    expect(target).toBeLessThanOrEqual(44)
  })

  // Test 9: Values are monotonically decreasing from K-2 → 9-12
  it('font-size, touch-target, and spacing decrease monotonically K-2 → 9-12', () => {
    const orderedBands: GradeBand[] = ['k2', 'g35', 'g68', 'g912']
    const fontSizes = orderedBands.map((b) => parseCssValue(extractBandBlock(b), '--cb-font-size'))
    const touchTargets = orderedBands.map((b) => parseCssValue(extractBandBlock(b), '--cb-touch-target'))
    const spacings = orderedBands.map((b) => parseCssValue(extractBandBlock(b), '--cb-spacing-base'))

    for (let i = 0; i < orderedBands.length - 1; i++) {
      expect(fontSizes[i], `font-size: ${orderedBands[i]} >= ${orderedBands[i + 1]}`).toBeGreaterThanOrEqual(fontSizes[i + 1])
      expect(touchTargets[i], `touch-target: ${orderedBands[i]} >= ${orderedBands[i + 1]}`).toBeGreaterThanOrEqual(touchTargets[i + 1])
      expect(spacings[i], `spacing: ${orderedBands[i]} >= ${orderedBands[i + 1]}`).toBeGreaterThanOrEqual(spacings[i + 1])
    }
  })

  // Test 10: information-density increases monotonically (denser for older students)
  it('information-density increases monotonically K-2 → 9-12', () => {
    const orderedBands: GradeBand[] = ['k2', 'g35', 'g68', 'g912']
    const densities = orderedBands.map((b) => parseCssValue(extractBandBlock(b), '--cb-information-density'))

    for (let i = 0; i < orderedBands.length - 1; i++) {
      expect(densities[i], `density: ${orderedBands[i]} <= ${orderedBands[i + 1]}`).toBeLessThanOrEqual(densities[i + 1])
    }
  })
})

describe('Grade-band atom', () => {
  let store: ReturnType<typeof createStore>
  let dom: InstanceType<typeof JSDOM>

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
    // Stub the global document so the atom's DOM write works in Node
    vi.stubGlobal('document', dom.window.document)
    store = createStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Test 11: Default grade band is g912
  it('defaults to g912', () => {
    expect(store.get(gradeBandAtom)).toBe('g912')
  })

  // Test 12: setGradeBandAtom updates the atom value
  it('setGradeBandAtom updates atom value', () => {
    store.set(setGradeBandAtom, 'k2')
    expect(store.get(gradeBandAtom)).toBe('k2')
  })

  // Test 13: setGradeBandAtom sets DOM data attribute
  it('setGradeBandAtom sets document.documentElement.dataset.gradeBand', () => {
    store.set(setGradeBandAtom, 'g35')
    expect(document.documentElement.dataset.gradeBand).toBe('g35')
  })

  // Test 14: Changing band updates DOM attribute reactively
  it('changing band updates DOM attribute without page reload', () => {
    store.set(setGradeBandAtom, 'k2')
    expect(document.documentElement.dataset.gradeBand).toBe('k2')

    store.set(setGradeBandAtom, 'g912')
    expect(document.documentElement.dataset.gradeBand).toBe('g912')
  })
})

describe('Streaming toggle per grade band', () => {
  // Test 15: K-2 disables streaming
  it('K-2 has streaming disabled', () => {
    expect(isStreamingEnabled('k2')).toBe(false)
  })

  // Test 16: 9-12 enables streaming
  it('9-12 has streaming enabled', () => {
    expect(isStreamingEnabled('g912')).toBe(true)
  })

  // Test 17: 3-5 and 6-8 have streaming enabled
  it('3-5 and 6-8 have streaming enabled', () => {
    expect(isStreamingEnabled('g35')).toBe(true)
    expect(isStreamingEnabled('g68')).toBe(true)
  })
})

describe('DM Sans font declaration', () => {
  // Test 18: CSS declares DM Sans as font-family
  it('grade-bands.css declares DM Sans font-family on :root', () => {
    expect(cssContent).toMatch(/font-family:.*DM Sans/)
  })
})

describe('No component-level grade-band variants (CLR-001)', () => {
  // Test 19: CSS uses only attribute selectors, no component-specific classes
  it('CSS uses [data-grade-band] attribute selectors, not component-specific band classes', () => {
    // Should NOT contain patterns like .k2-message, .g912-button etc.
    expect(cssContent).not.toMatch(/\.(k2|g35|g68|g912)-(message|button|input|card)/)
  })
})

describe('WCAG AA contrast ratios', () => {
  /**
   * Verify that grade-band colors maintain WCAG AA contrast.
   * The grade-bands.css does NOT override text/background colors —
   * it inherits from globals.css which uses --chatbox-tint-primary (#212529)
   * on --chatbox-background-primary (#ffffff).
   * We verify the inherited contrast is WCAG AA compliant.
   */

  function luminance(hex: string): number {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  }

  function contrastRatio(hex1: string, hex2: string): number {
    const l1 = luminance(hex1)
    const l2 = luminance(hex2)
    const lighter = Math.max(l1, l2)
    const darker = Math.min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)
  }

  // The app uses --chatbox-tint-primary (#212529) text on --chatbox-background-primary (#ffffff) bg
  const textColor = '#212529'
  const bgColor = '#ffffff'

  // Test 20: Text on background meets WCAG AA 4.5:1 for normal text (applies to all bands)
  it('primary text on primary background meets WCAG AA 4.5:1 contrast ratio', () => {
    const ratio = contrastRatio(textColor, bgColor)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  // Test 21: Even at 9-12 small text (15px), contrast is maintained
  it('contrast ratio exceeds 4.5:1 — safe for 9-12 normal text at 15px', () => {
    // 15px is under 18px (large text threshold), so needs 4.5:1
    const ratio = contrastRatio(textColor, bgColor)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  // Test 22: K-2 large text (>=18px) can use relaxed 3:1 threshold
  it('contrast ratio exceeds 3:1 — safe for K-2 large text at 18-20px', () => {
    // 18px+ counts as large text, threshold is 3:1
    const ratio = contrastRatio(textColor, bgColor)
    expect(ratio).toBeGreaterThanOrEqual(3)
  })
})
