# ChatBridge v2

A K-12 AI chat platform with third-party app integration, built as a fork of [Chatbox](https://github.com/chatboxai/chatbox). Educational apps (Chess, Spotify, Weather) live inside the chat conversation -- students interact with them while the AI remains aware of app state. Teachers control everything via Mission Control.

## Architecture Overview

ChatBridge extends Chatbox's Electron + React desktop client with a full backend stack and an iframe-based app integration protocol.

| Layer | Technology |
|-------|-----------|
| Frontend | Chatbox (Electron + React + Vite + TypeScript) |
| Backend | Fastify 5 (Node.js/TypeScript) |
| Database | PostgreSQL 16 with Row-Level Security |
| Cache/PubSub | Redis 7 (ioredis) |
| LLM | Anthropic Claude Haiku 4.5 via Vercel AI SDK |
| Real-time | WebSocket (@fastify/websocket + Redis Pub/Sub) |
| Auth | LTI 1.3 (ltijs) + JWT + OAuth2 |
| Observability | Langfuse (self-hosted) |
| Testing | Vitest (real DB, no mocks) |

Third-party apps run in sandboxed iframes and communicate with the host via the ChatBridge Protocol (CBP), a JSON-over-postMessage protocol. The LLM sees app state through system prompt injection and invokes apps through tool calling -- the same mechanism as Chatbox's MCP integration.

For the full architecture deep-dive, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Monorepo Structure

```
chatbox/                    # Chatbox fork (branch v2)
├── src/                    # Chatbox frontend (Electron + React)
│   └── renderer/
│       ├── components/message-parts/
│       │   └── AppCardPartUI.tsx    # Iframe app card renderer
│       └── packages/chatbridge/
│           ├── cbp-client.ts        # CBP postMessage handler
│           └── websocket-client.ts  # Auto-reconnect WS client
├── packages/
│   ├── shared/             # @chatbridge/shared -- Zod schemas
│   ├── backend/            # @chatbridge/backend -- Fastify API
│   │   ├── src/
│   │   │   ├── ai/         # AI service (streaming, tool use)
│   │   │   ├── cbp/        # ChatBridge Protocol handler
│   │   │   ├── eval/       # Golden dataset + eval harness
│   │   │   ├── middleware/  # Auth (JWT/RBAC), RLS
│   │   │   ├── observability/ # Langfuse tracing
│   │   │   ├── routes/     # API routes (33 REST + 3 WS)
│   │   │   ├── safety/     # 4-stage content safety pipeline
│   │   │   └── server.ts   # Fastify entry point
│   │   ├── test/           # Tests (real DB, no mocks)
│   │   └── prisma/         # Schema (19 entities) + RLS policies
│   ├── sdk/                # @chatbridge/sdk -- Developer SDK
│   ├── apps-chess/         # Chess app (iframe bundle)
│   ├── apps-spotify/       # Spotify app (OAuth + playlist)
│   └── apps-weather/       # Weather app (dashboard)
├── specs/                  # Factory spec artifacts
├── docs/                   # Architecture and project docs
├── docker-compose.yml      # Postgres 16 + Redis 7 + Langfuse
└── .env.example            # Environment variable template
```

## Quick Start

### Prerequisites

- **Node.js** v20.x -- v22.x ([download](https://nodejs.org/))
- **pnpm** v10.x+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Docker** and **Docker Compose** ([download](https://www.docker.com/))
- **Git** ([download](https://git-scm.com/))

### Setup

```bash
# 1. Clone and checkout v2
git clone https://github.com/chatboxai/chatbox.git
cd chatbox
git checkout v2

# 2. Copy env template and fill in your keys
cp .env.example .env
# Edit .env -- at minimum set ANTHROPIC_API_KEY
# Note: Docker exposes Postgres on port 5433 and Redis on port 6380.
# The DATABASE_URL and REDIS_URL in .env.example use default ports (5432/6379).
# If connecting from the host, update them:
#   DATABASE_URL=postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge
#   REDIS_URL=redis://localhost:6380

# 3. Start infrastructure (Postgres 16, Redis 7, Langfuse)
docker compose up -d

# 4. Install dependencies
pnpm install

# 5. Run database migrations and seed
cd packages/backend
npx prisma migrate deploy
npx prisma db seed
# Apply RLS policies:
cat prisma/rls-policies.sql | docker exec -i chatbox-postgres-1 psql -U chatbridge -d chatbridge

# 6. Start the backend
npx tsx src/server.ts
# Backend runs at http://localhost:3001
# Swagger UI at http://localhost:3001/docs

# 7. Start the frontend (in a separate terminal, from repo root)
cd ../..
pnpm run dev
# Electron app opens with hot-reload
```

### Running Tests

```bash
cd packages/backend
npx vitest run
```

Tests hit real PostgreSQL and Redis (via Docker) -- no mocks. Ensure `docker compose up -d` is running before testing.

For any live AI-backed verification, always load the repo `.env` into the test process first instead of assuming `ANTHROPIC_API_KEY` is already exported in your shell. Otherwise the backend test setup may fall back to a placeholder key and give misleading `401 invalid x-api-key` failures.

```bash
set -a && source ./.env && set +a
pnpm --filter @chatbridge/backend exec vitest run test/apps.test.ts test/whisper.test.ts test/rls.test.ts
```

### Browser Verification (Playwright)

Use Playwright for live E2E verification against the running server. This tests real HTTP round-trips, screenshots API responses, and validates app UIs in a real browser.

```bash
# 1. Ensure infrastructure + backend are running
docker compose up -d
cd packages/backend
set -a && source ../../.env && set +a
npx tsx src/server.ts &

# 2. Build the chess app (required for iframe serving)
cd ../apps-chess
pnpm run build
cd ../backend

# 3. Run Playwright E2E tests
cd test/e2e-browser
npx playwright test --reporter=list

# Run a specific spec:
npx playwright test shr114-chat-routes.spec.ts
npx playwright test chess-app-browser.spec.ts
```

Screenshots are saved to `test/e2e-browser/screenshots/`. The Playwright config at `test/e2e-browser/playwright.config.ts` can auto-start the backend, but it's simpler to run it yourself.

**What's tested:**
- `shr114-chat-routes.spec.ts` -- Chat API round-trips (POST message, pagination, whisper filtering, tenant isolation, app-card content parts, Swagger UI)
- `chess-app-browser.spec.ts` -- Chess app in-browser (CBP state_update payload, difficulty selector UI, reload/reconnect recovery)

## Development Workflow

### Day-to-Day

1. `docker compose up -d` -- ensure infra is running
2. `cd packages/backend && npx tsx src/server.ts` -- start backend
3. `pnpm run dev` (from repo root) -- start Electron frontend with hot-reload
4. Make changes; frontend hot-reloads, backend restarts via `tsx watch` if using `pnpm dev` in `packages/backend`

### Build Commands

| Command | Where | Description |
|---------|-------|-------------|
| `pnpm run dev` | root | Start Electron frontend in dev mode |
| `pnpm run build` | root | Production build (no packaging) |
| `pnpm run package` | root | Build and package for current platform |
| `pnpm run lint` | root | Run Biome code quality checks |
| `pnpm run test` | root | Run Vitest test suite |
| `npx tsx src/server.ts` | packages/backend | Start Fastify backend |
| `npx vitest run` | packages/backend | Run backend tests |
| `npx prisma migrate deploy` | packages/backend | Apply database migrations |
| `npx prisma db seed` | packages/backend | Seed database with test data |

### Adding a New App

Apps are iframe bundles in `packages/apps-*/`. Each app has a `manifest.json` with tool definitions, an `index.html` entry point, and uses the CBP client SDK to communicate with the host. See `packages/apps-chess/` for a reference implementation.

## API Documentation

The Fastify backend exposes full API documentation:

- **Swagger UI**: [http://localhost:3001/docs](http://localhost:3001/docs) -- interactive endpoint explorer
- **OpenAPI spec**: [http://localhost:3001/openapi.json](http://localhost:3001/openapi.json) -- machine-readable schema

### Endpoints Summary (36 total)

**REST (33 routes):** Auth (LTI launch, JWT, OAuth), Chat (send message with safety + AI, history, conversations), Apps (register, invoke tool, update state, submit review), Classrooms (CRUD, config, app toggle, whisper), Collaboration (create/join/close sessions), Admin (suspend app, safety events, audit trail), Consent, Analytics, Health (capability-aware).

**WebSocket (3 endpoints):**
- `/ws/chat` -- Student chat streaming + app state
- `/ws/mission-control` -- Teacher monitoring grid + alerts
- `/ws/collab/:sessionId` -- Collaborative session sync

## Upstream Chatbox

This project is a fork of [Chatbox Community Edition](https://github.com/chatboxai/chatbox) (GPLv3). The Chatbox Electron shell, React UI, LLM adapters, and streaming pipeline are preserved. ChatBridge adds the backend, database, real-time infrastructure, safety pipeline, and app integration layer on top.

## License

[GPLv3](./LICENSE)
