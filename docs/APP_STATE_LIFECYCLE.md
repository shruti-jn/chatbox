# App State Lifecycle — How the AI Stays Aware

> **Canonical lifecycle reference:** See the "App Lifecycle" section in [ARCHITECTURE.md](./ARCHITECTURE.md) for the authoritative state machine, freshness contract, and failure mode table.
>
> This document provides additional implementation detail for each transition.

## The Problem

When a student says "let's play chess" and the AI opens a chess board, the platform must solve a coordination problem: the AI, the iframe app, and the backend must share state continuously. The AI needs to read the board position to give advice. The app needs to know it's still active. The backend needs to persist state for crash recovery. And when any of these fail, the system must degrade gracefully — not silently lose data.

## Architecture

```
Student types message
       ↓
[Backend: chat route]
       ↓ safety pipeline
       ↓ AI generates response (may include tool_use)
       ↓
[Backend: tool execution] ← creates AppInstance (status: active)
       ↓
[Frontend: SSE event] → renders <AppCardPartUI> → iframe loads app
       ↓
[Iframe: chess-app.ts] ← postMessage (CBP protocol)
       ↓                  ↕
[Frontend: cbp-client.ts] ← WebSocket → [Backend: /ws/chat]
       ↓                                        ↓
                                    [Redis pub/sub + DB persist]
       ↓
[Next student message]
       ↓
[Backend: reads appInstance.stateSnapshot → injects into AI system prompt]
       ↓
AI responds with position-aware advice
```

## 1. Registration

**What happens:** At server startup, `registerBuiltInApps()` upserts Chess, Spotify, and Weather apps into the `apps` table with their tool definitions and UI manifest URL.

**What can go wrong:**
- DB connection fails at startup → server crashes (no try/catch around registration)
- App upsert conflict → handled by Prisma upsert (safe)

**Platform responsibility:** Registration is idempotent. The app exists or it doesn't. If the DB is down at startup, the server should log the error and continue with degraded capability — not crash.

**Current gap:** `registerBuiltInApps()` is not wrapped in try/catch. A DB failure during registration crashes the server post-listen.

## 2. Invocation

**What happens:** When the AI decides to call a tool (e.g., `start_game`), the backend:
1. Suspends any existing active app instance for this conversation (single-active constraint)
2. Executes the tool server-side
3. Creates an `AppInstance` with `status: active` and the tool result as `stateSnapshot`
4. Emits a `chatbridge_app_card` SSE event with the app's iframe URL

**What can go wrong:**
- AI doesn't call the tool (prompt engineering issue) → no app card, user sees text-only response
- Tool execution fails → error propagated to AI, which generates a fallback text response
- AppInstance creation fails (DB) → SSE event not emitted, no iframe rendered
- Two tools called simultaneously → race condition on single-active constraint

**Platform responsibility:** Tool failures must never crash the response stream. The AI should always be able to generate a text fallback. The single-active constraint must be enforced atomically.

**Current gap:** Tool execution in the native completions path (`chatbridge-completions.ts`) uses a hardcoded mock switch statement, not real CBP dispatch. The FSM's `loading → active` transition is bypassed — instances are created directly as `active`.

## 3. State Sync

This is the critical path. After the chess board renders in an iframe, state must flow bidirectionally:

### App → Platform (state_update)

```
chess-app.ts: sendStateUpdate()
  → window.parent.postMessage({ jsonrpc: '2.0', method: 'state_update', params: { instance_id, state: { fen, turn, ... } } })
  → cbp-client.ts: handleCBPMessage() validates with CBPMessageSchema
  → cbp-client.ts: forwards via WebSocket { type: 'app_state_update', instanceId, state }
  → websocket.ts: handleAppStateUpdate()
    → Redis publish to cbp:state:{instanceId}
    → DB persist: appInstance.update({ stateSnapshot: state })
```

