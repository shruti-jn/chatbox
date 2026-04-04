# ChatBridge Native Endpoint — Architecture Decision

## Date: 2026-04-04

## Decision

ChatBridge sessions use a **native backend endpoint** for AI generation, not the transparent Anthropic proxy. The backend owns tool resolution and tool execution. The frontend sends a conversationId and renders what comes back.

## Why

The transparent proxy (`/api/v1/ai/proxy/*`) was designed for Chatbox's general-purpose AI chat. It forwards raw Anthropic API requests and injects a system prompt. This breaks down for ChatBridge because:

1. The AI needs **real tool definitions** (not prompt text mentioning tools) so Anthropic emits `tool_use` blocks
2. Tool execution must happen **server-side** where consent, health, rate limits, and audit can be enforced
3. The backend already has the conversation context (classroom, grade band, enabled apps, active app state, whisper guidance) — the frontend shouldn't need to discover this independently

## Architecture

```
Frontend (ChatBridge provider)
  │
  │  POST /api/v1/chatbridge/completions
  │  { conversationId, messages }
  │
  ▼
Backend Native Endpoint
  │
  ├─ Authenticate (JWT)
  ├─ Load conversation context (classroom, grade band, config)
  ├─ Resolve enabled tools (approved + enabled + healthy + consent-allowed apps)
  ├─ Build AI SDK tool definitions with execute functions
  ├─ Run safety pipeline on user message
  ├─ Call Anthropic via Vercel AI SDK streamText() with real tools
  │   ├─ AI emits tool_use → backend executes tool → feeds result back
  │   ├─ Tool result includes __cbApp metadata (url, instanceId, etc.)
  │   └─ Loop up to maxSteps (3)
  ├─ Stream response back to frontend (Vercel AI SDK compatible SSE)
  └─ Persist messages + app state to DB
      │
      ▼
Frontend renders:
  - Text content (streaming)
  - Tool call pills (ToolCallPartUI)
  - App cards with inline iframes (AppCardPartUI)
```

## Request Contract

```
POST /api/v1/chatbridge/completions
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "conversationId": "uuid",
  "messages": [
    { "role": "user", "content": "Let's play chess!" }
  ]
}
```

## Response Contract

Server-Sent Events (Vercel AI SDK compatible):

```
event: message_start
data: { type: "message_start", message: { id, role: "assistant", model, content: [] } }

event: content_block_delta
data: { type: "content_block_delta", delta: { type: "text_delta", text: "Great! Let's play..." } }

event: content_block_start
data: { type: "content_block_start", content_block: { type: "tool_use", id, name: "chess__start_game" } }

event: content_block_delta
data: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }

event: content_block_stop

-- Backend executes tool, feeds result back to Anthropic --
-- Anthropic continues with tool result in context --

event: content_block_delta
data: { type: "content_block_delta", delta: { type: "text_delta", text: "The board is ready!" } }

event: chatbridge_app_card
data: { type: "app_card", appId, appName: "Chess", instanceId, url: "/api/v1/apps/chess/ui/", height: 500, status: "active" }

event: message_stop
```

The `chatbridge_app_card` event is the ONLY custom event. All other events follow the standard Anthropic SSE format that the Vercel AI SDK already knows how to consume. If this custom event causes problems, it can be delivered as a final JSON field in the message instead.

## What the Frontend Does

1. `ChatBridgeModel` class sends `POST /api/v1/chatbridge/completions` instead of proxying through Anthropic
2. `stream-chunk-processor.ts` handles standard SSE events as before
3. When `chatbridge_app_card` event arrives, it creates a `MessageAppCardPart` in content parts
4. `AppCardPartUI.tsx` renders the sandboxed iframe at the URL from the event

## What the Frontend Does NOT Do

- Fetch classroom tool manifests
- Build app tool definitions
- Execute tool calls
- Know about join codes or classroom IDs
- Manage app instance lifecycle

## What Stays Unchanged

- Non-ChatBridge providers (OpenAI, Claude direct, etc.) use the existing frontend tool pipeline
- MCP tools, web search, file tools, knowledge base tools — all stay frontend-owned for standard providers
- The transparent `/ai/proxy` stays available as a fallback for legacy ChatBridge builds

## Files Affected

| File | Change |
|------|--------|
| `packages/backend/src/routes/chatbridge-completions.ts` | New: native endpoint |
| `packages/backend/src/ai/context-builder.ts` | New: reusable conversation context loader |
| `packages/backend/src/ai/tool-registry.ts` | New: enabled tool resolution |
| `packages/backend/src/ai/service.ts` | Extend: server-side tool loop |
| `src/shared/providers/definitions/models/chatbridge.ts` | Change: use native endpoint, not proxy |
| `src/renderer/stores/session/generation.ts` | Change: pass conversationId |
| `src/renderer/stores/session/stream-chunk-processor.ts` | Change: handle chatbridge_app_card event |
