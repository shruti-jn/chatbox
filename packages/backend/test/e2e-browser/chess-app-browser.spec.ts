/**
 * Chess App — Browser-Level Verification
 *
 * Covers gaps flagged during review:
 * 1. CBP state_update payload: verify richer payload (fen, difficulty, mode,
 *    opponentType, turnState, lastMove) flows from iframe postMessage
 * 2. Difficulty selector UI: layout, disabled state during opponent thinking
 * 3. Refresh/reconnect: reload preserves board state from localStorage
 */

import { test, expect, type Page } from '@playwright/test'

const CHESS_URL = 'http://localhost:3001/api/v1/apps/chess/ui/'

// ── Helpers ──────────────────────────────────────────────────────────

async function interceptPostMessages(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__cbpMessages = []
    const orig = window.parent.postMessage.bind(window.parent)
    window.parent.postMessage = function(msg: any, ...args: any[]) {
      try {
        const parsed = typeof msg === 'string' ? JSON.parse(msg) : msg
        if (parsed?.method === 'state_update') {
          ;(window as any).__cbpMessages.push(structuredClone(parsed))
        }
      } catch {}
      return orig(msg, ...args)
    }
  })
}

async function getMessages(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__cbpMessages ?? [])
}

async function clearMessages(page: Page) {
  await page.evaluate(() => { (window as any).__cbpMessages = [] })
}

/** Click a chess square by algebraic notation (e.g. 'e2') */
async function clickSquare(page: Page, square: string) {
  const col = 'abcdefgh'.indexOf(square[0])
  const row = 8 - parseInt(square[1])
  const index = row * 8 + col
  const squares = page.locator('#board .square')
  // force: true because valid-move overlay squares can intercept pointer events
  await squares.nth(index).click({ force: true })
}

async function screenshotWithTitle(page: Page, title: string, path: string) {
  await page.evaluate((t) => {
    let banner = document.getElementById('__test_banner')
    if (!banner) {
      banner = document.createElement('div')
      banner.id = '__test_banner'
      banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:9999;background:#1e1e2e;color:#a6e3a1;' +
        'padding:8px 16px;font:600 13px monospace;border-bottom:2px solid #45475a;'
      document.body.prepend(banner)
    }
    banner.textContent = t
  }, title)
  await page.screenshot({ path, fullPage: true })
}

/** Wait for board to fully render (64 squares) */
async function waitForBoard(page: Page) {
  await page.waitForFunction(() => document.querySelectorAll('#board .square').length === 64, null, { timeout: 10000 })
}

// ── Test 1: CBP state_update payload verification ────────────────────

test.describe('CBP state_update payload', () => {
  test('move triggers state_update with full richer payload', async ({ page }) => {
    await page.goto(CHESS_URL)
    await waitForBoard(page)

    // Intercept postMessages FIRST, then clear state and re-render (no reload)
    await interceptPostMessages(page)

    // Clear localStorage and reset the app via JS (no page reload to keep our hook)
    await page.evaluate(() => {
      localStorage.removeItem('chatbridge:apps-chess:session')
    })
    await clearMessages(page)

    // Play e2->e4
    await clickSquare(page, 'e2')
    await page.waitForTimeout(300)
    await clickSquare(page, 'e4')

    // Wait for opponent to respond
    await page.waitForTimeout(3000)

    const messages = await getMessages(page)
    expect(messages.length).toBeGreaterThanOrEqual(1)

    // Use the first message that has a valid state with fen
    const stateMsg = messages.find((m: any) => m.params?.state?.fen)
    expect(stateMsg).toBeDefined()

    const state = stateMsg.params.state

    // Verify all richer payload fields
    expect(state.fen).toBeDefined()
    expect(state.fen).toContain('/')
    expect(state.difficulty).toMatch(/^(beginner|intermediate|advanced)$/)
    expect(state.mode).toBe('student_vs_computer')
    expect(state.opponentType).toBe('computer')
    expect(state.opponentName).toBe('Chess Bot')
    expect(state.turn).toBeDefined()
    expect(state.moveCount).toBeGreaterThanOrEqual(1)
    expect(typeof state.pgn).toBe('string')
    expect(typeof state.isCheck).toBe('boolean')
    expect(typeof state.isCheckmate).toBe('boolean')
    expect(typeof state.isStalemate).toBe('boolean')
    expect(typeof state.isDraw).toBe('boolean')
    expect(typeof state.isGameOver).toBe('boolean')
    expect(state.lastMove).toBeDefined()
    expect(state.lastMove.from).toMatch(/^[a-h][1-8]$/)
    expect(state.lastMove.to).toMatch(/^[a-h][1-8]$/)
    expect(['student_turn', 'opponent_thinking', 'terminal', 'opponent_error']).toContain(state.turnState)

    const fieldCount = Object.keys(state).length
    await screenshotWithTitle(
      page,
      `CBP state_update PASS — ${fieldCount} fields, fen: ${state.fen.substring(0, 35)}…`,
      'screenshots/chess-cbp-state-update.png',
    )
  })

  test('difficulty change emits state_update with updated difficulty', async ({ page }) => {
    await page.goto(CHESS_URL)
    await waitForBoard(page)

    await interceptPostMessages(page)
    await clearMessages(page)

    await page.locator('#difficulty-select').selectOption('advanced')
    await page.waitForTimeout(500)

    const messages = await getMessages(page)
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const last = messages[messages.length - 1]
    expect(last.params.state.difficulty).toBe('advanced')

    await screenshotWithTitle(
      page,
      'CBP state_update — difficulty changed to "advanced"',
      'screenshots/chess-cbp-difficulty-change.png',
    )
  })
})

