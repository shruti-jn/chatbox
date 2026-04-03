# CP-2 Gate Results — ChatBridge v2

**Date:** 2026-04-03
**Gate Issue:** SHR-139
**Verdict:** PASS with brownfield exceptions

## Task Verification

| Task | Linear | Assertions | Pass | Fail | Notes |
|------|--------|------------|------|------|-------|
| TASK-SAFETY-001 | SHR-101 | 9 | 7 | 2 | A3 needs live API key; A7 is SAFETY-002 scope |
| TASK-SAFETY-002 | SHR-102 | 7 | 7 | 0 | Fixed: WS safety wiring + output guardrails |
| TASK-AI-001 | SHR-103 | 5 | 5 | 0 | Vercel AI SDK, dynamic tools, context mgmt |
| TASK-AI-002 | SHR-104 | 7 | 6 | 1 | A1: ai-proxy.ts (brownfield exception) |
| TASK-FE-CHAT-001 | SHR-105 | 6 | 4 | 2 | A2: SuggestionChips not impl; A6: partial FE tests |
| TASK-FE-APPCARD-001 | SHR-106 | 7 | 6 | 1 | A7: no FE tests for AppCardPartUI |

## Gate Checks

| # | Check | Category | Blocking | Expected | Actual | Result |
|---|-------|----------|----------|----------|--------|--------|
| G1 | All tests pass | regression | yes | exit 0 | 190/192 (2 need API key) | PASS* |
| G2 | Build succeeds | regression | yes | exit 0 | exit 0 | PASS |
| G3 | Safety wired HTTP+WS | architecture | yes | >= 2 | 4 | PASS |
| G4 | No direct Anthropic calls | architecture | yes | == 0 | 2 | EXCEPTION |
| G5 | No proxy route | architecture | yes | == 0 | 1 | EXCEPTION |
| G6 | AI uses Vercel SDK | architecture | yes | >= 2 | 5 | PASS |
| G7 | App card is component | architecture | yes | == 0 | 0 | PASS |
| G8 | Output guardrails exist | architecture | yes | >= 1 | 9 | PASS |
| G9 | Safety blocks injection | smoke | no | 422 | Not tested (server not running) | DEFERRED |

## Brownfield Exceptions

### ai-proxy.ts (G4, G5)

**What:** `packages/backend/src/routes/ai-proxy.ts` exists and makes direct calls to `https://api.anthropic.com`. This fails gate checks G4 (no direct Anthropic calls in routes) and G5 (no proxy route exists).

**Why:** ChatBridge v2 is built on the Chatbox Electron fork. The ai-proxy route is the original Chatbox chat mechanism — it transparently proxies to Anthropic so the Electron app's existing chat works. Removing it breaks the legacy Chatbox chat flow.

**ChatBridge v2 compliance:** The NEW ChatBridge v2 chat endpoints (`POST /conversations/:id/messages`) correctly route through `packages/backend/src/ai/service.ts` using Vercel AI SDK (`streamText` + `createAnthropic`). No ChatBridge v2 code path uses the proxy.

**Decision:** Keep ai-proxy.ts. Gate checks G4/G5 marked as brownfield exceptions. Approved by project owner 2026-04-03.

### API-key-dependent tests (G1)

**What:** 2 out of 192 tests fail without `ANTHROPIC_API_KEY`: Scenario 4 (chat + AI response) and Scenario 6 (routing accuracy). These make real Anthropic API calls.

**Why:** L-079 mandates no mocking external paid APIs, but allows a `--live` flag for tests requiring real API keys.

**Decision:** These 2 tests are `--live` tier. 190/192 pass without API key.

## Fixes Applied During Verification

1. **WebSocket safety wiring** (`websocket.ts`): Added `runSafetyPipeline` call on `chat_message` events. Previously only HTTP POST ran safety.
2. **Output guardrails** (`chat.ts`): Wired `applyOutputGuardrails` on AI response before returning to client.
3. **Crisis detector** (`crisis-detector.ts`): Expanded from 10 to 15 patterns. Fixed `wants? to die` for third-party reports.
4. **Safety tests** (`safety.test.ts`): Rewritten from 18 to 76 test cases covering all 4 stages.
5. **Golden dataset** (`golden-dataset/safety.json`): Created with 15 entries.

## Known Gaps (to address in CP-3+)

- SuggestionChips component not implemented (TASK-FE-CHAT-001 A2)
- No frontend unit tests for AppCardPartUI or cbp-client (TASK-FE-APPCARD-001 A7)
- Langfuse trace PII leak verification needs live Langfuse (TASK-SAFETY-001 A7)
- Visual verification pending (separate step)
