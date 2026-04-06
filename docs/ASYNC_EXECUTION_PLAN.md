# Async Tool Execution — Final Plan

## Core Principle

Third-party app work is asynchronous and may be arbitrarily slow. The chatbot never waits on app completion inline. The platform persists invocation, state, freshness, and failure as durable lifecycle records. The assistant reasons over those records, including uncertainty when state is stale or missing.

---

## Phase 1: Foundation (ship first)

### 1.1 Hard timeout + synthesized failure [SHIPPED]
- 15s `Promise.race` on every tool execution
- Synthesized failure result for the LLM: "The app did not respond. Continue the lesson."
- SSE heartbeat (`:` comment every 5s) during blocking phases

### 1.2 Canonical lifecycle + state contract
Consolidate `ARCHITECTURE.md`, `CHATBRIDGE.md`, `APP_STATE_LIFECYCLE.md` into one authoritative lifecycle:

**Instance states:**
```
registered → queued → loading → active → suspended → completed → terminated
                                   ↓                      ↑
                              unresponsive → failed ───────┘
```

**Rules:**
- Only the backend may authoritatively transition state
- Frontend and app events are inputs, not truth
- Every transition is timestamped and persisted in `app_instance_events` table

**State contract — required app messages:**

| Message | Direction | When |
|---------|-----------|------|
| `invoke_ack` | app → platform | App received invocation, started loading |
| `state_update` | app → platform | App state changed (FEN, playlist, etc.) |
| `heartbeat` | app → platform | Every 15s while active |
| `complete` | app → platform | Work finished (game over, playlist created) |
| `error` | app → platform | Unrecoverable failure |
| `teardown_ack` | app → platform | App acknowledged termination |

**State freshness metadata (attached to every AI context injection):**

| Field | Type | Example |
|-------|------|---------|
| `stateSource` | enum | `app_reported` or `platform_inferred` |
| `stateFreshnessMs` | number | 3200 |
| `stateVersion` | number | 7 |
| `lastSuccessfulSyncAt` | ISO string | `2026-04-05T16:30:00Z` |
| `confidence` | enum | `fresh`, `stale`, `missing`, `contradictory` |

**AI behavior by confidence:**
- `fresh` (< 30s): Use state normally
- `stale` (30s - 5min): "Based on the last position I saw..." + note uncertainty
- `missing` (no state received): "I can't see the board right now. Can you describe what you see?"
- `contradictory` (app says X, DB says Y): Avoid asserting either; ask student to confirm

### 1.3 Circuit breaker in completions path
Wire `isBlocked(appId)` check before `executeChatbridgeTool`, not just at tool-listing time. Record `recordFailure`/`recordSuccess` after each tool execution on the completions path.

---

## Phase 2: Durable Async Invocations

### 2.1 AppInvocationJob model

```sql
CREATE TABLE app_invocation_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id     UUID REFERENCES app_instances(id),
  conversation_id UUID NOT NULL,
  district_id     UUID NOT NULL,
  request_key     UUID UNIQUE NOT NULL,  -- client idempotency
  tool_name       VARCHAR NOT NULL,
  parameters      JSONB NOT NULL,
  status          VARCHAR NOT NULL DEFAULT 'queued',
    -- queued | running | completed | failed | timed_out
  priority        INTEGER NOT NULL DEFAULT 1,
    -- 0: mid-lesson, 1: returning, 2: new session
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  deadline_at     TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  result          JSONB,
  error_code      VARCHAR,
  retryable       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status ON app_invocation_jobs(status, priority, queued_at);
CREATE INDEX idx_jobs_district ON app_invocation_jobs(district_id);
```

### 2.2 Decoupled SSE flow

```
Client POST /chatbridge/completions
  Header: X-Request-Key: {uuid}
  → AI returns tool_use
  → Create AppInvocationJob (status: queued, deadline: NOW + 15s)
  → Emit SSE: { event: 'tool_pending', data: { jobId, toolName, resumeToken } }
  → reply.raw.end()  ← SSE CLOSED

Worker picks up job
  → status: running, started_at: NOW
  → executeChatbridgeTool() with deadline enforcement
  → On success: status: completed, result: {...}
  → On timeout: status: timed_out, result: synthesized failure
  → On error: status: failed, error_code: '...', retryable: true/false

Client receives 'tool_pending'
  → Shows app card in 'loading' state: "Your chess game is starting..."
  → Subscribes via WS for job completion
    OR polls: GET /chatbridge/jobs/{jobId}

Job completes → WS notification to client
  → Client POST /chatbridge/completions/resume?token={resumeToken}
  → Server reads job result
  → Issues second Anthropic call with tool result
  → Streams follow-up via new SSE connection
  → Client sees seamless continuation
```

### 2.3 Client idempotency

```
POST /chatbridge/completions
  Header: X-Request-Key: {uuid}

Server: SELECT * FROM app_invocation_jobs WHERE request_key = {uuid}
  Found + completed → return cached result immediately
  Found + running → return job status (client can subscribe)
  Not found → create new job
```

Network retries during recess spike → no duplicate chess games.

---

## Phase 3: Burst Protection

### 3.1 Per-app queue with concurrency caps

