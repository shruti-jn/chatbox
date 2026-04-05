# Architecture Parity Audit

Date: 2026-04-04

Audited against:
- `docs/ARCHITECTURE.md`
- `specs/architecture.md`
- `docs/CHATBRIDGE_NATIVE_ENDPOINT.md`

Audited by reading implementation across:
- backend routes, middleware, Prisma schema, app packages, frontend provider/model code, renderer app-card rendering, and available tests
- live runtime checks for `/docs`, `/openapi.json`, the chess UI route, and inline iframe rendering in the browser

## Executive Summary

The codebase has strong implementation progress, but it is not in full parity with `architecture.md`.

The highest-level conclusion is:

1. The platform foundations described in `architecture.md` are mostly present and real.
2. The primary ChatBridge app orchestration architecture has changed in code, but `docs/ARCHITECTURE.md` and `specs/architecture.md` have not been updated to match.
3. The new native ChatBridge generation path exists, but it is still only partially implemented relative to the intended backend-owned tool execution model.

## Overall Parity Assessment

| Area | Parity | Notes |
|---|---|---|
| Fastify backend + Swagger/OpenAPI | High | Implemented and live |
| Prisma/Postgres/RLS foundation | Medium | Real and substantial, but docs and code disagree on the actual tenant context key and scope |
| Redis/WebSocket real-time layer | Medium | Core endpoints exist, but mission-control and CBP wiring are incomplete/inconsistent |
| App registration/static serving/app instances | High | Real routes, real DB models, real app instance lifecycle |
| Frontend inline app-card rendering | Medium-High | Real `app-card` rendering works; legacy markdown conversion still needed as fallback |
| Native ChatBridge backend endpoint | Medium | Endpoint/provider/context/tool-registry exist, but tool execution remains mock-based |
| Architecture documentation parity | Low | `docs/ARCHITECTURE.md` still describes the older orchestration model, while code is moving to the native endpoint model |

## What Is Clearly Built

### 1. Backend platform foundation is real

Evidence:
- `packages/backend/src/server.ts` registers Fastify, CORS, rate limiting, WebSocket, Swagger UI, and `/openapi.json`
- live checks returned `200` for:
  - `/docs`
  - `/openapi.json`
- the live OpenAPI document currently exposes 44 paths

Assessment:
- This part is not aspirational. It exists and boots.
- The backend is materially more than a stub.

### 2. Prisma schema and tenant-aware backend model are substantial

Evidence:
- `packages/backend/prisma/schema.prisma` currently defines 20 models:
  `District, School, User, Classroom, ClassroomMembership, App, DistrictAppCatalog, ClassroomAppConfig, AppInstance, Conversation, Message, CollaborativeSession, SessionParticipant, OAuthToken, ParentalConsent, DataDeletionRequest, AuditEvent, SafetyEvent, ToolInvocation, AppHealthEvent`
- `packages/backend/src/middleware/rls.ts` provides:
  - append-only enforcement for audit/safety tables
  - transaction-scoped tenant context via `set_config('app.tenant_id', ...)`

Assessment:
- The data model is real and broader than the architecture doc claims.
- `architecture.md` says “19 entities”; the current schema has 20 models.

### 3. App registration, invocation, instance lifecycle, and static hosting exist

Evidence:
- `packages/backend/src/routes/apps.ts`
- `packages/backend/src/routes/app-static.ts`
- `packages/backend/src/server.ts` registers built-in Chess at startup
- `packages/apps-chess/index.html` and `packages/apps-chess/dist/` exist
- live check:
  - `http://127.0.0.1:3001/api/v1/apps/chess/ui/` returned `200`

Assessment:
- The app platform is real, not just sketched.
- The backend can create app instances and attach renderable UI metadata.

### 4. Shared app-card contract exists end-to-end

Evidence:
- `src/shared/types/session.ts` defines `MessageAppCardPartSchema`
- `src/renderer/components/chat/Message.tsx` renders `app-card` parts through `AppCardPartUI`
- `src/renderer/components/message-parts/AppCardPartUI.tsx` renders sandboxed iframes
- browser verification showed a real inline iframe rendering inside the chat UI

Assessment:
- First-class inline app-card rendering exists.
- This is one of the strongest completed vertical slices in the repo.

### 5. Native ChatBridge provider path exists on the frontend

Evidence:
- `src/shared/providers/definitions/models/chatbridge.ts` now posts to:
  - `POST /api/v1/chatbridge/completions`
- it parses SSE and converts `chatbridge_app_card` events into `app-card` message parts
- targeted provider tests exist in:
  - `src/shared/providers/definitions/models/chatbridge.test.ts`

Assessment:
- The frontend is already moving toward the architecture described in `docs/CHATBRIDGE_NATIVE_ENDPOINT.md`.

## Major Parity Gaps

### Finding 1: `docs/ARCHITECTURE.md` and `specs/architecture.md` no longer describe the primary ChatBridge implementation path

Severity: High

Why this matters:
- The docs still describe the renderer-side tool pipeline and CBP/WebSocket-centered orchestration as the main path.
- The codebase has already started moving to the native backend endpoint model instead.

