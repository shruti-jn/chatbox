# ChatBridge Architecture — Extension Architecture on Chatbox Fork

## Overview

ChatBridge extends the Chatbox AI client with a third-party app integration platform. The architecture follows the "extend, don't replace" principle — Chatbox's existing chat UI, LLM adapters, streaming pipeline, and persistence are preserved unchanged. The app system is added as a parallel module following the same patterns as Chatbox's existing MCP integration.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Chatbox Renderer (React)                   │
│                                                               │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Sidebar   │  │ Chat View    │  │ App Frame (iframe)      │ │
│  │           │  │              │  │                         │ │
│  │ Sessions  │  │ MessageList  │  │  ┌───────────────────┐  │ │
│  │ Apps ←NEW │  │ MessageInput │  │  │ Third-Party App   │  │ │
│  │           │  │ AppCard ←NEW │  │  │ (chess/weather/   │  │ │
│  │           │  │              │  │  │  github)           │  │ │
│  └──────────┘  └──────┬───────┘  │  └────────┬──────────┘  │ │
│                        │          │           │              │ │
│                        │          │    postMessage (CBP)     │ │
│                        │          │     ↕ bidirectional      │ │
│                        │          └─────────────────────────┘ │
│                        │                                      │
│  ┌─────────────────────┴──────────────────────────────────┐  │
│  │              streamText.ts (Tool Pipeline)              │  │
│  │                                                         │  │
│  │  tools = {                                              │  │
│  │    ...mcpController.getAvailableTools(),   // existing  │  │
│  │    ...appsController.getAvailableTools(),  // NEW       │  │
│  │    ...webSearchTools,                      // existing  │  │
│  │  }                                                      │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                         │                                     │
│  ┌──────────────────────┴─────────────────────────────────┐  │
│  │              LLM Provider (Claude / GPT)                │  │
│  │              via Vercel AI SDK                           │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Apps as Tool Providers (not custom LLM adapters)

Apps register tools that the LLM can call — the same mechanism as MCP servers. This means:
- Zero changes to the LLM generation pipeline
- The LLM decides when to invoke an app (tool calling is the LLM's job)
- Multi-app routing is handled by the LLM naturally (it sees all tool descriptions)
- Refusal is handled by the LLM naturally (no matching tool = no invocation)

### 2. Apps Run in Sandboxed Iframes

Each app is a self-contained HTML/JS bundle rendered in an `<iframe sandbox="allow-scripts">`. This provides:
- Security isolation (app can't access host cookies, localStorage, DOM)
- Crash isolation (app crash doesn't crash the chat)
- Technology freedom (app can use any framework)

### 3. CBP Protocol via postMessage

Communication between host and app uses a simple JSON protocol over `window.postMessage`. This is the standard browser API for cross-origin iframe communication. No WebSocket server needed.

### 4. Context Injection via System Prompt

When an app has active state, it's serialized and injected into the LLM's system prompt:
```
[ACTIVE APP STATE — chess]
Board: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3
Turn: Black | Move: 1 | Status: Active
The user is playing chess. You can see the board state above.
When the user asks about the game, reference this state.
[END APP STATE]
```

This gives the LLM full awareness of what's happening in the app without any changes to the message format.

### 5. Completion Signaling via postMessage

When an app finishes (game over, weather fetched, etc.), it sends:
```json
{ "type": "complete", "summary": "Checkmate! White wins in 24 moves." }
```

The host receives this, stores the summary as a system message in the conversation, and the LLM can reference it in subsequent turns. This is the "completion signaling" that the brief says most teams fail at.

## Module Architecture

### AppsController (new — modeled after mcpController)

```typescript
class AppsController {
  private registry: Map<string, ThirdPartyApp>
  private runningApps: Map<string, RunningApp>

  // Registry
  registerApp(app: ThirdPartyApp): void
  unregisterApp(appId: string): void
  getInstalledApps(): ThirdPartyApp[]

  // Tool pipeline integration
  getAvailableTools(): ToolSet  // Called by streamText.ts

  // App lifecycle
  launchApp(appId: string, sessionId: string): RunningApp
  getRunningApp(appId: string): RunningApp | undefined
  stopApp(appId: string): void

  // State
  getAppState(appId: string): AppState | undefined
  getContextPrompt(): string  // Returns system prompt fragment with all active app states
}
```

### AppFrame Component (new)

```tsx
<AppFrame
  app={thirdPartyApp}
  onStateUpdate={(state) => appsController.updateState(app.id, state)}
  onComplete={(summary) => handleCompletion(app.id, summary)}
  onError={(error) => handleError(app.id, error)}
  onToolResult={(requestId, data) => resolveToolCall(requestId, data)}
/>
```

Internally:
- Renders `<iframe sandbox="allow-scripts" src={app.entryUrl}>`
- Listens for `window.addEventListener('message', handler)`
- Validates message origin before processing
- Routes messages to callbacks based on `type` field

### App Bundle Structure

Each app is a directory with:
```
apps/chess/
  index.html      — Entry point (loaded in iframe)
  manifest.json   — App metadata + tool definitions
  bridge.js       — CBP client SDK (copy-pasted into each app or loaded via script tag)
```

`manifest.json`:
```json
{
  "id": "chess",
  "name": "Chess",
  "description": "Play chess against the AI or analyze positions",
  "version": "1.0.0",
  "entrypoint": "index.html",
  "auth": "none",
  "tools": [
    {
      "name": "start_game",
      "description": "Start a new chess game. Call this when the user wants to play chess.",
      "parameters": {
        "type": "object",
        "properties": {
          "color": { "type": "string", "enum": ["white", "black"], "description": "User's color" }
        }
      }
    },
    {
      "name": "make_move",
      "description": "Make a chess move in algebraic notation (e.g., e4, Nf3, O-O)",
      "parameters": {
        "type": "object",
        "properties": {
          "move": { "type": "string", "description": "Move in algebraic notation" }
        },
        "required": ["move"]
      }
    },
    {
      "name": "get_board_state",
      "description": "Get the current board position as FEN string and game status",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "get_legal_moves",
      "description": "Get all legal moves for the current position",
      "parameters": { "type": "object", "properties": {} }
    }
  ]
}
```

## Data Flow: Complete App Lifecycle

```
User: "Let's play chess"
  ↓
LLM sees tool: chess__start_game → calls it
  ↓
streamText.ts → appsController.invokeTool('chess', 'start_game', {color: 'white'})
  ↓
AppsController → launches chess app iframe → sends invoke message via postMessage
  ↓
Chess app initializes board → sends state_update with FEN
  ↓
AppFrame renders inline in chat (AppCard component)
  ↓
User: "What should I do here?"
  ↓
LLM sees [ACTIVE APP STATE — chess] in system prompt with current FEN
LLM analyzes: "You should play Nf3 to develop your knight..."
  ↓
User interacts with chess board (clicks pieces, makes moves)
App sends state_update after each move
  ↓
Game ends → chess app sends { type: 'complete', summary: 'Checkmate! ...' }
  ↓
Host stores completion summary in conversation
  ↓
User: "That was a good game, what did I do well?"
  ↓
LLM sees completion summary in context → discusses the game
```

## Deployment

- **Web build:** `pnpm run build:web` → deploy to Vercel/Railway as static site
- **Backend:** Not needed — Chatbox runs entirely client-side with direct LLM API calls
- **App bundles:** Served from the same origin as the web build (in `/apps/` directory)
- **OAuth proxy:** For the GitHub OAuth app, a small serverless function handles token exchange (can't do OAuth entirely client-side due to secret exposure)
