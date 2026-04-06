# Tool Execution Architecture — Decoupled SSE + Resume Tokens

## The Problem

The current architecture holds an open SSE connection for the entire duration of a tool call. The lifecycle is:

```
Client POST /chatbridge/completions
  → SSE headers written (connection open)
  → First Anthropic call (blocking, non-streaming) — waits for tool_use decision
  → executeChatbridgeTool() — synchronous, no timeout
  → Second Anthropic call (streaming) — follow-up response with tool result
  → App card events emitted
  → reply.raw.end()
```

If a tool stalls (chess engine thinking, Spotify rate-limiting, weather API timeout), the SSE connection sits silent with no heartbeat, no timeout, and no way for the client to recover. With thousands of students returning from recess simultaneously, this means connection exhaustion before compute cost is even a factor.

## Current State (What Exists)

| Component | Status |
|-----------|--------|
| SSE open during tool exec | Yes — silent, no heartbeat (`chatbridge-completions.ts:537-590`) |
| Tool timeout | **None** on completions path; 5s on `/apps/:id/tools/:name/invoke` path |
| Resume token | **None** |
| Circuit breaker | Exists (`apps/health.ts`) — 3 fails = degraded, 5 = unresponsive |
| Circuit breaker in completions | Only at tool-listing time, not execution time |
| Queue / backpressure | **None** |
| Connection pooling | **None** |
| Health polling | 30s interval with 5s timeout per app |

## Proposed Architecture — Decoupled Tool Execution

### Phase 1: Checkpoint + Resume Token

Instead of holding the SSE stream alive during tool execution:

```
Client POST /chatbridge/completions
  → SSE headers written
  → First Anthropic call → detects tool_use
  → Emit SSE event: { event: 'tool_pending', data: { toolName, resumeToken, estimatedMs } }
  → reply.raw.end()  ← SSE stream CLOSED

[Tool executes asynchronously]
  → executeChatbridgeTool() with 15s hard timeout
  → On success: store result in Redis keyed by resumeToken (TTL: 5 min)
  → On timeout: synthesize failure result:
    { error: "The app did not respond. Please let the student know and continue." }

Client receives 'tool_pending' event
  → Shows inline "thinking..." indicator with tool name
  → Polls or subscribes: GET /chatbridge/completions/resume?token={resumeToken}
    OR WebSocket notification when result is ready

Client POST /chatbridge/completions/resume
  → Reads tool result from Redis by resumeToken
  → Issues second Anthropic call with full context + tool result
  → Streams follow-up response via new SSE connection
  → Client sees seamless continuation
```

**Key benefit:** The SSE connection lives only as long as the LLM is actively streaming. Tool execution happens in the background. Connection time = streaming time, not tool latency.

### Phase 2: Priority Queue + Backpressure

Tool completions go through a queue with admission control:

```
                                    ┌─────────────────────┐
tool_pending event → resumeToken →  │   Priority Queue    │
                                    │                     │
                                    │  P0: mid-lesson     │
                                    │  P1: returning      │
                                    │  P2: new session    │
                                    └────────┬────────────┘
                                             │
                                    ┌────────▼────────────┐
                                    │   Worker Pool (N)    │
                                    │                      │
                                    │  executeTool()       │
                                    │  15s timeout         │
                                    │  circuit breaker     │
                                    └──────────────────────┘
```

- **P0 (mid-lesson):** Student already has an active conversation with recent messages. Highest priority.
- **P1 (returning):** Student's first message after idle period. Pre-warm context from DB.
- **P2 (new session):** Brand new conversation. Lowest priority during spikes.

**Backpressure:** If the queue depth exceeds a threshold (e.g., 100 pending), new P2 requests get a `503 Retry-After: 5` response. P0 and P1 are never shed.

### Phase 3: Warm Session Pool (Recess Spike)

The recess pattern is predictable: 200 students resume at 2:15 PM.

```
2:10 PM — Pre-warm trigger (configurable per school schedule)
  → For each student with an active conversation:
    → Load conversation context from DB
    → Cache system prompt + last 10 messages in Redis (TTL: 15 min)
    → Pre-resolve tool manifests for the classroom's enabled apps

2:15 PM — Students return
  → First message hits cached context instead of cold DB + prompt assembly
  → Estimated cold start: 200ms → warm start: 30ms
```

### Phase 4: Circuit Breaking on Third-Party Tools

Every tool call gets a hard 15-second timeout:

```typescript
const result = await Promise.race([
  executeTool(toolName, params),
  new Promise((_, reject) => setTimeout(() => reject(new Error('TOOL_TIMEOUT')), 15_000))
])

if (result instanceof Error) {
  // Synthesize failure result for the LLM
  return {
    error: true,
    message: `The ${appName} app did not respond within 15 seconds. ` +
             `Please let the student know and continue the lesson without the app.`
  }
}
```

The LLM receives this as the tool result and generates a graceful text response:
> "I tried to open the chess board but it's not responding right now. Let's continue with our math lesson — we can try chess again later!"

After 3 consecutive timeouts, the circuit breaker trips (`isBlocked` = true), and the tool is removed from the AI's tool list entirely until health polling recovers it.

## Implementation Plan

| Phase | Effort | Impact | Dependencies |
|-------|--------|--------|-------------|
| Hard 15s timeout on tool execution | Small | High | None |
| Synthesize failure result for LLM | Small | High | Timeout |
| Circuit breaker in completions path | Small | Medium | Existing `health.ts` |
| Resume token + checkpoint | Medium | High | Redis, client-side handler |
| Priority queue | Medium | High | BullMQ or similar |
| Warm session pool | Medium | Medium | Redis, school schedule config |
| Pre-warm trigger | Small | Medium | Cron or webhook |

### Quick Wins (can ship today)

1. **15s timeout** on `executeChatbridgeTool` in `chatbridge-completions.ts`
2. **Synthesized failure result** when timeout fires
3. **`isBlocked` check** before tool execution in completions path (currently only checked at listing time)
4. **SSE heartbeat** — write `:\n\n` (SSE comment) every 5s during tool execution to keep the connection alive and prevent proxy timeouts

## Files to Modify

| File | Change |
|------|--------|
| `chatbridge-completions.ts:543-550` | Wrap `executeChatbridgeTool` in `Promise.race` with 15s timeout |
| `chatbridge-completions.ts:537` | Add `isBlocked(appId)` check before tool execution |
| `chatbridge-completions.ts:464-590` | Add SSE heartbeat during blocking phases |
| `chatbridge-completions.ts` (new) | Add `/chatbridge/completions/resume` endpoint |
| `apps/health.ts` | Expose `recordFailure`/`recordSuccess` for completions path |
| `lib/queue.ts` (new) | Priority queue with BullMQ |
| `lib/session-pool.ts` (new) | Warm session cache in Redis |
