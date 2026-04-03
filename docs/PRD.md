# ChatBridge PRD — Third-Party App Integration Platform

**Version:** 1.0.0
**Date:** 2026-04-02
**Base:** Fork of Chatbox (github.com/chatboxai/chatbox)
**Scope:** 1-week sprint — Friday early submission, Sunday final

---

## Problem Statement

TutorMeAI's AI chatbot needs to evolve from conversation-only to orchestrating third-party apps within the chat experience. Students should play chess, create flashcards, or check weather without leaving the conversation. The chatbot must know what apps provide, invoke them with the right parameters, render their UI inline, and maintain awareness of app state throughout the conversation.

## Success Criteria (Grading Scenarios)

These 7 scenarios are what graders will test. Every one must pass.

1. **Tool discovery + invocation** — User asks to use an app, chatbot finds and calls the right tool
2. **UI rendering** — App UI renders correctly inside the chat window
3. **Completion signaling** — User interacts with app, app signals done, chatbot resumes naturally
4. **Context retention** — User asks about app results after completion, chatbot remembers
5. **Multi-app switching** — User switches between apps in one conversation, state preserved
6. **Ambiguous routing** — Ambiguous question routes to correct app or asks for clarification
7. **Refusal** — Chatbot refuses to invoke apps for unrelated queries

## Architecture: Extend Chatbox, Don't Replace It

### What Chatbox Already Provides (DO NOT REBUILD)
- Chat UI with streaming (Vercel AI SDK)
- Multi-model LLM support (Claude, GPT, etc.)
- Conversation persistence (IndexedDB/SQLite)
- MCP tool integration (`mcpController` + `streamText.ts`)
- Artifact iframe rendering (`Artifact.tsx`)
- Electron + Web builds
- TanStack Router, Zustand/Jotai state, Mantine UI

### What We Add
1. **App Registry** — `src/renderer/packages/apps/` (modeled after `packages/mcp/`)
2. **App Frame** — `src/renderer/components/AppFrame.tsx` (extends Artifact.tsx with bidirectional postMessage)
3. **3 Apps** — Chess (required), Weather Dashboard (external API), Spotify/GitHub (OAuth)
4. **Completion Signaling Protocol** — postMessage-based lifecycle events
5. **Context Injection** — App state summaries injected into LLM context on subsequent turns
6. **User Auth** — Platform login (simple, not K-12 SSO)

### Extension Points (files to modify)

| File | What to change |
|------|---------------|
| `src/renderer/packages/model-calls/stream-text.ts` | Add `...appsController.getAvailableTools()` to tool set |
| `src/shared/types/settings.ts` + `defaults.ts` | Add `installedApps: ThirdPartyApp[]` |
| `src/renderer/Sidebar.tsx` | Add installed apps section |
| `src/renderer/components/Artifact.tsx` | Keep as-is; create new `AppFrame.tsx` with bidirectional postMessage |
| `src/renderer/routes/__root.tsx` | Register app routes |

### New Files to Create

```
src/renderer/packages/apps/
  registry.ts          — AppRegistry class (install, uninstall, list)
  controller.ts        — AppsController singleton (manages running apps, exposes tools)
  types.ts             — ThirdPartyApp, AppToolSchema, AppState types
  protocol.ts          — CBP message types (invoke, state_update, complete, error)

src/renderer/components/
  AppFrame.tsx          — Sandboxed iframe with bidirectional postMessage
  AppCard.tsx           — Inline app card in chat (collapsed/expanded)

src/renderer/routes/
  app/$appId.tsx        — Full-page app view
  settings/apps.tsx     — App management settings page

apps/                   — Third-party app source (each is a self-contained HTML/JS bundle)
  chess/
    index.html          — Chess board UI (chess.js + chessboard.js)
    bridge.js           — CBP client SDK (postMessage to host)
  weather/
    index.html          — Weather dashboard UI
    bridge.js           — CBP client
  github-oauth/
    index.html          — GitHub activity viewer (OAuth-authenticated)
    bridge.js           — CBP client
```

## ChatBridge Bridge Protocol (CBP)

Simple postMessage JSON protocol between host (Chatbox) and app (iframe).

### Host → App Messages
```typescript
// Invoke a tool
{ type: 'invoke', tool: 'make_move', params: { move: 'e4' }, requestId: 'uuid' }

// Provide context
{ type: 'context', sessionId: 'uuid', userId: 'uuid' }
```

### App → Host Messages
```typescript
// Tool result
{ type: 'result', requestId: 'uuid', data: { fen: '...', status: 'active' } }

// State update (app pushes state for LLM context)
{ type: 'state_update', state: { board: '...', turn: 'white', moveCount: 5 } }

// Completion signal (app is done, chatbot can resume)
{ type: 'complete', summary: 'Game over: white wins by checkmate in 24 moves' }

// Error
{ type: 'error', code: 'invalid_move', message: 'Illegal move: Ke2' }
```

### Tool Schema (per app, registered at install)
```typescript
interface AppToolSchema {
  name: string           // e.g., 'chess__start_game'
  description: string    // LLM-readable description
  parameters: JSONSchema // JSON Schema for tool params
  returns: JSONSchema    // JSON Schema for return value
}
```

## Three Required Apps

### 1. Chess (Required — High Complexity)
- **UI:** Interactive board using chess.js (logic) + chessboard.js or cm-chessboard (rendering)
- **Tools:** `start_game`, `make_move`, `get_board_state`, `get_legal_moves`, `resign`
- **State:** FEN string, move history, game status
- **Completion:** Game ends (checkmate/stalemate/resign) → sends `complete` with summary
- **Context:** Board state injected into LLM context so it can analyze positions mid-game
- **Auth:** None

### 2. Weather Dashboard (External API, No Auth)
- **UI:** Current weather + 5-day forecast with icons
- **Tools:** `get_weather`, `get_forecast`
- **API:** OpenWeatherMap free tier (API key bundled, not user-specific)
- **Completion:** Sends `complete` after displaying results
- **Auth:** None (platform-level API key)

### 3. GitHub Activity (OAuth — Required Auth Pattern)
- **UI:** Shows user's recent repos, commits, PRs
- **Tools:** `get_repos`, `get_recent_activity`, `get_pull_requests`
- **API:** GitHub REST API v3
- **Auth:** OAuth2 — user authorizes via GitHub, platform stores + refreshes tokens
- **Completion:** Sends `complete` after displaying activity

## Build Plan (Priority Order)

### Friday (Early Submission) — Must Have
1. App registry + controller (modeled after MCP controller)
2. AppFrame.tsx with bidirectional postMessage
3. Tool injection into streamText.ts
4. Chess app (full lifecycle: invoke → render → interact → complete → context)
5. Weather app (simple tool invocation + UI)
6. Context retention (app state in LLM system prompt)
7. Completion signaling working end-to-end
8. Deploy web build to Railway/Vercel

### Saturday — Should Have
9. GitHub OAuth app (authenticated pattern)
10. App management settings page
11. Error handling (timeout, crash, invalid tools)
12. Multi-app switching in single conversation

### Sunday — Polish + Submit
13. Demo video (3-5 min)
14. AI cost analysis
15. API documentation for developers
16. Social post
17. Final deployment verification

## Non-Goals (Out of Scope)
- K-12 safety / COPPA / FERPA
- Multi-tenant / RLS / district isolation
- Teacher dashboard / Mission Control
- Content moderation pipeline
- Mobile responsive design
- App marketplace / discovery UI
- CI/CD pipeline
