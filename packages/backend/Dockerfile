FROM node:22-alpine AS base

WORKDIR /app

# Install pnpm (npm is more reliable than corepack on Railway)
RUN npm install -g pnpm@10.33.0

# Copy lockfile + workspace config for deterministic installs
COPY pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/apps-chess/package.json ./packages/apps-chess/
COPY packages/apps-weather/package.json ./packages/apps-weather/
COPY packages/apps-spotify/package.json ./packages/apps-spotify/

# Create workspace config (backend + shared + mini-apps only)
RUN printf 'packages:\n  - packages/shared\n  - packages/backend\n  - packages/apps-chess\n  - packages/apps-weather\n  - packages/apps-spotify\n' > pnpm-workspace.yaml
RUN printf '{"private":true}\n' > package.json

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/backend/ ./packages/backend/
COPY packages/apps-chess/ ./packages/apps-chess/
COPY packages/apps-weather/ ./packages/apps-weather/
COPY packages/apps-spotify/ ./packages/apps-spotify/

# Copy pre-built frontend (built locally, not in Docker — avoids Electron deps)
COPY release/app/dist/renderer/ ./frontend/

# Generate Prisma client
RUN cd packages/backend && npx prisma generate

# Build mini-apps (static HTML/JS bundles served by backend)
RUN cd packages/apps-chess && npx vite build || true
RUN cd packages/apps-weather && npx vite build || true
RUN cd packages/apps-spotify && npx vite build || true

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/api/v1/health || exit 1

# Frontend SPA served from /app/frontend
ENV FRONTEND_DIST_PATH=/app/frontend

EXPOSE 3001

# Run migrations then start server
CMD cd packages/backend && npx prisma migrate deploy && npx tsx src/server.ts
