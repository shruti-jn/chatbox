import { describe, expect, it } from 'vitest'
import { analyzeChessPosition, buildChessAnalysisPrompt, shouldInjectChessAnalysis } from '../src/ai/chess-analysis.js'
import { buildSystemPrompt } from '../src/ai/service.js'

describe('chess-analysis', () => {
  it('extracts position-specific Italian Game facts from FEN', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 2 3'

    const result = analyzeChessPosition(fen, 'g912')
    const combinedFacts = result.facts.join(' ')

    expect(result.status).toBe('active')
    expect(combinedFacts).toContain('bishop on c4')
    expect(combinedFacts).toContain('knight on c6')
    expect(combinedFacts).toContain('pawn on e5')
    expect(combinedFacts.toLowerCase()).toContain('center')
  })

  it('changes the derived facts for a different opening structure', () => {
    const qgd = analyzeChessPosition(
      'rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3 0 2',
      'g912',
    )
    const sicilian = analyzeChessPosition(
      'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2',
      'g912',
    )

    expect(qgd.facts.join(' ')).toContain('pawn on c4')
    expect(qgd.facts.join(' ')).toContain('pawn on d5')
    expect(sicilian.facts.join(' ')).toContain('pawn on c5')
    expect(qgd.facts.join(' ')).not.toEqual(sicilian.facts.join(' '))
  })

  it('returns grade-band-specific response rules', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 2 3'

    const k2 = analyzeChessPosition(fen, 'k2')
    const g912 = analyzeChessPosition(fen, 'g912')

    expect(k2.responseDirectives.join(' ')).toContain('Do not use algebraic notation')
    expect(k2.responseDirectives.join(' ')).toContain('Ask guiding questions')
    expect(g912.responseDirectives.join(' ')).toContain('algebraic notation')
    expect(g912.responseDirectives.join(' ')).toContain('candidate move')
  })

  it('identifies terminal positions and forbids move suggestions', () => {
    const mate = analyzeChessPosition('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', 'g912')

    expect(mate.status).toBe('checkmate')
    expect(mate.facts.join(' ')).toContain('checkmate')
    expect(mate.responseDirectives.join(' ')).toContain('Do not suggest another move')
  })

  it('builds a grounded chess prompt block when analysis is requested', () => {
    const prompt = buildChessAnalysisPrompt({
      appName: 'Chess',
      appState: { fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 2 3' },
      gradeBand: 'g912',
      studentQuestion: 'What should I do?',
    })

    expect(prompt).toContain('Use at least 2 of these concrete board facts')
    expect(prompt).toContain('bishop on c4')
    expect(prompt).toContain('knight on c6')
  })

  it('injects grounded chess guidance into the AI system prompt', () => {
    const systemPrompt = buildSystemPrompt({
      messages: [{ role: 'user', content: 'What should I do?' }],
      classroomConfig: { mode: 'direct', subject: 'chess' } as any,
      gradeBand: 'g912',
      activeAppState: { fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 2 3' },
      activeAppName: 'Chess',
      activeAppStatus: 'active',
      stateUpdatedAt: new Date(),
      enabledToolSchemas: {},
      whisperGuidance: null,
      asyncGuidance: null,
      latestStudentMessage: 'What should I do?',
    })

    expect(systemPrompt).toContain('CHESS POSITION GUIDANCE')
    expect(systemPrompt).toContain('bishop on c4')
    expect(systemPrompt).toContain('Use at least 2 of these concrete board facts')
  })

  it('only injects chess analysis for chess states and relevant requests', () => {
    expect(shouldInjectChessAnalysis('Chess', { fen: 'start' }, 'Analyze this position')).toBe(true)
    expect(shouldInjectChessAnalysis('Weather', { forecast: 'sunny' }, 'Analyze this position')).toBe(false)
    expect(shouldInjectChessAnalysis('Chess', { fen: 'start' }, 'Tell me a joke')).toBe(false)
  })
})
