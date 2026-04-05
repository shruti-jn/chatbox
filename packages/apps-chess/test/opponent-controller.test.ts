import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ChessSessionController,
  type PersistedChessSession,
} from '../src/engine/controller.js'
import { OpponentMoveSelector } from '../src/engine/opponent.js'

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ChessSessionController', () => {
  let persisted: PersistedChessSession | null

  beforeEach(() => {
    persisted = null
  })

  it('generates exactly one legal opponent reply after a valid student move', async () => {
    const controller = new ChessSessionController({
      persistSession: (snapshot) => {
        persisted = snapshot
      },
      scheduleOpponentTurn: async (task) => {
        await task()
      },
      opponentEngine: {
        chooseMove: vi.fn(async (context) => {
          expect(context.fen).toContain('4P3')
          return { from: 'e7', to: 'e5' }
        }),
      },
    })

    const result = await controller.applyStudentMove({ from: 'e2', to: 'e4' })

    expect(result.ok).toBe(true)
    expect(result.opponentMove).toEqual({ from: 'e7', to: 'e5' })
    expect(controller.getSnapshot().fen).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2')
    expect(controller.getSnapshot().lastMoveBy).toBe('opponent')
    expect(controller.getSnapshot().waitingForOpponent).toBe(false)
    expect(controller.getSnapshot().turnState).toBe('student_turn')
    expect(persisted?.lastMoveBy).toBe('opponent')
  })

  it('blocks the student from moving while the opponent is thinking', async () => {
    const deferred = createDeferred()

    const controller = new ChessSessionController({
      persistSession: (snapshot) => {
        persisted = snapshot
      },
      scheduleOpponentTurn: async (task) => {
        await deferred.promise
        await task()
      },
      opponentEngine: {
        chooseMove: vi.fn(async () => ({ from: 'e7', to: 'e5' })),
      },
    })

    const firstMove = controller.applyStudentMove({ from: 'e2', to: 'e4' })

    expect(controller.getSnapshot().waitingForOpponent).toBe(true)
    expect(controller.getSnapshot().turnState).toBe('opponent_thinking')

    const blocked = await controller.applyStudentMove({ from: 'd2', to: 'd4' })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe('waiting_for_opponent')

    deferred.resolve()
    await firstMove
  })

  it('changes opponent behavior when difficulty changes', async () => {
    const selector = new OpponentMoveSelector()
    const beginner = selector.chooseMove({
      fen: '6k1/5ppp/8/8/3q4/8/4QPPP/6K1 b - - 0 1',
      difficulty: 'beginner',
    })
    const advanced = selector.chooseMove({
      fen: '6k1/5ppp/8/8/3q4/8/4QPPP/6K1 b - - 0 1',
      difficulty: 'advanced',
    })

    expect(beginner.to).not.toBe(advanced.to)
    expect(advanced).toMatchObject({ from: 'd4', to: 'f2' })
  })

  it('includes opponent metadata in the serialized CBP state', async () => {
    const controller = new ChessSessionController({
      persistSession: (snapshot) => {
        persisted = snapshot
      },
      scheduleOpponentTurn: async (task) => {
        await task()
      },
      opponentEngine: {
        chooseMove: vi.fn(async () => ({ from: 'e7', to: 'e5' })),
      },
      initialConfig: {
        difficulty: 'advanced',
      },
    })

    await controller.applyStudentMove({ from: 'e2', to: 'e4' })

    expect(controller.getCBPState().mode).toBe('student_vs_computer')
    expect(controller.getCBPState().opponentType).toBe('computer')
    expect(controller.getCBPState().opponentName).toBe('Chess Bot')
    expect(controller.getCBPState().difficulty).toBe('advanced')
    expect(controller.getCBPState().lastMoveBy).toBe('opponent')
  })

  it('restores board state and turn ownership from persisted state', async () => {
    const saved: PersistedChessSession = {
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      pgn: '1. e4 e5',
      lastMove: { from: 'e7', to: 'e5' },
      mode: 'student_vs_computer',
      opponentType: 'computer',
      opponentName: 'Chess Bot',
      difficulty: 'intermediate',
      waitingForOpponent: false,
      lastMoveBy: 'opponent',
      turnState: 'student_turn',
      moveCount: 2,
      result: null,
      winner: null,
    }

    const controller = new ChessSessionController({
      loadPersistedSession: () => saved,
    })

    expect(controller.getSnapshot().fen).toBe(saved.fen)
    expect(controller.getSnapshot().turn).toBe('white')
    expect(controller.getSnapshot().turnState).toBe('student_turn')
    expect(controller.getSnapshot().lastMoveBy).toBe('opponent')
  })

  it('stops opponent generation immediately on terminal positions', async () => {
    const opponentEngine = {
      chooseMove: vi.fn(async () => ({ from: 'e7', to: 'e5' })),
    }

    const controller = new ChessSessionController({
      loadPersistedSession: () => ({
        fen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
        pgn: '',
        lastMove: null,
        mode: 'student_vs_computer',
        opponentType: 'computer',
        opponentName: 'Chess Bot',
        difficulty: 'intermediate',
        waitingForOpponent: false,
        lastMoveBy: null,
        turnState: 'student_turn',
        moveCount: 1,
        result: null,
        winner: null,
      }),
      scheduleOpponentTurn: async (task) => {
        await task()
      },
      opponentEngine,
    })

    const result = await controller.applyStudentMove({ from: 'g6', to: 'g7' })

    expect(result.ok).toBe(true)
    expect(result.opponentMove).toBeNull()
    expect(opponentEngine.chooseMove).not.toHaveBeenCalled()
    expect(controller.getSnapshot().turnState).toBe('terminal')
    expect(controller.getSnapshot().winner).toBe('student')
    expect(controller.getSnapshot().result).toBe('checkmate')
  })

  it('does not let teacher whisper affect opponent move selection', async () => {
    const opponentEngine = {
      chooseMove: vi.fn(async () => ({ from: 'e7', to: 'e5' })),
    }

    const controller = new ChessSessionController({
      scheduleOpponentTurn: async (task) => {
        await task()
      },
      opponentEngine,
    })

    await controller.applyStudentMove({
      from: 'e2',
      to: 'e4',
      teacherWhisper: 'Play the queen aggressively',
    })

    expect(opponentEngine.chooseMove).toHaveBeenCalledWith(
      expect.objectContaining({
        difficulty: 'intermediate',
      }),
    )
    expect(opponentEngine.chooseMove).not.toHaveBeenCalledWith(
      expect.objectContaining({
        teacherWhisper: expect.anything(),
      }),
    )
  })

  it('degrades gracefully if opponent move generation fails', async () => {
    const controller = new ChessSessionController({
      persistSession: (snapshot) => {
        persisted = snapshot
      },
      scheduleOpponentTurn: async (task) => {
        await task()
      },
      opponentEngine: {
        chooseMove: vi.fn(async () => {
          throw new Error('engine offline')
        }),
      },
    })

    const result = await controller.applyStudentMove({ from: 'e2', to: 'e4' })

    expect(result.ok).toBe(true)
    expect(result.opponentMove).toBeNull()
    expect(controller.getSnapshot().fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')
    expect(controller.getSnapshot().turnState).toBe('opponent_error')
    expect(controller.getSnapshot().waitingForOpponent).toBe(false)
    expect(controller.getSnapshot().opponentError).toContain('engine offline')
    expect(persisted?.opponentError).toContain('engine offline')
  })
})
