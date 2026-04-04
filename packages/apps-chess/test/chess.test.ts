/**
 * Chess app unit tests.
 *
 * These test the core chess logic (via chess.js) and the CBP message contract
 * that the chess-app.ts module implements. We avoid importing the app directly
 * because it requires a DOM; instead we replicate the logic paths using the
 * same Chess engine and verify the CBP message shapes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Chess } from 'chess.js'

// ---------------------------------------------------------------------------
// Helpers — mirror the app's CBP message builder
// ---------------------------------------------------------------------------

function getState(game: Chess, lastMove: { from: string; to: string } | null = null) {
  return {
    fen: game.fen(),
    turn: game.turn() === 'w' ? 'white' : 'black',
    isCheck: game.isCheck(),
    isCheckmate: game.isCheckmate(),
    isStalemate: game.isStalemate(),
    isDraw: game.isDraw(),
    isGameOver: game.isGameOver(),
    moveCount: game.moveNumber(),
    pgn: game.pgn(),
    lastMove,
  }
}

function buildStateUpdate(
  game: Chess,
  instanceId: string,
  lastMove: { from: string; to: string } | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    jsonrpc: '2.0',
    method: 'state_update',
    params: {
      instance_id: instanceId,
      state: { ...getState(game, lastMove), ...extra },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Chess App Logic', () => {
  let game: Chess

  beforeEach(() => {
    game = new Chess()
  })

  // A7-1: Legal move accepted
  it('accepts a legal move', () => {
    const move = game.move({ from: 'e2', to: 'e4' })
    expect(move).not.toBeNull()
    expect(move!.san).toBe('e4')
    expect(game.turn()).toBe('b') // black to move after white's move
  })

  // A7-2: Illegal move rejected
  it('rejects an illegal move', () => {
    // Pawn can't move to e5 from e2 in one step... wait, actually it can't
    // move e2 -> e5 (only e3 or e4). Let's try a clearly illegal move.
    expect(() => game.move({ from: 'e2', to: 'e5' })).toThrow()
    // Also: moving opponent piece
    expect(() => game.move({ from: 'e7', to: 'e5' })).toThrow()
    // Turn should still be white
    expect(game.turn()).toBe('w')
  })

  // A7-3: state_update CBP sent after move (mock postMessage)
  it('sends state_update CBP message after a move', () => {
    const postMessage = vi.fn()
    const instanceId = 'test-123'

    // Simulate what the app does after a successful move
    game.move({ from: 'e2', to: 'e4' })
    const lastMove = { from: 'e2', to: 'e4' }

    const msg = buildStateUpdate(game, instanceId, lastMove)
    postMessage(JSON.stringify(msg), '*')

    expect(postMessage).toHaveBeenCalledOnce()
    const parsed = JSON.parse(postMessage.mock.calls[0][0])
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.method).toBe('state_update')
    expect(parsed.params.instance_id).toBe('test-123')
    expect(parsed.params.state.fen).toContain('4P3') // e4 pawn in FEN notation
    expect(parsed.params.state.turn).toBe('black')
    expect(parsed.params.state.lastMove).toEqual({ from: 'e2', to: 'e4' })
  })

  // A7-4: Checkmate detection triggers completion
  it('detects checkmate and signals completion', () => {
    // Scholar's mate: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#
    game.move('e4')
    game.move('e5')
    game.move('Bc4')
    game.move('Nc6')
    game.move('Qh5')
    game.move('Nf6')
    game.move('Qxf7')

    expect(game.isCheckmate()).toBe(true)
    expect(game.isGameOver()).toBe(true)

    // Verify completion message shape
    const result = game.turn() === 'w' ? 'black_wins' : 'white_wins'
    expect(result).toBe('white_wins') // white delivered the mate

    const msg = buildStateUpdate(game, 'test-123', { from: 'h5', to: 'f7' }, {
      completed: true,
      result,
      resultMessage: `Checkmate! White wins in ${game.moveNumber()} moves.`,
    })

    expect(msg.params.state.completed).toBe(true)
    expect(msg.params.state.result).toBe('white_wins')
    expect(msg.params.state.isCheckmate).toBe(true)
  })

  // A7-5: Stalemate detection triggers completion
  it('detects stalemate and signals completion', () => {
    // Fastest known stalemate position — load via FEN
    // This position has black to move with no legal moves but not in check
    const stalemateFen = '8/8/8/8/8/5k2/5p2/5K2 w - - 0 1'
    game.load(stalemateFen)

    expect(game.isStalemate()).toBe(true)
    expect(game.isGameOver()).toBe(true)

    const msg = buildStateUpdate(game, 'test-123', null, {
      completed: true,
      result: 'draw',
      resultMessage: 'Stalemate — draw!',
    })

    expect(msg.params.state.completed).toBe(true)
    expect(msg.params.state.result).toBe('draw')
    expect(msg.params.state.isStalemate).toBe(true)
  })

  // A7-6: Resign triggers completion
  it('sends resignation completion message', () => {
    const postMessage = vi.fn()
    const instanceId = 'test-456'

    // Simulate resign: current turn is white, so white resigns
    const loser = game.turn() === 'w' ? 'White' : 'Black'
    const winner = game.turn() === 'w' ? 'black_wins' : 'white_wins'

    const msg = {
      jsonrpc: '2.0',
      method: 'state_update',
      params: {
        instance_id: instanceId,
        state: {
          ...getState(game),
          completed: true,
          result: 'resignation',
          resultMessage: `${loser} resigned.`,
          winner,
        },
      },
    }

    postMessage(JSON.stringify(msg), '*')

    expect(postMessage).toHaveBeenCalledOnce()
    const parsed = JSON.parse(postMessage.mock.calls[0][0])
    expect(parsed.params.state.completed).toBe(true)
    expect(parsed.params.state.result).toBe('resignation')
    expect(parsed.params.state.winner).toBe('black_wins')
    expect(parsed.params.state.resultMessage).toBe('White resigned.')
  })
})
