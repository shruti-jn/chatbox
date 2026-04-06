# ChatBridge v2 Architecture

## Overview

ChatBridge extends the Chatbox AI client with a K-12 education platform featuring third-party app integration, multi-tenant classrooms, real-time teacher monitoring, and a content safety pipeline. The architecture follows "extend, don't replace" -- Chatbox's existing chat UI, LLM adapters, streaming pipeline, and persistence are preserved unchanged. The backend, database, real-time layer, and app system are added as new modules.

## Core Technology Concepts

### 1. Fastify

The backend is built on Fastify 5 (Node.js/TypeScript), chosen for its schema-first design and plugin architecture. The server lives at `packages/backend/src/server.ts`.

Key design points:
- All routes are registered as Fastify plugins under `packages/backend/src/routes/`
- Request/response validation uses Zod schemas from `@chatbridge/shared` (compiled to JSON Schema for Fastify)
- Swagger UI is auto-generated at `/docs` and OpenAPI spec at `/openapi.json`
- Auth middleware (`@fastify/jwt`) decorates requests with tenant/user context before route handlers execute
- The server exposes 33 REST endpoints and 3 WebSocket endpoints

### 2. PostgreSQL

PostgreSQL 16 is the primary datastore, managed via Prisma ORM. The schema has 19 entities covering users, classrooms, conversations, messages, apps, safety events, consent records, and audit trails.

Key design points:
- Prisma schema at `packages/backend/prisma/schema.prisma`
- Migrations in `packages/backend/prisma/migrations/`
- Seed data in `packages/backend/prisma/seed.ts` (idempotent, uses deterministic UUIDs and upserts)
- Docker Compose exposes Postgres on host port 5433 (container port 5432)
- The database name, user, and password are all `chatbridge` / `chatbridge_dev` in development

### 3. Redis

Redis 7 provides caching, session storage, and real-time pub/sub via ioredis.

Key design points:
- Pub/Sub channels carry WebSocket events between backend instances (chat messages, mission control alerts, collaboration state)
- Session tokens and rate-limit counters use Redis key expiry
- Docker Compose exposes Redis on host port 6380 (container port 6379)
- Tests hit real Redis -- no mocks

### 4. WebSocket

Real-time communication uses `@fastify/websocket` with Redis Pub/Sub for fan-out across backend instances.

Three WebSocket endpoints:
- **`/ws/chat`** -- Student chat streaming. Carries AI response tokens, app state updates, and safety notifications. The client in `src/renderer/packages/chatbridge/websocket-client.ts` handles auto-reconnect with exponential backoff.
- **`/ws/mission-control`** -- Teacher monitoring. Streams a grid of all active student conversations with real-time safety alerts, allowing teachers to whisper (inject guidance) into any conversation.
- **`/ws/collab/:sessionId`** -- Collaborative sessions. Syncs shared app state (e.g., two students analyzing the same chess position).

Message flow: client sends over WebSocket -> backend processes -> backend publishes to Redis Pub/Sub -> all connected backend instances fan out to relevant WebSocket clients.

### 5. ChatBridge Protocol (CBP)

CBP is the communication protocol between the host app and third-party apps running in sandboxed iframes. It uses `window.postMessage` with structured JSON messages.

Message types:
- **`invoke`** (host -> app): LLM called a tool; app should execute it
- **`tool_result`** (app -> host): Result of a tool invocation
- **`state_update`** (app -> host): App state changed (e.g., new chess position). Host injects this into the LLM system prompt so the AI stays aware.
- **`complete`** (app -> host): App finished (e.g., game over). Host stores the summary as a system message in the conversation.
- **`error`** (bidirectional): Something went wrong

Security:
- Iframes use `sandbox="allow-scripts"` -- no access to host cookies, localStorage, or DOM
- Message origin is validated before processing
- Apps cannot escalate privileges; they can only respond to tool invocations and send state updates

The CBP client SDK lives at `src/renderer/packages/chatbridge/cbp-client.ts`. The backend-side CBP handler is at `packages/backend/src/cbp/`.

### 6. Safety Pipeline

Every message passes through a 4-stage sequential pipeline (target: <5s total including LLM call). Located in `packages/backend/src/safety/`.

| Stage | Method | Latency | What It Does |
|-------|--------|---------|-------------|
| 1. PII Detection | Regex | <50ms | Detects phone, email, SSN, address patterns; replaces with `[REDACTED]` |
| 2. Injection Detection | Regex | <20ms | Matches 13 prompt injection patterns; extracts intent |
| 3. LLM Classification | Claude Haiku | <3s | Classifies content as safe/violence/sexual/hate/self_harm/off_topic |
| 4. Crisis Detection | Keyword | <10ms | Always runs regardless of prior stages; returns 988 Lifeline resources if triggered |

Safety events are logged to the `safety_events` table with full context for audit. Teachers see real-time safety alerts in Mission Control.

### 7. Row-Level Security (RLS)

