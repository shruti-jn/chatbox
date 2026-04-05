import { Chess } from 'chess.js'

import { ChessSessionController, type PersistedChessSession } from './engine/controller.js'
import type { ChessActor, ChessDifficulty } from './state/session.js'

const PIECES: Record<string, string> = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
}

const COLS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const STORAGE_KEY = 'chatbridge:apps-chess:session'

class ChessApp {
  private controller: ChessSessionController
  private selectedSquare: string | null = null
  private validMoves: string[] = []
  private boardEl: HTMLElement
  private statusEl: HTMLElement
  private errorEl: HTMLElement
  private controlsEl: HTMLElement
  private instanceId: string | null = null
  private suspended = false
  private dragFromSquare: string | null = null
  private allowedOrigin = '*'

  constructor() {
    this.boardEl = document.getElementById('board')!
    this.statusEl = document.getElementById('status')!
    this.errorEl = document.getElementById('error')!
    this.controlsEl = document.getElementById('controls')!
    this.allowedOrigin =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? '*'
        : window.location.origin

    this.controller = new ChessSessionController({
      loadPersistedSession: () => this.loadPersistedSession(),
      persistSession: (snapshot) => this.persistSession(snapshot),
    })

    this.renderControls()
    this.render()
    this.setupCBP()
    this.sendStateUpdate()
  }

