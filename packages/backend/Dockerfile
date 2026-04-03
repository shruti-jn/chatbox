FROM node:22-alpine AS base

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy only backend + shared packages (not root Chatbox which needs Electron)
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

# Create minimal workspace config (backend only, no Chatbox root)
RUN echo 'packages:\n  - packages/shared\n  - packages/backend' > pnpm-workspace.yaml
RUN echo '{"private":true}' > package.json

# Install dependencies
RUN pnpm install --no-frozen-lockfile

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
