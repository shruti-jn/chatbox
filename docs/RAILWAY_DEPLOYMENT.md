# Railway Deployment Plan

## Architecture on Railway

```
┌─────────────────────────────────────────────┐
│                Railway Project               │
│                                              │
│  ┌──────────────────┐  ┌─────────────────┐  │
│  │  chatbridge-api  │  │  chatbridge-web  │  │
│  │  (Fastify + WS)  │  │  (Static SPA)   │  │
│  │  Port: $PORT     │  │  Port: $PORT     │  │
│  │  Custom domain:  │  │  Custom domain:  │  │
│  │  api.chatbridge  │  │  app.chatbridge  │  │
│  └────────┬─────────┘  └────────┬─────────┘  │
│           │                      │             │
│  ┌────────▼─────────┐  ┌───────▼──────────┐  │
│  │   PostgreSQL 16   │  │    Redis 7       │  │
│  │   (Railway DB)    │  │   (Railway KV)   │  │
│  └──────────────────┘  └──────────────────┘  │
│                                              │
│  ┌──────────────────┐                        │
│  │    Langfuse       │  (Optional — can use  │
│  │  (Docker image)   │   cloud.langfuse.com) │
│  └──────────────────┘                        │
└─────────────────────────────────────────────┘
```

## Services (4)

### 1. chatbridge-api (Backend)

**Source:** `packages/backend/`
**Build:** Dockerfile (multi-stage: install → build → run)
**Runtime:** `node dist/server.js`

Handles:
- 33 REST API endpoints
- 3 WebSocket endpoints (/ws/chat, /ws/mission-control, /ws/collab)
- Prisma ORM → PostgreSQL
- Redis for pub/sub, rate limiting, session cache
- Mini-app static files (chess, weather, spotify UIs)

### 2. chatbridge-web (Frontend)

**Source:** `release/app/dist/renderer/`
**Build:** `pnpm run build:renderer`
**Runtime:** Static file server with SPA fallback

OR: serve from the API service via `FRONTEND_DIST_PATH` env var (simpler, one fewer service).

### 3. PostgreSQL 16 (Railway managed)

- Railway provisions this automatically
- Provides `DATABASE_URL` as an env var
- Need a second restricted-privilege user for RLS (`chatbridge_app`)

### 4. Redis 7 (Railway managed)

- Railway provisions this automatically
- Provides `REDIS_URL` as an env var

---

## Step-by-Step Deployment

### Phase 1: Fix the Dockerfile

The current Dockerfile uses `tsx` (dev runner). Fix for production:

```dockerfile
# packages/backend/Dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies (deterministic)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/shared/package.json packages/shared/
COPY packages/apps-chess/package.json packages/apps-chess/
COPY packages/apps-weather/package.json packages/apps-weather/
COPY packages/apps-spotify/package.json packages/apps-spotify/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/backend/ packages/backend/
COPY packages/apps-chess/ packages/apps-chess/
COPY packages/apps-weather/ packages/apps-weather/
COPY packages/apps-spotify/ packages/apps-spotify/

# Build
RUN pnpm --filter @chatbridge/shared build
RUN pnpm --filter @chatbridge/backend build
RUN pnpm --filter apps-chess build
RUN pnpm --filter apps-weather build
RUN pnpm --filter apps-spotify build

# Generate Prisma client
RUN cd packages/backend && npx prisma generate

# Production image
FROM node:22-alpine AS production
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/backend/dist ./packages/backend/dist
COPY --from=base /app/packages/backend/prisma ./packages/backend/prisma
COPY --from=base /app/packages/backend/package.json ./packages/backend/
COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/packages/apps-chess/dist ./packages/apps-chess/dist
COPY --from=base /app/packages/apps-weather/dist ./packages/apps-weather/dist
COPY --from=base /app/packages/apps-spotify/dist ./packages/apps-spotify/dist

ENV NODE_ENV=production
EXPOSE 3001

# Run migrations then start server
CMD cd packages/backend && npx prisma migrate deploy && node dist/server.js
```

### Phase 2: Create Railway Project

```bash
# Install Railway CLI
brew install railway

# Login
railway login

# Create project
railway init --name chatbridge-v2

# Add PostgreSQL
railway add --plugin postgresql

# Add Redis
railway add --plugin redis
```

