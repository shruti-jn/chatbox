# ChatBridge v2 — Architecture Overview

> **Canonical reference:** See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full architecture including app lifecycle, state freshness contract, and tool execution model.

## What This Is

ChatBridge v2 is a K-12 AI chat platform with third-party app integration, built on the Chatbox fork. Educational apps (Chess, Spotify, Weather) live inside the chat conversation — students interact with them while the AI remains aware of app state. Teachers control everything via Mission Control.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Chatbox (Electron + React + Vite + TypeScript) |
| Backend | Fastify 5 (Node.js/TypeScript) |
| Database | PostgreSQL 16 with Row-Level Security |
| Cache/PubSub | Redis 7 (ioredis) |
| LLM | Anthropic Claude Haiku 4.5 via Vercel AI SDK |
| Real-time | WebSocket (@fastify/websocket + Redis Pub/Sub) |
| Auth | LTI 1.3 (ltijs) + JWT + OAuth2 |
| Observability | Langfuse (US cloud) |
| Testing | Vitest (74 tests, real DB, no mocks) |
| Deployment | Railway |

## Monorepo Structure

```
chatbox/                    # Chatbox fork (branch v2)
├── src/                    # Chatbox source (Electron + React)
│   └── renderer/
│       ├── components/message-parts/
│       │   └── AppCardPartUI.tsx    # Iframe app card renderer
│       └── packages/chatbridge/
│           ├── cbp-client.ts        # CBP postMessage handler
│           └── websocket-client.ts  # Auto-reconnect WS client
├── packages/
│   ├── shared/             # @chatbridge/shared — Zod schemas
│   ├── backend/            # @chatbridge/backend — Fastify API
│   │   ├── src/
│   │   │   ├── ai/         # AI service (streaming, tool use)
│   │   │   ├── cbp/        # ChatBridge Bridge Protocol handler
│   │   │   ├── eval/       # Golden dataset + eval harness
│   │   │   ├── middleware/  # Auth (JWT/RBAC), RLS
│   │   │   ├── observability/ # Langfuse tracing
│   │   │   ├── routes/     # API routes (33 REST + 3 WS)
│   │   │   ├── safety/     # 4-stage content safety pipeline
│   │   │   └── server.ts   # Fastify entry point
│   │   ├── test/           # 74 tests (8 files)
│   │   └── prisma/         # Schema (19 entities) + RLS policies
│   ├── sdk/                # @chatbridge/sdk — Developer SDK
│   ├── apps-chess/         # Chess app (iframe bundle)
│   ├── apps-spotify/       # Spotify app (OAuth + playlist)
│   └── apps-weather/       # Weather app (dashboard)
├── specs/                  # Factory spec artifacts (L-080)
├── docker-compose.yml      # Postgres 16 + Redis 7
└── .env.example            # Environment variables
```

## API Endpoints (36 total)

### REST (33 routes)
- **Auth**: LTI launch, JWT login, OAuth Spotify, /me
- **Chat**: Send message (with safety + AI), history, create conversation
- **Apps**: Register, invoke tool, update state, submit review
- **Classrooms**: CRUD, config, app toggle, whisper
- **Collaboration**: Create session, join, close
- **Admin**: Suspend app, safety events, audit trail, tool invocations
- **Consent**: Request, delete
- **Analytics**: Per-classroom metrics
- **Health**: Capability-aware (L-002)

### WebSocket (3 endpoints)
- `/ws/chat` — Student chat streaming + app state
- `/ws/mission-control` — Teacher monitoring grid + alerts
- `/ws/collab/:sessionId` — Collaborative session sync

## AI Proxy Route (Deviation Note)

The `/api/v1/ai/proxy/*` route forwards Chatbox requests to Anthropic with the
4-stage safety pipeline interposed. Chatbox's `ChatBridgeProvider` uses the
Anthropic SDK pointed at this endpoint, so every message flows through safety
automatically. This is the V1 architecture — V2 will migrate to WebSocket-based
streaming. The route is NOT removed because it is load-bearing: the model
provider (`src/shared/providers/definitions/models/chatbridge.ts`), the safety
pipeline, and the E2E tests (`packages/backend/test/e2e-browser/chatbridge.spec.ts`)
all depend on it.

## Safety Architecture (4-Stage Pipeline)

Every message crosses 4 sequential stages (<5s total with LLM):

1. **PII Detection** (regex, <50ms) — Phone, email, SSN, address → [REDACTED]
2. **Injection Detection** (regex, <20ms) — 13 patterns, intent extraction
3. **LLM Classification** (Haiku, <3s) — safe/violence/sexual/hate/self_harm/off_topic
4. **Crisis Detection** (keyword, <10ms) — ALWAYS runs, returns 988 resources

## Database (19 Entities, RLS)

All tenant-scoped tables have Row-Level Security policies using `SET LOCAL` per transaction. The `apps` table is RLS-exempt (platform-global).

## Testing (74 Tests, Zero Mocks)

- **Real PostgreSQL** with RLS isolation tests
- **Real Redis** for Pub/Sub
- **Real Anthropic Haiku** for AI and safety classification
- **Real Langfuse** for trace verification
- **20 golden dataset** scenarios scored per-dimension
- **15 E2E scenario** tests covering all 7 brief requirements

## Quick Start

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Install dependencies  
pnpm install

# 3. Set up database
cd packages/backend
cp ../../.env.example ../../.env  # Edit with your keys
npx prisma db push
# Apply RLS: cat prisma/rls-policies.sql | docker exec -i chatbox-postgres-1 psql -U chatbridge -d chatbridge

# 4. Start backend
npx tsx src/server.ts
# → http://localhost:3001/docs (Swagger UI)

# 5. Start frontend
cd ../..
pnpm run dev
# → Electron app opens

# 6. Run tests
cd packages/backend
npx vitest run
```
