# ChatBridge Build Plan

**Date:** 2026-04-02
**Deadline:** Early submission Friday (today), Final Sunday 11:59 PM CT
**Base repo:** Fork of github.com/chatboxai/chatbox at /Users/shruti/Software/chatbox
**Our from-scratch repo:** /Users/shruti/Software/ChatBridge (has backend, safety pipeline, CBP protocol — reference only)

---

## Current Status

- [x] Forked Chatbox to github.com/shruti-jn/chatbox
- [x] Cloned to /Users/shruti/Software/chatbox
- [x] PRD written at docs/PRD.md
- [x] Architecture written at docs/ARCHITECTURE.md
- [ ] **BLOCKED: Node 22 needed** — Chatbox requires Node >=20 <23, we have Node 25
  - Fix: `brew install node@22` then use `$(brew --prefix node@22)/bin/node`
  - Or: `pnpm env use --global 22`
- [ ] Chatbox running locally (Electron or web mode)
- [ ] Google OAuth credentials saved in /Users/shruti/Software/ChatBridge/backend/.env
  - Client ID: 992248646259-cmo6k0hilhlt77br4nchfe9qn6kat38l.apps.googleusercontent.com
  - Redirect URI: http://localhost:8000/api/v1/auth/sso/google/callback

---

## The Plan (step by step, verified at each checkpoint)

### Step 0: Get Chatbox Running
- [ ] Install Node 22 (`brew install node@22`)
- [ ] `pnpm install` succeeds
- [ ] `pnpm run dev` launches Electron app OR `pnpm run dev:web` launches browser version
- [ ] Configure Claude API key in Chatbox settings
- [ ] Send a test message, get streaming AI response
- [ ] Screenshot the running app
- **CHECKPOINT: Show Shruti the running Chatbox before writing any code**

### Step 1: App Framework (Security Built In)
Create the plugin system — modeled after Chatbox's existing MCP integration.

Files to create:
```
src/renderer/packages/apps/
  types.ts             — ThirdPartyApp, AppToolSchema, AppState, CBP message types
  registry.ts          — AppRegistry (install/uninstall/list apps)
  controller.ts        — AppsController singleton (lifecycle, tool exposure, state management)
  bridge-host.ts       — Host-side postMessage handler (bidirectional, origin-validated)
```

Files to modify:
```
src/renderer/packages/model-calls/stream-text.ts   — Add appsController.getAvailableTools()
src/shared/types/settings.ts + defaults.ts         — Add installedApps field
```

Security built into the framework:
- Iframe sandbox: allow-scripts only (no allow-same-origin)
- Origin validation on every inbound postMessage
- Schema validation on tool parameters
- Message size limit (64KB)
- No direct DOM/cookie/localStorage access from apps

- [ ] AppsController exposes tools that appear in streamText tool set
- [ ] AppFrame renders iframe with sandbox + bidirectional postMessage
- [ ] postMessage origin validation rejects unknown origins
- **CHECKPOINT: Show tool from a dummy app appearing in LLM tool list**

### Step 2: Chess App (Full Lifecycle — The Critical Test)
This is the assignment's stress test. Must work perfectly.

```
apps/chess/
  index.html     — chess.js + chessboard rendering
  manifest.json  — tool definitions (start_game, make_move, get_board_state, get_legal_moves)
  bridge.js      — CBP client SDK
```

Full lifecycle to verify:
1. User says "let's play chess" → LLM calls chess__start_game tool
2. Chess board iframe appears inline in chat
3. User makes moves on the board (click or type)
4. User asks "what should I do?" → LLM sees board FEN in context, gives advice
5. Game ends (checkmate/resign) → app sends `complete` message
6. User asks "how did I do?" → LLM references the game summary

- [ ] Board renders in chat
- [ ] Moves work (legal move validation)
- [ ] LLM can read board state and give advice mid-game
- [ ] Completion signaling works (game over → chatbot knows)
- [ ] Context retention works (post-game discussion)
- **CHECKPOINT: Record a 30-second screen recording of the full chess lifecycle**

### Step 3: Weather App (Simple Pattern)
Demonstrates: external API, no auth, simple UI, quick completion.