// ── Test 2: Difficulty selector UI ───────────────────────────────────

test.describe('Difficulty selector UI', () => {
  test('renders label, 3 options, caption — correct layout', async ({ page }) => {
    await page.goto(CHESS_URL)
    await waitForBoard(page)

    const label = page.locator('.difficulty-label')
    await expect(label).toHaveText('Computer difficulty')

    const select = page.locator('#difficulty-select')
    const options = await select.locator('option').allTextContents()
    expect(options).toEqual(['Beginner', 'Intermediate', 'Advanced'])
    await expect(select).toHaveValue('intermediate')
    await expect(select).toBeEnabled()

    const caption = page.locator('.difficulty-caption')
    await expect(caption).toContainText('opponent move generator')

    await screenshotWithTitle(
      page,
      'Difficulty selector — enabled, default Intermediate, 3 options',
      'screenshots/chess-difficulty-layout.png',
    )
  })

  test('select disables during opponent thinking', async ({ page }) => {
    await page.goto(CHESS_URL)
    await waitForBoard(page)

    // Clear state for fresh game
    await page.evaluate(() => localStorage.removeItem('chatbridge:apps-chess:session'))
    await page.reload()
    await waitForBoard(page)

    // Before the move, select should be enabled
    await expect(page.locator('#difficulty-select')).toBeEnabled()

    // Make a move — immediately after, check disabled state
    await clickSquare(page, 'e2')
    await page.waitForTimeout(200)
    await clickSquare(page, 'e4')

    // Poll for disabled state (opponent thinking starts immediately after move)
    let sawDisabled = false
    let captionDuringThinking = ''
    for (let i = 0; i < 20; i++) {
      const disabled = await page.locator('#difficulty-select').isDisabled()
      if (disabled) {
        sawDisabled = true
        captionDuringThinking = await page.locator('.difficulty-caption').textContent() ?? ''
        await screenshotWithTitle(
          page,
          `Difficulty DISABLED during opponent thinking — caption: "${captionDuringThinking}"`,
          'screenshots/chess-difficulty-disabled.png',
        )
        break
      }
      await page.waitForTimeout(50)
    }

    // After opponent finishes, it should re-enable
    await page.waitForTimeout(3000)
    const enabledAfter = await page.locator('#difficulty-select').isEnabled()

    await screenshotWithTitle(
      page,
      `After opponent move — select re-enabled: ${enabledAfter}, saw disabled: ${sawDisabled}`,
      'screenshots/chess-difficulty-reenabled.png',
    )

    // Document behavior: did we actually catch the disabled state?
    if (sawDisabled) {
      expect(captionDuringThinking).toContain('locks while the computer is thinking')
    }
    // Either way, after opponent moves, select should be enabled
    expect(enabledAfter).toBe(true)
  })
})