The state payload for chess includes: `fen`, `pgn`, `turn`, `moveCount`, `isCheck`, `isCheckmate`, `isStalemate`, `isDraw`, `isGameOver`, `lastMove`, `difficulty`, `mode`, `opponentType`, `turnState`.

### Platform → AI (state injection)

```
Student sends next message
  → chatbridge-completions.ts: loadConversationContext()
  → context-builder.ts: queries appInstance WHERE conversationId AND status IN ('active', 'suspended')
  → Reads stateSnapshot.fen from the AppInstance row
  → assembleSystemPrompt() injects: "CHESS POSITION GUIDANCE: FEN is rnbqkbnr/..."
  → AI generates position-aware response
```

### What can go wrong:

| Failure | Current Behavior | Correct Behavior |
|---------|-----------------|-----------------|
| App sends state_update before instanceId assigned | Persisted under `instance_id: 'pending'` | Queue state updates until instanceId is set |
| WebSocket disconnects mid-game | State updates silently dropped, no reconnect | Auto-reconnect with exponential backoff; queue unsent updates |
| Redis is down | `client.publish()` throws uncaught; state update lost | Catch error; fall back to DB-only persist; log warning |
| App stops sending state_update | Instance stays `active` forever; AI reads stale state | Watchdog timer marks instance as `unresponsive` after 10 min of silence |
| iframe fails to load | Local React error state shown; DB still says `active` | Transition instance to `error` status in DB |
| State is stale (>5 min) | System prompt notes "may be stale" | Correct — this is graceful degradation |

**Platform responsibility:** State sync failures must be detectable and recoverable. The AI should know when it's working with stale or missing state. The user should see an indicator when the app is disconnected.

## 4. Teardown

### Game completion
When `isGameOver` is true, the chess app sends a second `state_update` with `completed: true`. This should trigger the FSM transition `active → complete → collapsed`, archiving the game state and collapsing the app card to a summary.

**Current gap:** The `completed: true` signal is received by `cbp-client.ts` but routed to `onCompletion` which is never wired. The FSM `complete` event is never fired. The instance stays `active` in the DB indefinitely.

### Navigation away
When the student navigates to a different conversation, `AppCardPartUI` unmounts and calls `disconnectAppInstance()` (closes WebSocket) and `unregisterAppIframe()`. No lifecycle event is sent to the iframe. No DB status change occurs.

**Current gap:** The instance should transition to `suspended` (preserving state for return) or `terminated` (if the conversation is abandoned).

### Admin suspension
`POST /admin/apps/:appId/suspend` bulk-terminates all instances and disables the app in the catalog. But no WebSocket notification is sent to connected clients — the student's chess board keeps rendering until they refresh.

**Current gap:** Active clients should receive a `SESSION_TERMINATED` WebSocket event and the iframe should show a "This app has been suspended" overlay.

### Session expiry
JWT tokens expire after 8 hours. WebSocket connections only validate the token at connect time — an expired JWT keeps the WS alive indefinitely. No periodic job sweeps stale instances.

**Current gap:** Need either periodic JWT re-validation on active WS connections, or a background job that terminates instances older than the JWT TTL.

## Summary: What Works, What's Missing

| Lifecycle Phase | Working | Missing |
|----------------|---------|---------|
| Registration | Idempotent upsert at startup | try/catch around startup registration |
| Invocation | AI tool calling → AppInstance → iframe | FSM bypassed; mock tool execution on native path |
| State sync (app → DB) | postMessage → WS → Redis → DB persist | WS reconnect; Redis failure handling; instanceId race |
| State sync (DB → AI) | stateSnapshot injected into system prompt | Stale state watchdog; error status propagation |
| Game completion | `completed: true` sent by app | Never reaches FSM; instance stays `active` |
| Navigation | WS disconnected; iframe unmounted | No `suspend` lifecycle event; instance stays `active` |
| Admin suspend | Bulk terminate + disable | No WS notification to active clients |
| Session expiry | JWT validated at WS connect | No periodic re-validation; no instance TTL sweep |