### Phase 3: Configure Environment Variables

Set these in the Railway dashboard (Settings → Variables):

```
# Railway auto-provides DATABASE_URL and REDIS_URL for managed services
# Override DATABASE_URL for Prisma migrations (superuser):
DATABASE_URL=${{Postgres.DATABASE_URL}}

# App-level DB URL with restricted role (create after migration):
DATABASE_URL_APP=postgresql://chatbridge_app:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}

REDIS_URL=${{Redis.REDIS_URL}}

# Secrets (set manually)
ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET_KEY=<generate: openssl rand -hex 32>
OPENWEATHER_API_KEY=...
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...

# Langfuse (use cloud or self-host)
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com

# App config
NODE_ENV=production
HOST=0.0.0.0
PORT=${{RAILWAY_PORT}}
CORS_ORIGINS=https://app.chatbridge.dev,https://chatbridge.up.railway.app
```

### Phase 4: Set Up RLS Database User

After first deploy (migrations run automatically), create the restricted user:

```bash
# Connect to Railway Postgres
railway connect postgresql

# In psql:
CREATE ROLE chatbridge_app WITH LOGIN PASSWORD '<same as Postgres password>';
GRANT CONNECT ON DATABASE railway TO chatbridge_app;
GRANT USAGE ON SCHEMA public TO chatbridge_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO chatbridge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chatbridge_app;

# Apply RLS policies
\i packages/backend/prisma/rls-policies.sql
```

### Phase 5: Deploy Frontend

Two options:

**Option A: Serve from API (simplest)**
```
FRONTEND_DIST_PATH=/app/frontend
```
Copy the built renderer into the Docker image and the server.ts SPA handler serves it.

**Option B: Separate static service**
```bash
# In Railway dashboard, add a new service
# Source: release/app/dist/renderer/
# Build command: pnpm run build:renderer
# Start command: npx serve -l $PORT --cors --single
```

### Phase 6: Custom Domain + HTTPS

Railway provides free HTTPS on `*.up.railway.app` domains. For custom:

1. Add custom domain in Railway dashboard
2. Set DNS CNAME to `<project>.up.railway.app`
3. Update `CORS_ORIGINS` to include the custom domain
4. Update Spotify OAuth redirect URI to `https://api.chatbridge.dev/api/v1/auth/oauth/spotify/callback`

---

## Pre-Deploy Checklist

| Step | Command | Notes |
|------|---------|-------|
| Build locally | `docker build -f packages/backend/Dockerfile -t chatbridge-api .` | Verify it builds |
| Test locally | `docker run -p 3001:3001 --env-file .env chatbridge-api` | Verify it starts |
| Migrations | `npx prisma migrate deploy` | Verify migrations apply cleanly |
| RLS policies | `psql < prisma/rls-policies.sql` | Apply after migrations |
| Seed data | `npx prisma db seed` | Optional — dev data |
| Health check | `curl https://<domain>/api/v1/health` | All capabilities "up" |
| Chess app | `curl https://<domain>/api/v1/apps/chess/ui/` | HTML with <script> tag |
| Swagger | `https://<domain>/docs` | Loads and shows all routes |
| WebSocket | `wscat -c wss://<domain>/api/v1/ws/chat?token=<jwt>` | Connects without error |

## Estimated Cost (Railway)

| Service | Plan | Cost |
|---------|------|------|
| chatbridge-api | Hobby ($5/mo) | ~$5-10/mo |
| PostgreSQL | Hobby (1GB) | Included |
| Redis | Hobby (25MB) | Included |
| Frontend (if separate) | Static | ~$0-5/mo |
| **Total** | | **~$5-15/mo** |

## Monitoring

- **Health:** `GET /api/v1/health` — checks DB, Redis, Anthropic, Langfuse, Weather
- **Langfuse:** Traces every LLM call with latency, tokens, cost, tool calls
- **Railway metrics:** CPU, memory, network in dashboard
- **Logs:** `railway logs` or dashboard

## What NOT to Deploy

- The Electron desktop app (`src/main/`, `src/renderer/`) — this is a desktop client, not a server
- Test files (`test/`, `test/e2e-browser/`)
- Dev configs (`.env`, `docker-compose.yml`)
- Worktrees (`.claude/worktrees/`)