Evidence:
- `docs/ARCHITECTURE.md` and `specs/architecture.md` still describe:
  - `streamText.ts` assembling ChatBridge tools in the renderer
  - a CBP-centered orchestration path
  - the older “extend, don’t replace” tool pipeline diagram
- `docs/CHATBRIDGE_NATIVE_ENDPOINT.md` explicitly replaces that model with:
  - backend-owned tool resolution
  - backend-owned tool execution
  - `POST /api/v1/chatbridge/completions`
- implementation also reflects that shift:
  - `src/shared/providers/definitions/models/chatbridge.ts`
  - `packages/backend/src/routes/chatbridge-completions.ts`
  - `packages/backend/src/ai/context-builder.ts`
  - `packages/backend/src/ai/tool-registry.ts`

Parity assessment:
- Low parity between the main architecture docs and the actual direction of implementation.

Recommended action:
- Promote `docs/CHATBRIDGE_NATIVE_ENDPOINT.md` into the canonical architecture narrative or merge it into `docs/ARCHITECTURE.md`.

### Finding 2: The native ChatBridge endpoint exists, but server-side tool execution is still mock-backed

Severity: High

Why this matters:
- The intended architecture says the backend owns real tool execution, policy enforcement, and orchestration.
- The current implementation still returns mock tool results inside the native endpoint.

Evidence:
- `packages/backend/src/routes/chatbridge-completions.ts` says:
  - “mock path for now”
- the route calls local `executeAppTool(...)`
- `executeAppTool(...)` is explicitly documented as:
  - “the same mock handler as generateToolResult in apps.ts”
  - “In production, this would dispatch via CBP Redis.”

What this means in practice:
- The native endpoint is structurally correct, but not yet fully authoritative.
- The backend is not yet executing real app tools through the same operational path claimed by the architecture decision.

Parity assessment:
- Partial parity.

Recommended action:
- Replace the local mock executor with a real invocation path:
  - either invoke the real app execution path used by `apps.ts`
  - or move that shared logic into a reusable backend service so both routes call the same implementation

### Finding 3: The old `chat` route and the new native endpoint do not yet share one true orchestration path

Severity: High

Why this matters:
- The native endpoint decision says the backend should own context/tool resolution and avoid split orchestration systems.
- Today there are still two materially different backend AI paths.

Evidence:
- `packages/backend/src/routes/chat.ts`
  - still builds prompt-only tool awareness
  - does not pass real AI SDK tools
  - explicitly says tool invocations do not go through AI function calling
- `packages/backend/src/routes/chatbridge-completions.ts`
  - does use real AI SDK tools
  - but with mock execution
- `packages/backend/src/ai/service.ts`
  - is not the shared authoritative tool loop for both routes

Parity assessment:
- Partial parity with the newer architecture; low parity with the “one orchestration path” goal.

Recommended action:
- Consolidate tool resolution and tool execution into shared services used by both `chat.ts` and `chatbridge-completions.ts`, or explicitly deprecate one path.

### Finding 4: The frontend CBP/WebSocket bridge exists as a library, but it is not wired into the main app-card renderer

Severity: High

Why this matters:
- The architecture docs describe active host-app communication through CBP and WebSocket bridging.
- The main UI path does not appear to register iframes or connect app instances to that bridge.

Evidence:
- `src/renderer/packages/chatbridge/cbp-client.ts` exposes:
  - `registerAppIframe`
  - `connectAppInstance`
  - `initCBPListener`
  - `setStateUpdateHandler`
- search results show these are referenced in tests, but not in live renderer integration code
- `src/renderer/components/message-parts/AppCardPartUI.tsx` sends commands to the iframe but does not:
  - register the iframe
  - connect the app instance websocket
  - initialize the CBP listener

What this means:
- The static iframe can render.
- Full bidirectional app-state synchronization is likely incomplete in the main runtime path.

Parity assessment:
- Partial parity.

Recommended action:
- Wire `AppCardPartUI` or a parent ChatBridge integration layer into:
  - iframe registration
  - CBP listener initialization
  - per-instance WebSocket connection lifecycle

### Finding 5: Mission Control real-time behavior is only partially aligned with the architecture

Severity: Medium

Evidence:
- `packages/backend/src/routes/websocket.ts` defines:
  - `/ws/chat`
  - `/ws/mission-control`
  - `/ws/collab/:sessionId`
- but `broadcastToMissionControl` ignores its key and broadcasts to all stored mission-control sockets
- the route stores mission-control sockets by `classroomId`
- elsewhere, typing events call `broadcastToMissionControl(user.districtId, ...)`

What this implies:
- The code has a classroom/district mismatch in the mission-control fanout model.
- The real-time grid/alert model is present, but not yet precise enough to claim clean architectural parity.

Parity assessment:
- Partial parity with a correctness gap.

Recommended action:
- Normalize the routing key for mission-control subscriptions and broadcasts.

### Finding 6: RLS documentation and implementation disagree on the actual scoping model