```
apps/weather/
  index.html     — weather display UI
  manifest.json  — tools: get_weather, get_forecast
  bridge.js      — CBP client
```

- Uses OpenWeatherMap free API (key bundled)
- User asks "what's the weather in NYC?" → LLM invokes weather tool → UI shows results → complete
- [ ] Weather renders in chat
- [ ] LLM can discuss the results after completion
- **CHECKPOINT: Show weather working alongside chess in same conversation**

### Step 4: GitHub OAuth App (Authenticated Pattern)
Demonstrates: OAuth2 flow, token storage, authenticated API calls.

```
apps/github/
  index.html     — GitHub activity viewer
  manifest.json  — tools: get_repos, get_activity
  bridge.js      — CBP client
```

- User says "show my GitHub activity" → app triggers OAuth popup → user authorizes → app shows repos/commits
- OAuth token stored securely (never exposed to other apps)
- [ ] OAuth flow works end-to-end
- [ ] Token refresh works
- [ ] LLM can discuss GitHub activity after viewing
- **CHECKPOINT: Show OAuth flow working in demo**

### Step 5: Deploy
- [ ] `pnpm run build:web` produces deployable bundle
- [ ] Deploy to Vercel or Railway (static site + OAuth proxy if needed)
- [ ] Deployed URL works with all 3 apps
- [ ] Share deployed URL
- **CHECKPOINT: Shruti verifies deployed app works**

### Step 6: Documentation & Submission
- [ ] Architecture overview in README
- [ ] API documentation (how a third-party dev builds an app)
- [ ] AI Cost Analysis (dev spend + projections for 100/1K/10K/100K users)
- [ ] Demo video (3-5 min): chat + chess lifecycle + weather + GitHub OAuth + architecture explanation
- [ ] Push to GitLab
- [ ] Social post (final submission only)

---

## What We Can Reuse from ChatBridge Repo

Our from-scratch repo at /Users/shruti/Software/ChatBridge has tested code we can reference:

| Module | Path | What to reuse |
|--------|------|---------------|
| CBP Protocol types | backend/src/app/cbp/protocol.py | Port to TypeScript for apps/types.ts |
| Origin validation | backend/src/app/cbp/handler.py | Port validation logic to bridge-host.ts |
| PII detector patterns | backend/src/app/safety/pii_detector.py | Reference regex patterns |
| Tool schemas | backend/src/app/seed.py | Chess/Flashcard/Physics tool definitions |
| App card design | frontend/app/(student)/chat/components/AppCard.tsx | Reference for AppFrame.tsx |

---

## Key Files in Chatbox to Understand

| File | Why it matters |
|------|---------------|
| `src/renderer/packages/model-calls/stream-text.ts` | WHERE we inject app tools (one line change) |
| `src/renderer/packages/mcp/controller.ts` | PATTERN to copy for AppsController |
| `src/renderer/components/Artifact.tsx` | EXISTING iframe — extend for bidirectional postMessage |
| `src/renderer/stores/session/generation.ts` | The `generate()` function — central orchestrator |
| `src/shared/types/session.ts` | Message type with contentParts — where app cards render |
| `src/renderer/Sidebar.tsx` | Where to add app list |
| `src/shared/types/settings.ts` | Where to add installedApps config |

---

## Deadlines

| Deadline | Date | What's needed |
|----------|------|---------------|
| MVP + Pre-search | Tuesday (PAST) | Pre-search doc + architecture video |
| Early submission | Friday (TODAY) | Full plugin system + 3 apps + deployed + video |
| Final submission | Sunday 11:59 PM CT | Polish + auth + docs + social post |

---

## Critical Reminders

1. **"A simple chat with one rock-solid third-party integration beats a flashy platform where apps break mid-conversation."** — from the brief
2. **Completion signaling** is where most teams fail — solve this first
3. **Spinners/loading states** are explicitly graded — no bare loading screens
4. **Security is half the assignment** — sandbox + origin validation + token handling
5. **Every step must be verified running in the browser** before moving to the next
6. **Don't trust "tests pass"** — trust what you see working
