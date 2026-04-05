import { Chess } from 'chess.js'
import type { GradeBand } from '@chatbridge/shared'

const ANALYSIS_REQUEST_PATTERN = /\b(what should i do|analy[sz]e|best move|next move|help me|position|chess game)\b/i

type Square =
  | 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'a6' | 'a7' | 'a8'
  | 'b1' | 'b2' | 'b3' | 'b4' | 'b5' | 'b6' | 'b7' | 'b8'
  | 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7' | 'c8'
  | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8'
  | 'e1' | 'e2' | 'e3' | 'e4' | 'e5' | 'e6' | 'e7' | 'e8'
  | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8'
  | 'g1' | 'g2' | 'g3' | 'g4' | 'g5' | 'g6' | 'g7' | 'g8'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8'

interface PieceSnapshot {
  square: Square
  type: string
  color: 'w' | 'b'
}

export interface ChessAnalysisSummary {
  fen: string
  status: 'active' | 'checkmate' | 'stalemate' | 'draw' | 'invalid'
  sideToMove: 'white' | 'black' | 'unknown'
  facts: string[]
  tacticalThemes: string[]
  responseDirectives: string[]
}

function pieceName(type: string): string {
  return {
    p: 'pawn',
    n: 'knight',
    b: 'bishop',
    r: 'rook',
    q: 'queen',
    k: 'king',
  }[type] ?? type
}

function colorName(color: 'w' | 'b'): 'White' | 'Black' {
  return color === 'w' ? 'White' : 'Black'
}

function collectPieces(chess: Chess): PieceSnapshot[] {
  const board = chess.board()
  const pieces: PieceSnapshot[] = []
  for (let rankIndex = 0; rankIndex < board.length; rankIndex += 1) {
    const rank = board[rankIndex]
    for (let fileIndex = 0; fileIndex < rank.length; fileIndex += 1) {
      const piece = rank[fileIndex]
      if (!piece) continue
      const square = `${String.fromCharCode(97 + fileIndex)}${8 - rankIndex}` as Square
      pieces.push({ square, type: piece.type, color: piece.color })
    }
  }
  return pieces
}

function findPiece(pieces: PieceSnapshot[], square: Square, type?: string, color?: 'w' | 'b'): PieceSnapshot | undefined {
  return pieces.find((piece) => piece.square === square && (type ? piece.type === type : true) && (color ? piece.color === color : true))
}