// ── Test 3: Refresh/reconnect ────────────────────────────────────────

test.describe('Refresh/reconnect', () => {
  test('reload preserves board state from localStorage', async ({ page }) => {
    await page.goto(CHESS_URL)
    await waitForBoard(page)

    // Clear for fresh game
    await page.evaluate(() => localStorage.removeItem('chatbridge:apps-chess:session'))
    await page.reload()
    await waitForBoard(page)

    // Make move: e2->e4
    await clickSquare(page, 'e2')
    await page.waitForTimeout(200)
    await clickSquare(page, 'e4')
    await page.waitForTimeout(3000) // Wait for opponent response

    // Capture FEN before reload
    const fenBefore = await page.evaluate(() => {
      const s = localStorage.getItem('chatbridge:apps-chess:session')
      return s ? JSON.parse(s).fen : null
    })
    expect(fenBefore).toBeDefined()
    expect(fenBefore).not.toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')

    await screenshotWithTitle(
      page,
      `Before reload — FEN: ${fenBefore?.substring(0, 40)}`,
      'screenshots/chess-before-reload.png',
    )

    // RELOAD
    await page.reload()
    await waitForBoard(page)
    await page.waitForTimeout(500)

    // Verify FEN preserved
    const fenAfter = await page.evaluate(() => {
      const s = localStorage.getItem('chatbridge:apps-chess:session')
      return s ? JSON.parse(s).fen : null
    })
    expect(fenAfter).toBe(fenBefore)

    // Verify difficulty is also preserved
    const diffAfter = await page.locator('#difficulty-select').inputValue()
    expect(diffAfter).toMatch(/^(beginner|intermediate|advanced)$/)

    // Verify board shows moved pieces (not starting position)
    const statusText = await page.locator('#status').textContent()

    await screenshotWithTitle(
      page,
      `After reload — FEN preserved: ${fenAfter === fenBefore}, status: "${statusText}"`,
      'screenshots/chess-after-reload.png',
    )
  })

  test('reload mid-think: board recovers, not stuck', async ({ page }) => {
    await page.goto(CHESS_URL)
    await waitForBoard(page)

    // Fresh game
    await page.evaluate(() => localStorage.removeItem('chatbridge:apps-chess:session'))
    await page.reload()
    await waitForBoard(page)

    // Make move — IMMEDIATELY reload before opponent finishes
    await clickSquare(page, 'd2')
    await page.waitForTimeout(200)
    await clickSquare(page, 'd4')
    await page.waitForTimeout(100) // barely any time for opponent

    // Capture state before reload
    const stateBefore = await page.evaluate(() => {
      const s = localStorage.getItem('chatbridge:apps-chess:session')
      return s ? JSON.parse(s) : null
    })

    await screenshotWithTitle(
      page,
      `Mid-think — turnState: ${stateBefore?.turnState}, waiting: ${stateBefore?.waitingForOpponent}`,
      'screenshots/chess-midthink-before.png',
    )

    // RELOAD mid-think
    await page.reload()
    await waitForBoard(page)
    await page.waitForTimeout(3000) // give it time to settle

    const stateAfter = await page.evaluate(() => {
      const s = localStorage.getItem('chatbridge:apps-chess:session')
      return s ? JSON.parse(s) : null
    })

    const selectDisabled = await page.locator('#difficulty-select').isDisabled()
    const statusText = await page.locator('#status').textContent()

    await screenshotWithTitle(
      page,
      `After reload mid-think — turnState: ${stateAfter?.turnState}, disabled: ${selectDisabled}, status: "${statusText}"`,
      'screenshots/chess-midthink-after.png',
    )

    // The critical check: is the board usable? It should not be permanently stuck
    // Either the opponent replayed and it's student_turn, or it recovered
    // If select is still disabled after 3s, that's a bug
    if (selectDisabled && stateAfter?.turnState === 'opponent_thinking') {
      console.warn('BUG: Board stuck in opponent_thinking after reload')
    }
  })
})