| Config | Default | Configurable per app |
|--------|---------|---------------------|
| Per-app concurrency | 20 | Yes (in `App.permissions`) |
| Queue depth before P2 shedding | 100 | Yes |
| Queue depth before all shedding | 500 | Yes |
| Retry-After header on shed | 3-10s with jitter | Fixed |

### 3.2 Priority assignment

```typescript
function assignPriority(conversationId: string, districtId: string): 0 | 1 | 2 {
  // P0: student has sent a message in the last 5 minutes (mid-lesson)
  const recentActivity = await hasRecentMessage(conversationId, 5 * 60 * 1000)
  if (recentActivity) return 0

  // P1: student has an existing conversation (returning)
  const hasConversation = await conversationExists(conversationId)
  if (hasConversation) return 1

  // P2: brand new session
  return 2
}
```

### 3.3 Backpressure policy

| Queue state | Action |
|-------------|--------|
| Healthy (depth < 100) | Accept and enqueue |
| Saturated (100-500) | Shed P2, accept P0/P1 with honest delay: "Your chess game is queued. Starting in ~10 seconds." |
| Overloaded (> 500) | Shed P1+P2, only P0 accepted. Others get `503 Retry-After: 5` |
| App degraded (circuit open) | Stop dispatching. Surface "temporarily unavailable" |

### 3.4 Warm session pool (recess spike)

```
2:10 PM — Pre-warm trigger
  → For each student with conversation updated in last 2 hours:
    → Cache system prompt + last 10 messages in Redis (TTL: 15 min, key: session:{convId})
    → Pre-resolve tool manifests for classroom's enabled apps

2:15 PM — Students return
  → POST /chatbridge/completions checks Redis cache first
  → Cache hit: skip DB queries for context loading
  → Cold start: 200ms → warm start: 30ms
```

Trigger via: cron job, webhook from school schedule API, or manual `POST /admin/pre-warm`.

---

## Phase 4: Watchdogs + Recovery

### 4.1 Heartbeat watchdog

| App type | Expected heartbeat | Silence → unresponsive | Silence → terminated |
|----------|-------------------|----------------------|---------------------|
| Chess | Every 15s during active play | 60s | 5 min |
| Spotify | Every 15s during playlist creation | 30s | 2 min |
| Default | Every 15s | 60s | 5 min |

Background job (runs every 10s):
```sql
UPDATE app_instances SET status = 'unresponsive'
WHERE status = 'active'
  AND last_heartbeat_at < NOW() - INTERVAL '60 seconds';

UPDATE app_instances SET status = 'terminated', terminated_at = NOW()
WHERE status = 'unresponsive'
  AND last_heartbeat_at < NOW() - INTERVAL '5 minutes';
```

### 4.2 Job timeout sweeper (runs every 5s)

```sql
UPDATE app_invocation_jobs
SET status = 'timed_out', completed_at = NOW(),
    result = '{"error": true, "message": "The app did not respond in time."}'
WHERE status = 'running'
  AND deadline_at < NOW();
```

### 4.3 Session TTL sweeper (runs every 1 min)

```sql
UPDATE app_instances SET status = 'terminated', terminated_at = NOW()
WHERE status IN ('active', 'suspended')
  AND updated_at < NOW() - INTERVAL '8 hours';  -- JWT TTL
```

### 4.4 Dead-letter queue
Failed jobs with `retryable = false` or `attempt_count >= max_attempts` move to `app_invocation_jobs_dead` for diagnosis. Never silently dropped.

---

## Phase 5: Verification

### Burst test
- 200 concurrent `POST /chatbridge/completions`, all triggering `tool_use`
- **Pass criteria:** 0 dropped responses, p99 < 30s, queue drains within 2 minutes

### Slow app test
- Tool execution takes 10s (injected delay)
- **Pass criteria:** Chat response returns within 2s (tool_pending event), tool result arrives via WS, follow-up streams within 12s total

### Lost heartbeat test
- App stops sending heartbeats after 3 state_updates
- **Pass criteria:** Instance transitions to `unresponsive` within 60s, `terminated` within 5 min

### Recess simulation
- 0 active students → 200 students in 30 seconds
- Pre-warm enabled at T-5min
- **Pass criteria:** p50 first-response < 500ms, p99 < 3s, 0 errors

---

## Files to Create/Modify

| File | Phase | Change |
|------|-------|--------|
| `docs/ARCHITECTURE.md` | 1 | Canonical lifecycle, replace split narrative |
| `prisma/schema.prisma` | 2 | `AppInvocationJob` model |
| `src/routes/chatbridge-completions.ts` | 2 | Checkpoint + resume token flow |
| `src/routes/chatbridge-jobs.ts` (new) | 2 | `GET /chatbridge/jobs/:id`, `POST /completions/resume` |
| `src/lib/job-queue.ts` (new) | 2 | BullMQ wrapper with priority + concurrency |
| `src/lib/session-pool.ts` (new) | 3 | Redis-backed warm session cache |
| `src/workers/tool-executor.ts` (new) | 2 | Job worker: execute tool, enforce deadline |
| `src/workers/watchdog.ts` (new) | 4 | Heartbeat + timeout + TTL sweepers |
| `src/middleware/idempotency.ts` (new) | 2 | X-Request-Key dedup |
