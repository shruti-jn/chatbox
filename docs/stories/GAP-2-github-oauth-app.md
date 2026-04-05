# GAP-2: GitHub OAuth App

**Epic:** Third-Party Apps — Required Auth Pattern
**PRD Reference:** docs/PRD.md § "3. GitHub Activity (OAuth — Required Auth Pattern)"
**Status:** NOT IMPLEMENTED — required by PRD

---

## Problem

The PRD explicitly requires GitHub Activity as the OAuth demo app:
- Tools: `get_repos`, `get_recent_activity`, `get_pull_requests`
- Auth: OAuth2 — user authorizes via GitHub, platform stores + refreshes tokens
- UI: Shows user's recent repos, commits, PRs

Spotify covers OAuth but is an external music service. GitHub is more relevant for demonstrating developer tool integration. Having both proves the OAuth pattern works generically.

---

## Acceptance Criteria

The system shall have a GitHub app package at `packages/apps-github/` with a valid manifest and tools.

The system shall launch a GitHub OAuth popup when the user activates the GitHub app without a stored token.

The system shall store the GitHub access token securely and reuse it on subsequent activations.

The system shall display the authenticated user's recent repos with names, descriptions, and language tags.

The system shall send a `complete` message with a summary after displaying activity, so the LLM can discuss it.

The system shall register `get_repos` and `get_recent_activity` tools that the LLM can invoke.

---

## Pre-Written Assertions (TDD — RED first)

### Test file: `packages/apps-github/src/github-app.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'

describe('GitHub app manifest', () => {
  it('The system shall define get_repos tool with required parameters schema', async () => {
    const manifest = await import('../manifest.json')
    const tool = manifest.tools.find((t: { name: string }) => t.name === 'get_repos')
    expect(tool).toBeDefined()
    expect(tool?.description).toBeTruthy()
  })

  it('The system shall define get_recent_activity tool', async () => {
    const manifest = await import('../manifest.json')
    const tool = manifest.tools.find((t: { name: string }) => t.name === 'get_recent_activity')
    expect(tool).toBeDefined()
  })
})

describe('GitHub OAuth backend route', () => {
  it('The system shall expose POST /api/v1/auth/oauth/github/authorize', async () => {
    // Tested via integration — placeholder
    expect(true).toBe(false) // RED
  })

  it('The system shall expose GET /api/v1/auth/oauth/github/callback', async () => {
    expect(true).toBe(false) // RED
  })
})
```

### Test file: `packages/backend/test/github-oauth.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { buildApp } from '../src/app'

describe('GitHub OAuth routes', () => {
  it('The system shall return a GitHub authorization URL from POST /auth/oauth/github/authorize', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/github/authorize',
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ url: string }>()
    expect(body.url).toMatch(/github\.com\/login\/oauth\/authorize/)
  })

  it('The system shall reject authorize requests without a valid auth token', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/github/authorize',
    })
    expect(res.statusCode).toBe(401)
  })
})
```

---

## Implementation Steps

### Step 1: Backend — GitHub OAuth routes
**File:** `packages/backend/src/routes/auth.ts` (add to existing)

Add:
- `POST /api/v1/auth/oauth/github/authorize` — generate GitHub OAuth URL with scopes `read:user repo`
- `GET /api/v1/auth/oauth/github/callback` — exchange code for token, store in `OAuthToken` table (same pattern as Spotify)
- `POST /api/v1/auth/oauth/github/refresh` — not needed (GitHub tokens don't expire)

Environment variables needed (add to `.env.example`):
```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=http://localhost:3001/api/v1/auth/oauth/github/callback
```

**Verification:** `npx vitest run packages/backend/test/github-oauth.test.ts`

### Step 2: Backend — GitHub API service
**File:** `packages/backend/src/services/github.ts`

Implement:
- `getUserRepos(accessToken, limit=10)` — GET `/user/repos?sort=updated&per_page=10`
- `getRecentActivity(accessToken, username, limit=10)` — GET `/users/{username}/events`
- `getProfile(accessToken)` — GET `/user`

### Step 3: Backend — GitHub app tool routes
**File:** `packages/backend/src/routes/apps.ts` (add tool handlers)

Register tools for the `github` appId:
- `get_repos` → calls `github.getUserRepos()`
- `get_recent_activity` → calls `github.getRecentActivity()`

### Step 4: GitHub app frontend bundle
**Directory:** `packages/apps-github/`

Files to create:
- `manifest.json` — app metadata + 2 tool schemas
- `index.html` — UI showing profile header, repo cards, activity feed
- `src/github-app.ts` — CBP client, handles `invoke` commands, sends `state_update` and `complete`
- `package.json` + `vite.config.ts` — build config matching chess/weather/spotify pattern

**UI design:**
- Dark header with GitHub avatar + username
- Repo list: name (bold), description (muted), language badge, ⭐ count
- Activity feed: commit messages, PR titles, push events
- "View on GitHub" link for each item
- Loading state: skeleton cards
- Auth prompt: "Connect GitHub to see your activity" button

### Step 5: Register GitHub app in backend
**File:** `packages/backend/src/seed.ts` or app registration file

Add GitHub app registration matching chess/weather/spotify pattern.

### Step 6: Build and serve GitHub app
Add to build pipeline so `packages/apps-github/dist/` is served at `/api/v1/apps/github/ui/`.

---

## Definition of Done

- [ ] `packages/apps-github/manifest.json` valid with 2 tools
- [ ] GitHub OAuth authorize + callback routes working
- [ ] GitHub app UI renders in chat iframe
- [ ] `get_repos` tool invoked by LLM returns real repos
- [ ] App sends `complete` message with activity summary
- [ ] LLM can discuss repos after completion (context retention)
- [ ] `pnpm run build:renderer` and backend build succeed
