import { describe, it, expect } from 'vitest'
import { buildAppContextPrompt } from './app-context-injector'

describe('buildAppContextPrompt', () => {
  it('The system shall return null when no snapshots are provided', () => {
    expect(buildAppContextPrompt([])).toBeNull()
  })

  it('The system shall include app name and JSON state in the prompt', () => {
    const result = buildAppContextPrompt([
      { appName: 'Chess', instanceId: 'inst-1', stateSnapshot: { fen: 'rnbq...', turn: 'white' } },
    ])
    expect(result).toContain('Chess')
    expect(result).toContain('rnbq...')
    expect(result).toContain('white')
  })

  it('The system shall wrap state with UNTRUSTED DATA delimiters to prevent prompt injection', () => {
    const result = buildAppContextPrompt([
      { appName: 'Chess', instanceId: 'inst-1', stateSnapshot: { fen: 'r1bqkbnr', turn: 'black' } },
    ])
    expect(result).toContain('[APP STATE — UNTRUSTED DATA')
    expect(result).toContain('[END APP STATE]')
  })

  it('The system shall include multiple apps when multiple are active', () => {
    const result = buildAppContextPrompt([
      { appName: 'Chess', instanceId: 'inst-1', stateSnapshot: { fen: 'r1bq', turn: 'white' } },
      { appName: 'Weather', instanceId: 'inst-2', stateSnapshot: { city: 'NYC', temp: 72 } },
    ])
    expect(result).toContain('Chess')
    expect(result).toContain('Weather')
  })

  it('The system shall truncate any string field longer than 500 chars to prevent context flooding', () => {
    const longString = 'a'.repeat(600)
    const result = buildAppContextPrompt([
      { appName: 'Chess', instanceId: 'inst-1', stateSnapshot: { notes: longString } },
    ])
    expect(result).not.toContain(longString)
    expect(result!.length).toBeLessThan(2000)
  })
})