function uniqueFacts(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function responseDirectivesForGradeBand(gradeBand: GradeBand, status: ChessAnalysisSummary['status']): string[] {
  if (status !== 'active') {
    return [
      'Start by clearly saying the game is over.',
      'Do not suggest another move from this position.',
    ]
  }

  switch (gradeBand) {
    case 'k2':
      return [
        'Use very simple language and keep the answer to 2 or 3 short sentences.',
        'Ask guiding questions instead of giving a direct move.',
        'Do not use algebraic notation like Nf3 or Bc4.',
      ]
    case 'g35':
      return [
        'Use encouraging, concrete language.',
        'Focus on one simple idea about the position.',
        'Avoid dense notation unless it is absolutely necessary.',
      ]
    case 'g68':
      return [
        'You can mention tactical ideas like forks, pins, and development.',
        'Use one concrete board detail to justify the advice.',
      ]
    case 'g912':
      return [
        'Use tactical and positional vocabulary when it fits the board.',
        'You may include algebraic notation and a concrete candidate move.',
      ]
    default:
      return ['Use age-appropriate language and ground the response in the actual board state.']
  }
}

export function analyzeChessPosition(fen: string, gradeBand: GradeBand): ChessAnalysisSummary {
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return {
      fen,
      status: 'invalid',
      sideToMove: 'unknown',
      facts: ['The provided board state could not be parsed as a valid FEN.'],
      tacticalThemes: [],
      responseDirectives: ['Acknowledge that the board state is invalid and ask for the game to be refreshed.'],
    }
  }

  const pieces = collectPieces(chess)
  const facts: string[] = []
  const tacticalThemes: string[] = []
  const sideToMove = chess.turn() === 'w' ? 'white' : 'black'

  let status: ChessAnalysisSummary['status'] = 'active'
  if (chess.isCheckmate()) {
    status = 'checkmate'
  } else if (chess.isStalemate()) {
    status = 'stalemate'
  } else if (chess.isDraw()) {
    status = 'draw'
  }

  facts.push(`${sideToMove === 'white' ? 'White' : 'Black'} is to move.`)

  const whiteBishopC4 = findPiece(pieces, 'c4', 'b', 'w')
  if (whiteBishopC4) {
    facts.push('White bishop on c4 is pointing toward the kingside and eyeing f7.')
    tacticalThemes.push('Watch for pressure on f7 from the bishop on c4.')
  }

  const blackKnightC6 = findPiece(pieces, 'c6', 'n', 'b')
  if (blackKnightC6) {
    facts.push('Black knight on c6 is developed and helping guard central squares.')
  }

  const whitePawnE4 = findPiece(pieces, 'e4', 'p', 'w')
  const blackPawnE5 = findPiece(pieces, 'e5', 'p', 'b')
  if (whitePawnE4 && blackPawnE5) {
    facts.push('White pawn on e4 and black pawn on e5 mean the center is active and contested.')
    facts.push('Black pawn on e5 is occupying central space.')
  }

  const whitePawnC4 = findPiece(pieces, 'c4', 'p', 'w')
  const blackPawnD5 = findPiece(pieces, 'd5', 'p', 'b')
  if (whitePawnC4 && blackPawnD5) {
    facts.push('White pawn on c4 is directly challenging the black pawn on d5.')
    tacticalThemes.push('There is central pawn tension between c4 and d5.')
  }

  const blackPawnC5 = findPiece(pieces, 'c5', 'p', 'b')
  if (whitePawnE4 && blackPawnC5) {
    facts.push('Black pawn on c5 creates an asymmetrical Sicilian-style center.')
    tacticalThemes.push('The c5 pawn is fighting for d4 and can lead to imbalanced play.')
  }

  if (findPiece(pieces, 'g1', 'k', 'w') || findPiece(pieces, 'c1', 'k', 'w')) {
    facts.push('White king safety is improved if White has already castled.')
  }
  if (findPiece(pieces, 'g8', 'k', 'b') || findPiece(pieces, 'c8', 'k', 'b')) {
    facts.push('Black king safety is improved if Black has already castled.')
  }

  if (chess.inCheck()) {
    facts.push(`${sideToMove === 'white' ? 'White' : 'Black'} is currently in check.`)
  }

  if (status === 'checkmate') {
    facts.push('This position is checkmate, so the game is already finished.')
  } else if (status === 'stalemate') {
    facts.push('This position is stalemate, so the game is over without a winning move.')
  } else if (status === 'draw') {
    facts.push('This position is drawn or otherwise finished.')
  }

  if (facts.length === 1) {
    const developedPieces = pieces
      .filter(piece => piece.type !== 'p')
      .slice(0, 4)
      .map(piece => `${colorName(piece.color)} ${pieceName(piece.type)} on ${piece.square}`)
    if (developedPieces.length > 0) {
      facts.push(`Key pieces: ${developedPieces.join(', ')}.`)
    }
  }

  return {
    fen,
    status,
    sideToMove,
    facts: uniqueFacts(facts),
    tacticalThemes: uniqueFacts(tacticalThemes),
    responseDirectives: responseDirectivesForGradeBand(gradeBand, status),
  }
}

export function shouldInjectChessAnalysis(appName: string | null, appState: Record<string, unknown> | null, studentQuestion: string | null | undefined): boolean {
  if (!appName || appName.toLowerCase() !== 'chess') return false
  if (!appState || typeof appState.fen !== 'string') return false
  if (!studentQuestion) return true
  return ANALYSIS_REQUEST_PATTERN.test(studentQuestion)
}

export function buildChessAnalysisPrompt(args: {
  appName: string | null
  appState: Record<string, unknown> | null
  gradeBand: GradeBand
  studentQuestion?: string | null
}): string | null {
  if (!shouldInjectChessAnalysis(args.appName, args.appState, args.studentQuestion)) {
    return null
  }

  const fen = args.appState?.fen
  if (typeof fen !== 'string') return null

  const summary = analyzeChessPosition(fen, args.gradeBand)
  const lines = [
    'CHESS POSITION GUIDANCE:',
    `FEN: ${summary.fen}`,
    `Status: ${summary.status}`,
    `Side to move: ${summary.sideToMove}`,
    'Use at least 2 of these concrete board facts in your response:',
    ...summary.facts.map(fact => `- ${fact}`),
  ]

  if (summary.tacticalThemes.length > 0) {
    lines.push('Relevant tactical themes:')
    lines.push(...summary.tacticalThemes.map(theme => `- ${theme}`))
  }

  lines.push('Response rules:')
  lines.push(...summary.responseDirectives.map(rule => `- ${rule}`))

  return lines.join('\n')
}