All tenant-scoped tables enforce PostgreSQL Row-Level Security policies. This provides defense-in-depth: even if application code has a bug, one classroom's data cannot leak to another.

Implementation:
- RLS policies are defined in `packages/backend/prisma/rls-policies.sql`
- Applied via migration (`20260403000001_rls_policies`)
- Each request sets `SET LOCAL app.current_classroom_id = ?` at the start of the transaction
- The middleware at `packages/backend/src/middleware/` extracts the classroom ID from the JWT and sets it
- The `apps` table is RLS-exempt (apps are platform-global, not classroom-scoped)
- Tests verify RLS isolation: a query scoped to classroom A cannot see classroom B's data

### 8. Langfuse

Langfuse provides LLM observability -- tracing every AI interaction for cost tracking, latency monitoring, quality evaluation, and debugging.

Key design points:
- Self-hosted Langfuse instance runs via Docker Compose on port 3002
- Integration code at `packages/backend/src/observability/`
- Every AI call (chat completion, safety classification, tool use) is traced with input/output, latency, token counts, and cost
- Traces are tagged with classroom ID and conversation ID for filtering
- The eval harness at `packages/backend/src/eval/` uses Langfuse to score golden dataset scenarios across multiple quality dimensions
- Configure via `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in `.env`

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    Chatbox Renderer (React)                       │
│                                                                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │ Sidebar   │  │ Chat View    │  │ App Frame (iframe)       │   │
│  │           │  │              │  │  sandbox="allow-scripts"  │   │
│  │ Sessions  │  │ MessageList  │  │  ┌────────────────────┐  │   │
│  │ Apps      │  │ MessageInput │  │  │ Third-Party App    │  │   │
│  │           │  │ AppCard      │  │  │ (chess/weather/    │  │   │
│  │           │  │              │  │  │  spotify)           │  │   │
│  └──────────┘  └──────┬───────┘  │  └────────┬───────────┘  │   │
│                        │          │           │ postMessage   │   │
│                        │          │           │ (CBP)         │   │
│                        │          └──────────────────────────┘   │
│  ┌─────────────────────┴──────────────────────────────────────┐  │
│  │              streamText.ts (Tool Pipeline)                  │  │
│  │  tools = {                                                  │  │
│  │    ...mcpController.getAvailableTools(),   // existing      │  │
│  │    ...appsController.getAvailableTools(),  // ChatBridge    │  │
│  │    ...webSearchTools,                      // existing      │  │
│  │  }                                                          │  │
│  └─────────────────────┬──────────────────────────────────────┘  │
│                         │                                         │
│  ┌──────────────────────┴─────────────────────────────────────┐  │
│  │           LLM Provider (Claude Haiku 4.5)                   │  │
│  │           via Vercel AI SDK                                  │  │
│  └──────────────────────┬─────────────────────────────────────┘  │
└──────────────────────────┼────────────────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────┼────────────────────────────────────────┐
│                    Fastify Backend (:3001)                         │
│                                                                    │
│  ┌──────────┐  ┌────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ Auth     │  │ Safety     │  │ AI        │  │ CBP          │  │
│  │ JWT/LTI  │  │ Pipeline   │  │ Service   │  │ Handler      │  │
│  │ RBAC     │  │ (4-stage)  │  │ (stream)  │  │              │  │
│  └────┬─────┘  └─────┬──────┘  └─────┬─────┘  └──────┬───────┘  │
│       │               │               │               │           │
│  ┌────┴───────────────┴───────────────┴───────────────┴───────┐  │
│  │              Routes (33 REST + 3 WebSocket)                 │  │
│  └─────────────────────┬──────────────────────────────────────┘  │
│                         │                                         │
│  ┌──────────┐  ┌───────┴──────┐  ┌──────────┐  ┌─────────────┐  │
│  │ Prisma   │  │ PostgreSQL   │  │ Redis    │  │ Langfuse    │  │
│  │ ORM      │  │ 16 + RLS     │  │ 7       │  │ Tracing     │  │
│  └──────────┘  └──────────────┘  └──────────┘  └─────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

## Data Flow: Chat Message with App Interaction

```
Student sends "Let's play chess"
  |
  v
Frontend -> POST /api/chat/message (or via /ws/chat)
  |
  v
Auth middleware: validate JWT, extract user + classroom ID
  |
  v
RLS middleware: SET LOCAL app.current_classroom_id = <id>
  |
  v
Safety pipeline: PII -> Injection -> LLM Classification -> Crisis
  |
  v
AI service: build prompt (system + app state context + history)
  -> LLM returns tool call: chess__start_game({color: "white"})
  |
  v
CBP handler: forward tool invocation to chess app iframe
  |
  v
Chess app: initializes board, sends state_update (FEN position)
  -> Host injects FEN into system prompt for future turns
  |
  v
Langfuse: trace recorded (input, output, tokens, latency, cost)
  |
  v