  private setupCBP() {
    window.addEventListener('message', (event) => {
      if (this.allowedOrigin !== '*' && event.origin !== this.allowedOrigin) return

      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
        if (msg.jsonrpc !== '2.0') return

        if (msg.method === 'command') {
          this.handleCommand(msg.params)
        } else if (msg.method === 'lifecycle') {
          this.handleLifecycle(msg.params)
        } else if (msg.method === 'set_instance_id') {
          this.instanceId = msg.params?.instance_id as string
          this.sendStateUpdate()
        } else if (msg.method === 'suspend') {
          this.handleLifecycle({ event: 'suspend' })
        } else if (msg.method === 'resume') {
          this.handleLifecycle({ event: 'resume' })
        }
      } catch {
        // Ignore malformed messages from outside the CBP contract.
      }
    })

    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: this.controller.getCBPState(),
    })
  }

  private postCBP(method: string, params: Record<string, unknown>) {
    const msg = { jsonrpc: '2.0', method, params }
    window.parent.postMessage(JSON.stringify(msg), '*')
  }

  private handleCommand(params: Record<string, unknown>) {
    if (params.command === 'set_instance_id') {
      this.instanceId = params.instance_id as string
      this.sendStateUpdate()
      return
    }

    if (params.command === 'reset' || params.command === 'start_game') {
      this.controller.reset({
        difficulty: this.parseDifficulty(params.difficulty),
      })
      this.selectedSquare = null
      this.validMoves = []
      this.errorEl.textContent = ''
      this.renderControls()
      this.render()
      this.sendStateUpdate()
      return
    }

    if (params.command === 'set_difficulty') {
      this.controller.setDifficulty(this.parseDifficulty(params.difficulty))
      this.renderControls()
      this.render()
      this.sendStateUpdate()
    }
  }

  private handleLifecycle(params: Record<string, unknown>) {
    if (params.event === 'suspend') {
      this.suspended = true
      this.selectedSquare = null
      this.validMoves = []
      this.render()
      return
    }

    if (params.event === 'resume') {
      this.suspended = false
      this.render()
      this.sendStateUpdate()
      return
    }

    if (params.event === 'terminate') {
      this.postCBP('state_update', {
        instance_id: this.instanceId ?? 'unknown',
        state: { ...this.controller.getCBPState(), terminated: true },
      })
    }
  }

  private get game() {
    const snapshot = this.controller.getSnapshot()
    return {
      fen: snapshot.fen,
      moveCount: snapshot.moveCount,
      pgn: snapshot.pgn,
      turn: snapshot.turn,
      isCheck: snapshot.isCheck,
      isCheckmate: snapshot.isCheckmate,
      isStalemate: snapshot.isStalemate,
      isDraw: snapshot.isDraw,
      isGameOver: snapshot.isGameOver,
      get: (square: string) => {
        const rows = snapshot.fen.split(' ')[0].split('/')
        const { row, col } = this.squareToIndex(square)
        const rowFen = rows[row]
        let currentCol = 0
        for (const char of rowFen) {
          const empty = Number.parseInt(char, 10)
          if (!Number.isNaN(empty)) {
            currentCol += empty
            continue
          }
          if (currentCol === col) {
            const color = char === char.toLowerCase() ? 'b' : 'w'
            return { color, type: char.toLowerCase() }
          }
          currentCol += 1
        }
        return null
      },
    }
  }

  private parseDifficulty(value: unknown): ChessDifficulty {
    if (value === 'beginner' || value === 'advanced') return value
    return 'intermediate'
  }

  private loadPersistedSession(): PersistedChessSession | null {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return null
      return JSON.parse(raw) as PersistedChessSession
    } catch {
      return null
    }
  }

  private persistSession(snapshot: PersistedChessSession) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }

  private squareToIndex(square: string): { row: number; col: number } {
    const col = COLS.indexOf(square[0])
    const row = 8 - Number.parseInt(square[1], 10)
    return { row, col }
  }

  private indexToSquare(row: number, col: number): string {
    return `${COLS[col]}${8 - row}`
  }

  async resign() {
    const snapshot = this.controller.getSnapshot()
    if (snapshot.isGameOver || this.suspended) return

    const loser = snapshot.turn === 'white' ? 'White' : 'Black'
    const winner: ChessActor = snapshot.turn === 'white' ? 'opponent' : 'student'

    this.statusEl.textContent = `${loser} resigned. ${winner === 'student' ? 'White' : 'Black'} wins!`
    this.statusEl.className = 'status-bar gameover'

    const resignedState = {
      ...snapshot,
      waitingForOpponent: false,
      turnState: 'terminal' as const,
      result: 'resignation',
      resultMessage: `${loser} resigned.`,
      winner,
      lastMoveBy: snapshot.lastMoveBy,
      completed: true,
    }

    this.persistSession(resignedState)
    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: resignedState,
    })

    this.suspended = true
    this.render()
  }

  private async handleSquareClick(square: string) {
    this.errorEl.textContent = ''

    const snapshot = this.controller.getSnapshot()
    if (this.suspended) return

    if (snapshot.turnState === 'opponent_thinking') {
      this.errorEl.textContent = 'Please wait for the computer to move.'
      return
    }

    if (snapshot.isGameOver) {
      this.errorEl.textContent = 'Game is over!'
      return
    }

    const piece = this.game.get(square)

    if (this.selectedSquare) {
      if (this.validMoves.includes(square)) {
        const result = await this.controller.applyStudentMove({
          from: this.selectedSquare,
          to: square,
        })

        if (result.ok) {
          this.selectedSquare = null
          this.validMoves = []
          this.render()
          this.sendStateUpdate()
          return
        }

        this.errorEl.textContent = this.moveFailureMessage(result.reason)
      }

      this.selectedSquare = null
      this.validMoves = []
    }

    if (piece && piece.color === 'w') {
      const legalMoves = this.collectLegalMoves(square)
      if (legalMoves.length > 0) {
        this.selectedSquare = square
        this.validMoves = legalMoves
      }
    }

    this.render()
  }

  private moveFailureMessage(reason?: string) {
    if (reason === 'waiting_for_opponent') return 'Please wait for the computer to move.'
    if (reason === 'game_over') return 'Game is over!'
    return 'Invalid move'
  }

  private collectLegalMoves(square: string) {
    const fen = this.controller.getSnapshot().fen
    const game = new Chess(fen)
    return game.moves({ square: square as never, verbose: true }).map((move) => move.to)
  }

  private updateStatus() {
    const snapshot = this.controller.getSnapshot()
    this.statusEl.className = 'status-bar'
    let headerText = ''

    if (snapshot.turnState === 'opponent_thinking') {
      headerText = `${snapshot.opponentName} is thinking`
      this.statusEl.textContent = `${snapshot.opponentName} is thinking...`
    } else if (snapshot.turnState === 'opponent_error') {
      headerText = 'Opponent unavailable'
      this.statusEl.textContent = 'Computer move failed. Try resetting the game.'
      this.statusEl.classList.add('check')
    } else if (snapshot.isCheckmate) {
      const winner = snapshot.winner === 'student' ? 'White' : 'Black'
      this.statusEl.textContent = `Checkmate! ${winner} wins!`
      this.statusEl.classList.add('gameover')
      headerText = `Checkmate — ${winner} wins`
    } else if (snapshot.isStalemate) {
      this.statusEl.textContent = 'Stalemate — draw!'
      this.statusEl.classList.add('gameover')
      headerText = 'Stalemate'
    } else if (snapshot.isDraw) {
      this.statusEl.textContent = 'Game drawn'
      this.statusEl.classList.add('gameover')
      headerText = 'Draw'
    } else if (snapshot.isCheck) {
      this.statusEl.textContent = `${snapshot.turn === 'white' ? 'White' : 'Black'} is in check!`
      this.statusEl.classList.add('check')
      headerText = `${snapshot.turn === 'white' ? 'White' : 'Black'} in check`
    } else if (snapshot.turn === 'white') {
      headerText = 'Your move'
      this.statusEl.textContent = 'Your move'
    } else {
      headerText = `${snapshot.opponentName} to move`
      this.statusEl.textContent = `${snapshot.opponentName} to move`
    }

    this.updateHeaderStatus(headerText)
  }

  private render() {
    const snapshot = this.controller.getSnapshot()
    this.boardEl.innerHTML = ''

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = this.indexToSquare(row, col)
        const isLight = (row + col) % 2 === 0
        const piece = this.game.get(square)

        const el = document.createElement('div')
        el.className = `square ${isLight ? 'light' : 'dark'}`

        if (this.selectedSquare === square) {
          el.classList.add('selected')
        }
        if (this.validMoves.includes(square)) {
          el.classList.add('valid-move')
        }
        if (snapshot.lastMove && (snapshot.lastMove.from === square || snapshot.lastMove.to === square)) {
          el.classList.add('last-move')
        }

        if (piece) {
          const pieceKey = `${piece.color}${piece.type}`
          const span = document.createElement('span')
          span.className = 'piece'
          span.textContent = PIECES[pieceKey] ?? ''

          if (!this.suspended && !snapshot.isGameOver && snapshot.turn === 'white' && piece.color === 'w') {
            span.draggable = true
            span.addEventListener('dragstart', (event) => {
              this.dragFromSquare = square
              event.dataTransfer!.effectAllowed = 'move'
              event.dataTransfer!.setData('text/plain', square)
            })
          }
          el.appendChild(span)
        }

        el.addEventListener('dragover', (event) => {
          event.preventDefault()
          event.dataTransfer!.dropEffect = 'move'
        })

        el.addEventListener('drop', async (event) => {
          event.preventDefault()
          if (this.dragFromSquare) {
            await this.handleDrop(this.dragFromSquare, square)
            this.dragFromSquare = null
          }
        })

        el.addEventListener('click', () => {
          void this.handleSquareClick(square)
        })
        this.boardEl.appendChild(el)
      }
    }

    this.updateStatus()
    this.renderControls()
    this.renderResignButton()
  }

  private async handleDrop(from: string, to: string) {
    const snapshot = this.controller.getSnapshot()
    if (this.suspended || snapshot.isGameOver || snapshot.turnState === 'opponent_thinking') return

    this.errorEl.textContent = ''
    const result = await this.controller.applyStudentMove({ from, to })

    if (result.ok) {
      this.selectedSquare = null
      this.validMoves = []
      this.render()
      this.sendStateUpdate()
      return
    }

    this.errorEl.textContent = this.moveFailureMessage(result.reason)
  }

  private renderControls() {
    const snapshot = this.controller.getSnapshot()
    this.controlsEl.innerHTML = ''

    const label = document.createElement('label')
    label.className = 'difficulty-label'
    label.textContent = 'Computer difficulty'

    const select = document.createElement('select')
    select.id = 'difficulty-select'
    select.className = 'difficulty-select'
    select.disabled = snapshot.waitingForOpponent

    for (const difficulty of ['beginner', 'intermediate', 'advanced'] as const) {
      const option = document.createElement('option')
      option.value = difficulty
      option.textContent = difficulty[0].toUpperCase() + difficulty.slice(1)
      option.selected = snapshot.difficulty === difficulty
      select.appendChild(option)
    }

    select.addEventListener('change', () => {
      this.controller.setDifficulty(this.parseDifficulty(select.value))
      this.sendStateUpdate()
      this.render()
    })

    const caption = document.createElement('div')
    caption.className = 'difficulty-caption'
    caption.textContent = snapshot.waitingForOpponent
      ? 'Difficulty locks while the computer is thinking.'
      : 'Difficulty changes only the opponent move generator.'

    this.controlsEl.append(label, select, caption)
  }

  private renderResignButton() {
    let btn = document.getElementById('resign-btn') as HTMLButtonElement | null
    if (!btn) {
      btn = document.createElement('button')
      btn.id = 'resign-btn'
      btn.textContent = 'Resign'
      btn.style.cssText =
        'margin-top:12px;padding:8px 24px;background:#E11D48;color:white;border:none;border-radius:8px;' +
        'font-size:14px;font-family:inherit;cursor:pointer;width:100%;max-width:480px;'
      btn.addEventListener('click', () => {
        void this.resign()
      })
      this.errorEl.insertAdjacentElement('afterend', btn)
    }

    const snapshot = this.controller.getSnapshot()
    btn.style.display = snapshot.isGameOver || this.suspended ? 'none' : 'block'
    btn.disabled = snapshot.waitingForOpponent
  }

  private updateHeaderStatus(text: string) {
    const headerStatus = document.getElementById('header-status')
    if (headerStatus) headerStatus.textContent = text
  }

  private sendStateUpdate() {
    const snapshot = this.controller.getCBPState()
    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: snapshot,
    })

    if (snapshot.isGameOver) {
      this.postCBP('state_update', {
        instance_id: this.instanceId ?? 'pending',
        state: {
          ...snapshot,
          completed: true,
          result: snapshot.result ?? 'draw',
          ...(snapshot.winner ? { winner: snapshot.winner } : {}),
        },
      })
    }
  }
}

const app = new ChessApp()
;(window as Window & { __chessApp?: ChessApp }).__chessApp = app
