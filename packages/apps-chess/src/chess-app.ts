import { Chess } from 'chess.js'

// Unicode chess pieces
const PIECES: Record<string, string> = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
}

const COLS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

class ChessApp {
  private game: Chess
  private selectedSquare: string | null = null
  private validMoves: string[] = []
  private lastMove: { from: string; to: string } | null = null
  private boardEl: HTMLElement
  private statusEl: HTMLElement
  private errorEl: HTMLElement
  private instanceId: string | null = null

  constructor() {
    this.game = new Chess()
    this.boardEl = document.getElementById('board')!
    this.statusEl = document.getElementById('status')!
    this.errorEl = document.getElementById('error')!

    this.render()
    this.setupCBP()
    this.sendStateUpdate()
  }

  private setupCBP() {
    // Listen for CBP commands from platform
    window.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
        if (msg.jsonrpc !== '2.0') return

        if (msg.method === 'command') {
          this.handleCommand(msg.params)
        } else if (msg.method === 'lifecycle') {
          this.handleLifecycle(msg.params)
        }
      } catch {
        // Ignore non-CBP messages
      }
    })

    // Send initial ready signal
    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: this.getState(),
    })
  }

  private postCBP(method: string, params: Record<string, unknown>) {
    const msg = { jsonrpc: '2.0', method, params }
    window.parent.postMessage(JSON.stringify(msg), '*')
  }

  private handleCommand(params: Record<string, unknown>) {
    if (params.command === 'set_instance_id') {
      this.instanceId = params.instance_id as string
    } else if (params.command === 'reset') {
      this.game = new Chess()
      this.selectedSquare = null
      this.validMoves = []
      this.lastMove = null
      this.render()
      this.sendStateUpdate()
    }
  }

  private handleLifecycle(params: Record<string, unknown>) {
    // Handle suspend/resume/terminate
    if (params.event === 'terminate') {
      this.postCBP('state_update', {
        instance_id: this.instanceId ?? 'unknown',
        state: { ...this.getState(), terminated: true },
      })
    }
  }

  private getState() {
    return {
      fen: this.game.fen(),
      turn: this.game.turn() === 'w' ? 'white' : 'black',
      isCheck: this.game.isCheck(),
      isCheckmate: this.game.isCheckmate(),
      isStalemate: this.game.isStalemate(),
      isDraw: this.game.isDraw(),
      isGameOver: this.game.isGameOver(),
      moveCount: this.game.moveNumber(),
      pgn: this.game.pgn(),
      lastMove: this.lastMove,
    }
  }

  private sendStateUpdate() {
    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: this.getState(),
    })

    // If game is over, send completion signal
    if (this.game.isGameOver()) {
      let result = 'draw'
      if (this.game.isCheckmate()) {
        result = this.game.turn() === 'w' ? 'black_wins' : 'white_wins'
      }

      this.postCBP('state_update', {
        instance_id: this.instanceId ?? 'pending',
        state: {
          ...this.getState(),
          completed: true,
          result,
          resultMessage: this.game.isCheckmate()
            ? `Checkmate! ${result === 'white_wins' ? 'White' : 'Black'} wins in ${this.game.moveNumber()} moves.`
            : this.game.isStalemate() ? 'Stalemate — draw!'
            : 'Game drawn.',
        },
      })
    }
  }

  private squareToIndex(square: string): { row: number; col: number } {
    const col = COLS.indexOf(square[0])
    const row = 8 - parseInt(square[1])
    return { row, col }
  }

  private indexToSquare(row: number, col: number): string {
    return `${COLS[col]}${8 - row}`
  }

  private handleSquareClick(square: string) {
    this.errorEl.textContent = ''

    if (this.game.isGameOver()) {
      this.errorEl.textContent = 'Game is over!'
      return
    }

    const piece = this.game.get(square as any)

    // If a piece is already selected, try to make a move
    if (this.selectedSquare) {
      if (this.validMoves.includes(square)) {
        // Make the move
        try {
          const move = this.game.move({
            from: this.selectedSquare,
            to: square,
            promotion: 'q', // Auto-promote to queen
          })

          if (move) {
            this.lastMove = { from: this.selectedSquare, to: square }
            this.selectedSquare = null
            this.validMoves = []
            this.render()
            this.updateStatus()
            this.sendStateUpdate()
            return
          }
        } catch {
          this.errorEl.textContent = 'Invalid move'
        }
      }

      // Deselect or select new piece
      this.selectedSquare = null
      this.validMoves = []
    }

    // Select a piece (must be current player's piece)
    if (piece && piece.color === this.game.turn()) {
      this.selectedSquare = square
      this.validMoves = this.game.moves({ square: square as any, verbose: true }).map(m => m.to)
    }

    this.render()
  }

  private updateStatus() {
    this.statusEl.className = 'status-bar'

    if (this.game.isCheckmate()) {
      const winner = this.game.turn() === 'w' ? 'Black' : 'White'
      this.statusEl.textContent = `Checkmate! ${winner} wins!`
      this.statusEl.classList.add('gameover')
    } else if (this.game.isStalemate()) {
      this.statusEl.textContent = 'Stalemate — draw!'
      this.statusEl.classList.add('gameover')
    } else if (this.game.isDraw()) {
      this.statusEl.textContent = 'Game drawn'
      this.statusEl.classList.add('gameover')
    } else if (this.game.isCheck()) {
      this.statusEl.textContent = `${this.game.turn() === 'w' ? 'White' : 'Black'} is in check!`
      this.statusEl.classList.add('check')
    } else {
      this.statusEl.textContent = `${this.game.turn() === 'w' ? 'White' : 'Black'} to move`
    }
  }

  private render() {
    this.boardEl.innerHTML = ''

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = this.indexToSquare(row, col)
        const isLight = (row + col) % 2 === 0
        const piece = this.game.get(square as any)

        const el = document.createElement('div')
        el.className = `square ${isLight ? 'light' : 'dark'}`

        if (this.selectedSquare === square) {
          el.classList.add('selected')
        }
        if (this.validMoves.includes(square)) {
          el.classList.add('valid-move')
        }
        if (this.lastMove && (this.lastMove.from === square || this.lastMove.to === square)) {
          el.classList.add('last-move')
        }

        if (piece) {
          const pieceKey = `${piece.color}${piece.type}`
          el.innerHTML = `<span class="piece">${PIECES[pieceKey] ?? ''}</span>`
        }

        el.addEventListener('click', () => this.handleSquareClick(square))
        this.boardEl.appendChild(el)
      }
    }

    this.updateStatus()
  }
}

// Initialize
new ChessApp()
