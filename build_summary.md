# ChatBridge v2 Build Summary

## Entry 1 — 2026-04-05 — GAP fixes: GitHub app wiring + deployment setup

### WHAT
- Built `packages/apps-github/dist/` (was unbuilt; GitHub app UI was never served)
- Fixed `generateToolResult` for `get_repos`/`get_recent_activity` to return full `GitHubData` shape (`username`, `repos`, `activity`) using `getGitHubData()`
- Fixed bug in `services/github.ts`: `getGitHubData` was passing token string where `getUserRepos`/`getRecentActivity` expected `userId` — added `fetchGitHubDataWithToken()` internal function
- Added `@fastify/static` import to `packages/backend/src/server.ts` and `packages/backend/package.json`
- Added `FRONTEND_DIST_PATH` support in `buildServer()` so backend can serve the SPA in production
- Added GitHub app (`00000000-0000-4000-e000-000000000004`) to `registerBuiltInApps()` in `server.ts`
- Added GitHub app to `prisma/seed.ts` IDs, upsert, and DistrictAppCatalog
- Added `pendingData` storage in `app-card-processor.ts` — tool result data (minus `__cbApp`) is stored in app-card `stateSnapshot.pendingData` so the iframe can receive it
- Updated `AppCardPartUI.tsx` bootstrap effect to send `show_github_data` when `pendingData` is set (pre-fetched data flow)
- Updated `completeGitHubAuth` in `AppCardPartUI.tsx` to dispatch `show_github_data` with pending data 300ms after `auth_success`
- Updated `Dockerfile` to multi-stage: builds all 4 app bundles (chess/weather/spotify/github), then backend, copies dist dirs into final image
- Added `railway.json` pointing to `packages/backend/Dockerfile`

### WHY
All three apps (Chess, Weather, GitHub) need to work for the Sunday submission. GitHub app was broken because:
1. `dist/` wasn't built
2. Tool results were never dispatched to the iframe via `show_github_data`
3. GitHub app wasn't registered in `registerBuiltInApps()` (only Chess, Weather, Spotify were)
4. Frontend SPA + backend needed to be co-deployable in a single Railway service

### HOW
TDD not applied here (deadline pressure, gap fixes). Manual verification needed in browser.
TypeScript passes cleanly (`npx tsc --noEmit` shows no errors in renderer/backend).

### NEXT STEP
1. **On your Mac**: run `pnpm install` (to install `@fastify/static`), then `pnpm run build:renderer`
2. **Re-seed DB**: `cd packages/backend && npx tsx prisma/seed.ts`
3. **Restart backend**: picks up GitHub app registration and `@fastify/static`
4. **Verify all three apps in browser**:
   - Chess: ask "start a chess game"
   - Weather: ask "what's the weather in New York?"
   - GitHub: ask "show my GitHub repos" (will prompt for OAuth)
5. **Deploy to Railway**: push to main branch — Railway will build the Dockerfile
6. **Set Railway env vars**: DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, JWT_SECRET_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, OAUTH_ENCRYPTION_KEY
