import { atom } from 'jotai'

/**
 * Valid grade bands for the ChatBridge adaptive UI.
 * Each band maps to a [data-grade-band] CSS attribute selector.
 */
export type GradeBand = 'k2' | 'g35' | 'g68' | 'g912'

export const GRADE_BANDS = ['k2', 'g35', 'g68', 'g912'] as const

/**
 * Whether streaming is enabled for the current grade band.
 * K-2 disables streaming (complete messages only) for safety.
 */
export function isStreamingEnabled(band: GradeBand): boolean {
  return band !== 'k2'
}

/**
 * Jotai atom holding the active grade band.
 * Default: 'g912' (most mature, safest default for unconfigured classrooms).
 */
export const gradeBandAtom = atom<GradeBand>('g912')

/**
 * Derived write atom that sets the grade band AND updates the DOM attribute.
 * When this atom is set, it:
 *   1. Updates the gradeBandAtom value
 *   2. Sets document.documentElement.dataset.gradeBand to the new value
 *
 * This drives the CSS cascade without any JS style manipulation.
 */
export const setGradeBandAtom = atom(
  (get) => get(gradeBandAtom),
  (_get, set, band: GradeBand) => {
    set(gradeBandAtom, band)
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.gradeBand = band
    }
  }
)