Response streamed to student via WebSocket
Mission Control notified via Redis Pub/Sub -> /ws/mission-control
```

## App Lifecycle — Registration, Invocation, State Sync, Teardown

Third-party apps are **asynchronous participants**, not synchronous tool calls. The backend owns lifecycle truth. The frontend renders state and forwards events but does not own workflow correctness.

### Instance States (FSM)

The authoritative state machine is defined in `packages/backend/src/apps/lifecycle.ts`. Six states, event-driven transitions:

```
loading ──activate──→ active ──suspend──→ suspended ──resume──→ active
                        │                                         │
                        ├──complete──→ collapsed                  │
                        │                                         │
                        ├──fail──→ error ──terminate──→ terminated│
                        │                                         │
                        └──terminate──→ terminated ←──terminate───┘
```

| State | Meaning |
|-------|---------|
| `loading` | App instance created, iframe loading |
| `active` | App running, receiving state updates |
| `suspended` | Paused (another app took focus, or user navigated away) |
| `collapsed` | Successfully completed (game over, playlist created) |
| `error` | Unrecoverable failure |
| `terminated` | Cleaned up, no longer active |

Only the backend transitions state authoritatively. Frontend and app events are inputs, not truth. Every transition is validated by the FSM — invalid transitions (e.g., `terminated → active`) throw `InvalidTransitionError`.

### State Freshness Contract

Every AI context injection includes state metadata (when an app is active or stale):

| Field | Values |
|-------|--------|
| `stateSource` | `app_reported`, `not_received` |
| `stateFreshnessMs` | milliseconds since last update |
| `confidence` | `fresh` (<30s), `stale` (>30s), `missing` |
| `lastSuccessfulSyncAt` | ISO timestamp |

Note: suspended apps receive no freshness metadata — only a text note that the app is paused.

**AI behavior by confidence:**
- **fresh**: Reference state confidently
- **stale**: Hedge — "Based on the last position I saw..."
- **missing**: "I can't see the board right now. Can you describe what you see?"

### State Sync Flow

```
Chess iframe → postMessage (state_update)
  → cbp-client.ts validates + forwards via WebSocket
  → websocket.ts: handleAppStateUpdate()
    → Redis publish (cbp:state:{instanceId})
    → DB persist (appInstance.stateSnapshot)
  → Next chat message:
    → context-builder loads stateSnapshot
    → registry.ts computes freshness + confidence
    → AI system prompt includes state + metadata
```

### Failure Modes and Platform Responsibility

| Failure | Platform Response | FSM Transition |
|---------|-------------------|----------------|
| Tool execution timeout (15s) | Synthesize failure for LLM: "The app did not respond" | `active → error` (planned: SHR-197) |
| 3+ consecutive tool failures | Circuit breaker: tool removed from AI's tool list at `degraded` threshold | Health status only (not an instance transition) |
| 5+ consecutive failures | App marked `unresponsive` in health subsystem | Health status only |
| App stops sending heartbeats | Planned: `active → error → terminated` after silence threshold (SHR-210) | Not yet implemented |
| WebSocket disconnects | State updates silently dropped; no reconnect (SHR-197) | No transition |
| iframe fails to load | Error UI shown; instance should transition to `error` (SHR-197) | Gap: stays `active` |
| Game completes | FSM: `active → collapsed` via `complete` event (SHR-197 to wire) | `active → collapsed` |
| Admin suspends app | Bulk `terminated` + disable in catalog (SHR-197 to add WS notification) | `active → terminated` |
| User navigates away | WS disconnected; instance should `suspend` (SHR-197) | Gap: stays `active` |

### Tool Execution Architecture

Tool calls are decoupled from the SSE connection:
- **15s hard timeout** on every tool execution (`Promise.race`)
- **SSE heartbeat** (`:` comment every 5s) prevents proxy timeouts
- **Circuit breaker** blocks tools after 3 consecutive failures
- **Synthesized failure** when tool times out — LLM degrades gracefully

See `docs/ASYNC_EXECUTION_PLAN.md` for the full resume-token + priority queue design (SHR-198).

## Database Schema (19 Entities)

All tenant-scoped tables have RLS policies. Key entities:

- **users** -- students, teachers, admins with role-based access
- **classrooms** -- multi-tenant boundary; all classroom data is RLS-isolated
- **conversations** -- chat threads within a classroom
- **messages** -- individual messages with sender, content, metadata
- **apps** -- registered third-party apps (platform-global, RLS-exempt)
- **app_states** -- per-conversation app state snapshots
- **safety_events** -- audit log of all safety pipeline triggers
- **consent_records** -- student/parent consent tracking
- **collaboration_sessions** -- shared app sessions between students

## Testing

Tests use real infrastructure (PostgreSQL, Redis, Anthropic API, Langfuse) -- no mocks except for external paid APIs behind a `--live` flag.

- Backend tests: `packages/backend/test/`
- Run: `cd packages/backend && npx vitest run`
- Golden dataset: 20 scenarios scored per-dimension in `packages/backend/src/eval/`
- E2E scenarios: 15 tests covering all 7 brief requirements