Severity: Medium

Evidence:
- `docs/ARCHITECTURE.md` says:
  - `SET LOCAL app.current_classroom_id = ?`
- actual code in `packages/backend/src/middleware/rls.ts` uses:
  - `set_config('app.tenant_id', tenantId, true)`
- route handlers consistently pass `districtId`, not `classroomId`

What this implies:
- The implementation appears district-scoped, not classroom-scoped, at the DB tenant-key level.
- The docs currently describe a different RLS contract than the code enforces.

Parity assessment:
- Medium implementation maturity, low documentation parity.

Recommended action:
- Update the architecture docs to describe the real tenant boundary, or change the implementation if classroom-scoped RLS is the actual requirement.

## Secondary Gaps and Drift

### 7. Native endpoint test coverage is thinner than the architecture would imply

Evidence:
- There are frontend tests for the provider:
  - `src/shared/providers/definitions/models/chatbridge.test.ts`
- there are broad backend tests for websockets, app state, safety, RLS, and apps
- there do not appear to be dedicated backend tests covering:
  - `/api/v1/chatbridge/completions`
  - native tool resolution policy
  - native SSE app-card emission
  - bounded server-side tool loop behavior

Assessment:
- This is a verification gap, not necessarily an implementation gap.

### 8. Legacy markdown-link conversion is still part of the effective rendering story

Evidence:
- `src/renderer/stores/session/app-card-processor.ts` still converts markdown links and `__cbApp` metadata into `app-card` parts
- `src/renderer/stores/session/generation.ts` post-processes generated parts with `processAppCards`
- `src/renderer/components/chat/Message.tsx` now also normalizes assistant messages at render time via `processAppCards`

Assessment:
- The product still depends on a fallback path that the new architecture wanted to retire as the primary mechanism.
- This is pragmatic, but it means parity with the “first-class structured event only” target is not complete.

### 9. The chess iframe shell renders, but the board experience is not yet fully trustworthy

Evidence:
- Live browser verification showed:
  - inline iframe renders successfully
  - chess shell UI appears
  - board area was present in the iframe
  - but the visible board content did not yet look fully healthy in the captured screenshot

Assessment:
- This is not a failure of app-card rendering.
- It is either a chess-app initialization issue or a runtime/UI issue inside the iframe app itself.

## Architecture Areas With Good Parity

### OpenAPI / Swagger requirement

Status: Good parity

Evidence:
- `/docs` and `/openapi.json` are live
- server registration in `packages/backend/src/server.ts` matches the documented requirement

### App health/rate limiting foundation

Status: Good parity

Evidence:
- `packages/backend/src/apps/health.ts`
- `packages/backend/src/apps/rate-limiter.ts`
- `packages/backend/src/routes/apps.ts` enforces rate limiting and degraded/unresponsive blocking

### COPPA gate presence

Status: Good parity

Evidence:
- `packages/backend/src/middleware/coppa.ts`
- route usage in `chat.ts`, `apps.ts`, and `chatbridge-completions.ts`

### Safety pipeline presence

Status: Good parity

Evidence:
- `packages/backend/src/safety/pipeline.ts`
- backend routes call it before processing user input

Note:
- The docs describe one latency/LLM profile, while the code currently uses another profile and timeout budget. The system exists, but the documentation should be refreshed.

## Recommended Source-of-Truth Update

If the current implementation direction is intentional, the canonical architecture should now say:

1. ChatBridge primary path is `POST /api/v1/chatbridge/completions`.
2. Backend owns tool resolution and execution.
3. `/api/v1/ai/proxy/*` is compatibility fallback, not the primary ChatBridge path.
4. Renderer-owned ChatBridge tool assembly is legacy/fallback behavior only.
5. CBP/WebSocket app lifecycle support exists, but main runtime wiring is still incomplete.

## Recommended Next Actions

1. Merge `docs/CHATBRIDGE_NATIVE_ENDPOINT.md` into `docs/ARCHITECTURE.md` and `specs/architecture.md`.
2. Replace mock execution inside `chatbridge-completions.ts` with the real app invocation path.
3. Eliminate the split between `chat.ts` prompt-only orchestration and native endpoint orchestration.
4. Wire `AppCardPartUI` into the actual CBP/WebSocket lifecycle if resumable interactive apps are still a requirement.
5. Add dedicated backend tests for `/api/v1/chatbridge/completions`.
6. Decide whether markdown-link conversion remains a supported fallback or should be explicitly deprecated.
7. Audit the chess app itself separately from app-card rendering, because the iframe host layer now appears functional.

## Bottom Line

ChatBridge v2 is not “unbuilt.” It has real backend, data, app hosting, safety, shared schemas, and inline iframe rendering.

But it is also not yet in clean parity with `architecture.md`, because the codebase is in the middle of an architectural transition:

- the new native ChatBridge path is real
- the old architecture docs still describe the old path
- the native path still contains mock execution and incomplete runtime integration

The most accurate current characterization is:

**substantial implementation with meaningful architectural drift and an unfinished migration to the backend-owned native ChatBridge model.**
