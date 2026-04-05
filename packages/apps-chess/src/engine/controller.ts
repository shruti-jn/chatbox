import { Chess } from 'chess.js'

import {
  applyTerminalState,
  buildSnapshot,
  createDefaultSession,
  type ChessDifficulty,
  type ChessActor,
  type ChessMove,
  type ChessSessionSnapshot,
  type PersistedChessSession,
} from '../state/session.js'
import {
  OpponentMoveSelector,
  type OpponentContext,
  type OpponentEngine,
} from './opponent.js'

type Scheduler = (task: () => Promise<void>) => Promise<void>

interface ControllerOptions {
  initialConfig?: Partial<PersistedChessSession>
  loadPersistedSession?: () => PersistedChessSession | null
  persistSession?: (snapshot: PersistedChessSession) => void
  opponentEngine?: OpponentEngine
  scheduleOpponentTurn?: Scheduler
}

interface ApplyMoveInput extends ChessMove {
  teacherWhisper?: string
}

function normalizePromotion(promotion?: string): ChessMove['promotion'] {
  return promotion === 'q' || promotion === 'r' || promotion === 'b' || promotion === 'n' ? promotion : undefined
}

function normalizeWinner(winner: string | null | undefined): ChessActor | null {
  return winner === 'student' || winner === 'opponent' ? winner : null
}

interface ApplyMoveResult {
  ok: boolean
  reason?: 'waiting_for_opponent' | 'game_over' | 'invalid_move'
  opponentMove: ChessMove | null
}

export class ChessSessionController {
  private game: Chess
  private session: PersistedChessSession
  private readonly persistSession: (snapshot: PersistedChessSession) => void
  private readonly opponentEngine: OpponentEngine
  private readonly scheduleOpponentTurn: Scheduler
  private pendingOpponentTurn: Promise<void> | null = null

  constructor(options: ControllerOptions = {}) {
    const loadedSession = options.loadPersistedSession?.()
    this.session = createDefaultSession({
      ...options.initialConfig,
      ...loadedSession,
      ...(loadedSession ? { winner: normalizeWinner(loadedSession.winner) } : {}),
    })
    this.game = new Chess(this.session.fen)
    this.persistSession = options.persistSession ?? (() => {})
    this.opponentEngine = options.opponentEngine ?? new OpponentMoveSelector()
    this.scheduleOpponentTurn =
      options.scheduleOpponentTurn ??
      (async (task) => {
        await Promise.resolve()
        await task()
      })

    this.syncFromGame()
  }

  getSnapshot(): ChessSessionSnapshot {
    return buildSnapshot(this.game, this.session)
  }

  getCBPState(): ChessSessionSnapshot {
    return this.getSnapshot()
  }

  async applyStudentMove(input: ApplyMoveInput): Promise<ApplyMoveResult> {
    if (this.session.turnState === 'opponent_thinking') {
      return { ok: false, reason: 'waiting_for_opponent', opponentMove: null }
    }

    if (this.session.turnState === 'terminal' || this.game.isGameOver()) {
      return { ok: false, reason: 'game_over', opponentMove: null }
    }

    try {
      this.game.move({
        from: input.from,
        to: input.to,
        promotion: normalizePromotion(input.promotion) ?? 'q',
      })
    } catch {
      return { ok: false, reason: 'invalid_move', opponentMove: null }
    }

    this.session = {
      ...this.session,
      lastMove: {
        from: input.from,
        to: input.to,
        ...(normalizePromotion(input.promotion) ? { promotion: normalizePromotion(input.promotion) } : {}),
      },
      lastMoveBy: 'student',
      waitingForOpponent: false,
      opponentError: null,
      turnState: 'student_turn',
      result: null,
      resultMessage: null,
      completed: false,
      winner: null,
    }
    this.syncFromGame()

    if (this.game.isGameOver()) {
      this.session = applyTerminalState(this.game, this.session)
      this.persist()
      return { ok: true, opponentMove: null }
    }

    this.session = {
      ...this.session,
      waitingForOpponent: true,
      turnState: 'opponent_thinking',
    }
    this.persist()

    let opponentMove: ChessMove | null = null
    this.pendingOpponentTurn = this.scheduleOpponentTurn(async () => {
      opponentMove = await this.applyOpponentMove()
    }).finally(() => {
      this.pendingOpponentTurn = null
    })

    await this.pendingOpponentTurn
    return { ok: true, opponentMove }
  }

  setDifficulty(difficulty: ChessDifficulty) {
    this.session = { ...this.session, difficulty }
    this.persist()
  }

  reset(config: Partial<PersistedChessSession> = {}) {
    this.game = new Chess()
    this.session = createDefaultSession({
      ...this.session,
      ...config,
      fen: this.game.fen(),
      pgn: this.game.pgn(),
      lastMove: null,
      waitingForOpponent: false,
      lastMoveBy: null,
      turnState: 'student_turn',
      result: null,
      resultMessage: null,
      completed: false,
      winner: null,
      opponentError: null,
    })
    this.persist()
  }

  private async applyOpponentMove(): Promise<ChessMove | null> {
    if (this.game.isGameOver()) {
      this.session = applyTerminalState(this.game, this.session)
      this.persist()
      return null
    }

    try {
      const context: OpponentContext = {
        fen: this.game.fen(),
        difficulty: this.session.difficulty,
      }
      const candidate = await this.opponentEngine.chooseMove(context)
      const move = this.game.move({
        from: candidate.from,
        to: candidate.to,
        promotion: normalizePromotion(candidate.promotion) ?? 'q',
      })

      if (!move) {
        throw new Error('Opponent produced an illegal move')
      }

      this.session = {
        ...this.session,
        lastMove: {
          from: move.from,
          to: move.to,
          ...(normalizePromotion(move.promotion) ? { promotion: normalizePromotion(move.promotion) } : {}),
        },
        lastMoveBy: 'opponent',
        waitingForOpponent: false,
        turnState: 'opponent_turn_applied',
        opponentError: null,
      }

      if (this.game.isGameOver()) {
        this.session = applyTerminalState(this.game, this.session)
      } else {
        this.session = {
          ...this.session,
          turnState: 'student_turn',
        }
      }

      this.persist()
      return this.session.lastMove
    } catch (error) {
      this.session = {
        ...this.session,
        waitingForOpponent: false,
        turnState: 'opponent_error',
        opponentError: error instanceof Error ? error.message : 'Opponent move generation failed',
      }
      this.persist()
      return null
    }
  }

  private syncFromGame() {
    this.session = {
      ...this.session,
      fen: this.game.fen(),
      pgn: this.game.pgn(),
      moveCount: this.game.moveNumber(),
    }
    this.persist()
  }

  private persist() {
    this.persistSession(this.session)
  }
}

export type { ApplyMoveResult, ControllerOptions }
export type { PersistedChessSession } from '../state/session.js'
