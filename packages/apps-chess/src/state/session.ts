import { Chess } from 'chess.js'

export type ChessDifficulty = 'beginner' | 'intermediate' | 'advanced'
export type ChessMode = 'student_vs_computer'
export type ChessOpponentType = 'computer'
export type ChessActor = 'student' | 'opponent'
export type ChessTurnState =
  | 'student_turn'
  | 'opponent_thinking'
  | 'opponent_turn_applied'
  | 'opponent_error'
  | 'terminal'

export interface ChessMove {
  from: string
  to: string
  promotion?: 'q' | 'r' | 'b' | 'n'
}

export interface PersistedChessSession {
  fen: string
  pgn: string
  lastMove: ChessMove | null
  mode: ChessMode
  opponentType: ChessOpponentType
  opponentName: string
  difficulty: ChessDifficulty
  waitingForOpponent: boolean
  lastMoveBy: ChessActor | null
  turnState: ChessTurnState
  moveCount: number
  result: string | null
  winner: ChessActor | null
  resultMessage?: string | null
  completed?: boolean
  opponentError?: string | null
}

export interface ChessSessionSnapshot extends PersistedChessSession {
  turn: 'white' | 'black'
  isCheck: boolean
  isCheckmate: boolean
  isStalemate: boolean
  isDraw: boolean
  isGameOver: boolean
}

export function createDefaultSession(
  overrides: Partial<PersistedChessSession> = {},
): PersistedChessSession {
  const game = new Chess(overrides.fen)
  return {
    fen: game.fen(),
    pgn: overrides.pgn ?? game.pgn(),
    lastMove: overrides.lastMove ?? null,
    mode: overrides.mode ?? 'student_vs_computer',
    opponentType: overrides.opponentType ?? 'computer',
    opponentName: overrides.opponentName ?? 'Chess Bot',
    difficulty: overrides.difficulty ?? 'intermediate',
    waitingForOpponent: overrides.waitingForOpponent ?? false,
    lastMoveBy: overrides.lastMoveBy ?? null,
    turnState: overrides.turnState ?? 'student_turn',
    moveCount: overrides.moveCount ?? game.moveNumber(),
    result: overrides.result ?? null,
    winner: overrides.winner ?? null,
    resultMessage: overrides.resultMessage ?? null,
    completed: overrides.completed ?? false,
    opponentError: overrides.opponentError ?? null,
  }
}

export function buildSnapshot(
  game: Chess,
  session: PersistedChessSession,
): ChessSessionSnapshot {
  return {
    ...session,
    fen: game.fen(),
    pgn: game.pgn(),
    moveCount: game.moveNumber(),
    turn: game.turn() === 'w' ? 'white' : 'black',
    isCheck: game.isCheck(),
    isCheckmate: game.isCheckmate(),
    isStalemate: game.isStalemate(),
    isDraw: game.isDraw(),
    isGameOver: game.isGameOver(),
  }
}

export function applyTerminalState(
  game: Chess,
  session: PersistedChessSession,
): PersistedChessSession {
  const next = { ...session, waitingForOpponent: false, opponentError: null }

  if (!game.isGameOver()) {
    return next
  }

  if (game.isCheckmate()) {
    return {
      ...next,
      turnState: 'terminal',
      result: 'checkmate',
      resultMessage: 'Checkmate',
      completed: true,
      winner: game.turn() === 'w' ? 'opponent' : 'student',
    }
  }

  if (game.isStalemate()) {
    return {
      ...next,
      turnState: 'terminal',
      result: 'stalemate',
      resultMessage: 'Stalemate',
      completed: true,
      winner: null,
    }
  }

  return {
    ...next,
    turnState: 'terminal',
    result: 'draw',
    resultMessage: 'Draw',
    completed: true,
    winner: null,
  }
}
