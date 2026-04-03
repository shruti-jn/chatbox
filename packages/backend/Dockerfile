FROM node:22-alpine AS base

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy workspace files + patches
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches/ ./patches/
COPY release/app/package.json ./release/app/
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

# Install dependencies (no frozen lockfile — workspace subset may differ)
RUN pnpm install --filter @chatbridge/backend --filter @chatbridge/shared --no-frozen-lockfile

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/backend/ ./packages/backend/

# Generate Prisma client
RUN cd packages/backend && npx prisma generate

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/health || exit 1

# Start
CMD ["npx", "tsx", "packages/backend/src/server.ts"]
