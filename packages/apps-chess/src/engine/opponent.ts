import { Chess } from 'chess.js'

import type { ChessDifficulty, ChessMove } from '../state/session.js'

export interface OpponentContext {
  fen: string
  difficulty: ChessDifficulty
}

export interface OpponentEngine {
  chooseMove(context: OpponentContext): Promise<ChessMove> | ChessMove
}

type ScoredMove = ChessMove & { score: number; san: string }

function normalizePromotion(promotion?: string): ChessMove['promotion'] {
  return promotion === 'q' || promotion === 'r' || promotion === 'b' || promotion === 'n' ? promotion : undefined
}

const PIECE_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 100,
}

export class OpponentMoveSelector implements OpponentEngine {
  chooseMove(context: OpponentContext): ChessMove {
    const game = new Chess(context.fen)
    const moves = game.moves({ verbose: true })

    if (moves.length === 0) {
      throw new Error('No legal opponent moves available')
    }

    const scoredMoves = moves
      .map((move) => ({
        from: move.from,
        to: move.to,
        promotion: normalizePromotion(move.promotion),
        san: move.san,
        score: scoreMove(move),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        return left.san.localeCompare(right.san)
      })

    if (context.difficulty === 'advanced') {
      return scoredMoves[0]
    }

    if (context.difficulty === 'beginner') {
      return scoredMoves[scoredMoves.length - 1]
    }

    return scoredMoves[Math.floor(scoredMoves.length / 2)]
  }
}

function scoreMove(move: {
  captured?: string
  promotion?: string
  san: string
  to: string
}) {
  let score = 0

  if (move.captured) {
    score += PIECE_VALUE[move.captured] ?? 0
  }

  if (move.promotion) {
    score += 8
  }

  if (move.san.includes('#')) {
    score += 1000
  } else if (move.san.includes('+')) {
    score += 5
  }

  if (['d4', 'd5', 'e4', 'e5'].includes(move.to)) {
    score += 1
  }

  return score
}
