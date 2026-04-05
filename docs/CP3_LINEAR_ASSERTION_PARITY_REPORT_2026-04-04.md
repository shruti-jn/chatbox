# CP3 Linear Assertion Parity Report

Date: 2026-04-04

Repo audited:
- `/Users/shruti/Software/chatbox`

Branch audited:
- `v2`

Linear source used:
- `SHR-140` `[GATE-CP-3]`
- `SHR-107` `[TASK-APP-001]`
- `SHR-108` `[TASK-APP-002]`
- `SHR-109` `[TASK-APP-003]`
- `SHR-110` `[TASK-CHESS-001]`

## Scope

This report compares the CP3 assertions written in Linear against the current implementation and the command results I was able to execute locally.

It includes:
- CP3 gate results from `SHR-140`
- targeted parity checks for completed CP3 tasks
- implementation drift found while tracing the assertions

## Executive Summary

CP3 does **not** currently have parity with the assertions stored in Linear.

The biggest reasons are:

1. Several CP3 gate checks fail directly.
2. Some CP3 task requirements marked `Done` in Linear are only partially implemented in code.
3. The repo has two separate blockers for clean assertion execution:
   - root test runner fails because `vitest.config.ts` is loading Vite in a CJS-incompatible way
   - many backend tests fail unless `ANTHROPIC_API_KEY` is set because `src/server.ts` starts eagerly during test import

## CP3 Gate Results

Source:
- `/Users/shruti/Software/chatbox/docs/CP3_LINEAR_ASSERTION_PARITY_REPORT_2026-04-04.md`
- Linear issue `SHR-140`

### Check 1. All tests pass (CP-1 + CP-2 + CP-3)

Linear command:
```bash
cd $PROJECT_DIR && pnpm test
```

Result:
- Failed under shell default Node `v25.9.0` because repo requires `>=20 <23`
- Retried under Node `v22.7.0`
- Still failed at repo root

Observed failure:
- `vitest.config.ts` startup error:
  - `Error [ERR_REQUIRE_ESM]: require() of ES Module ... vite/dist/node/index.js ... not supported`

Status:
- FAIL

### Check 2. Build succeeds

Linear command:
```bash
cd $PROJECT_DIR && pnpm build
```

Result:
- Failed under shell default Node `v25.9.0`
- Retried under Node `v22.7.0`
- Build completed successfully

Status:
- PASS

### Check 3. FSM is table-driven

Linear command:
```bash
grep -c 'TRANSITION_TABLE\|transitions\|stateMap\|validTransitions' $PROJECT_DIR/packages/backend/src/apps/lifecycle.ts
```

Result:
- Output: `1`

Status:
- PASS

### Check 4. CBP uses Redis Pub/Sub

Linear command:
```bash
grep -rn 'redis.*publish\|pubsub' $PROJECT_DIR/packages/backend/src/cbp/ | wc -l
```

Result:
- Output: `0`

Important nuance:
- Redis Pub/Sub logic does exist in:
  - `/Users/shruti/Software/chatbox/packages/backend/src/cbp/redis-dispatch.ts`
- But the exact gate grep pattern does not match the current implementation style

Status:
- FAIL as written in Linear

### Check 5. Spotify tokens encrypted

Linear command:
```bash
grep -rn 'encrypt\|cipher\|crypto' $PROJECT_DIR/packages/backend/src/routes/auth.ts | wc -l
```

Result:
- Output: `28`

Status:
- PASS

### Check 6. COPPA consent gate exists

Linear command:
```bash
grep -rn 'consent\|under.*13\|COPPA' $PROJECT_DIR/packages/backend/src/routes/ | wc -l
```

Result:
- Output: `38`

Status:
- PASS

### Check 7. SDK TypeScript types exported

Linear command:
```bash
test -f $PROJECT_DIR/packages/sdk/dist/index.d.ts && echo OK || echo FAIL
```

Result:
- Output: `OK`

Status:
- PASS

### Check 8. Golden dataset has 20+ scenarios

Linear command:
```bash
python3 -c "import json;f='$PROJECT_DIR/packages/backend/test/golden-dataset/scenarios.json';d=json.load(open(f));print(len(d))"
```

Result:
- Output: `0`

What exists instead:
- `/Users/shruti/Software/chatbox/packages/backend/test/golden-dataset/safety.json`
- no `scenarios.json`

Status:
- FAIL

### Check 9. Eval harness runs (stub mode)

Linear command:
```bash
cd $PROJECT_DIR && npx tsx packages/backend/src/eval/harness.ts --mode=stub 2>&1 && echo OK || echo FAIL
```

Result:
- Harness ran
- Final output ended with `FAIL`
- Summary showed:
  - `Pass rate: 45%`
  - `Passed: 9/20`

Status:
- FAIL against the Linear expectation `output_contains:OK`

## CP3 Gate Summary

| Check | Result |
|---|---|
| 1. All tests pass | FAIL |
| 2. Build succeeds | PASS |
| 3. FSM is table-driven | PASS |
| 4. CBP uses Redis Pub/Sub | FAIL |
| 5. Spotify tokens encrypted | PASS |
| 6. COPPA consent gate exists | PASS |
| 7. SDK types exported | PASS |
| 8. Golden dataset has 20+ scenarios | FAIL |
| 9. Eval harness runs (stub mode) | FAIL |

Overall:
- 4 / 9 pass
- 5 / 9 fail

CP3 gate parity status:
- FAIL

## Task-Level Parity

## SHR-107 — TASK-APP-001 App registration + tool invocation routes

Linear status:
- Done

What matches:
- `POST /apps/register` exists in `/Users/shruti/Software/chatbox/packages/backend/src/routes/apps.ts`
- `POST /apps/:appId/tools/:toolName/invoke` exists
- `PUT /apps/instances/:instanceId/state` exists
- `GET /apps/instances/:instanceId/state` exists
- role gating for registration exists
- 5s timeout behavior is implemented in the fallback path

What does not match cleanly:
- Linear requires `POST /apps/{id}/commands`
- no such route exists in `/Users/shruti/Software/chatbox/packages/backend/src/routes/apps.ts`
- Linear requires explicit PII stripping on outbound CBP commands before dispatch
- I did not find a dedicated `/apps/{id}/commands` route to verify that contract end-to-end

Parity status:
- PARTIAL

Key drift:
- The route contract in Linear is broader than the implemented route surface.

## SHR-108 — TASK-APP-002 App lifecycle FSM + single-active constraint

Linear status:
- Done

What matches:
- lifecycle module exists:
  - `/Users/shruti/Software/chatbox/packages/backend/src/apps/lifecycle.ts`
- gate check for table-driven structure passed
- invocation path in `/Users/shruti/Software/chatbox/packages/backend/src/routes/apps.ts` suspends current active instance before creating a new one

What is still uncertain from assertion parity:
- I did not get a clean dedicated lifecycle test run because backend test execution is currently polluted by eager server startup and missing env requirements
- so parity with all 7 behavioral assertions is not proven by command evidence in this environment

Parity status:
- MOSTLY IMPLEMENTED, NOT FULLY VERIFIED

## SHR-109 — TASK-APP-003 App health monitoring + resource limits

Linear status:
- Done

What matches:
- health monitoring module exists:
  - `/Users/shruti/Software/chatbox/packages/backend/src/apps/health.ts`
- app invocation route blocks degraded/unresponsive apps with `503`
- rate-limit behavior exists in the app invocation route
- health event logging exists

What does not fully match Linear:
- Linear says app status should be persisted to DB and queryable from app records
- current health implementation is explicitly in-memory first:
  - “Uses in-memory storage (Map) for status, with DB logging for health events.”
- this is weaker than the persistence story implied by the assertion wording

Parity status:
- PARTIAL

Key drift:
- Health events are persisted, but health state itself is not the durable DB-first model the assertions imply.

## SHR-110 — TASK-CHESS-001 Chess app: iframe bundle + CBP integration

Linear status:
- Done

What matches directly:
- build passes:
  - `cd packages/apps-chess && pnpm build` under Node `v22.7.0`
- output exists:
  - `packages/apps-chess/dist/index.html`
- relative asset path assertion passed:
  - `grep -c 'src=\"/' dist/index.html` => `0`
- tests pass:
  - `packages/apps-chess/test/chess.test.ts`
  - `8 tests passed`
- app route serves UI:
  - `http://127.0.0.1:3001/api/v1/apps/chess/ui/` => `200`
- browser verification showed the iframe renders inline in chat

What does not fully match the user-visible expectation:
- the iframe shell renders, but the actual board experience still appears incomplete/blank in the captured screenshot
- this means the bundle and embed path are real, but the runtime board UX is not yet fully healthy

Parity status:
- PARTIAL TO STRONG, depending on whether the acceptance bar is “bundle + embed” or “fully healthy board UX”

## Additional Runtime Findings Relevant to CP3

### Root test runner is currently not a reliable gate

Observed under Node `v22.7.0`:
- root `pnpm test` fails before useful coverage due `vitest.config.ts` ESM/CJS boot failure

Implication:
- any checkpoint gate depending on root test execution is currently blocked by tooling, not just feature parity

### Backend tests are overly sensitive to eager server startup

Observed under backend test run:
- many tests trigger:
  - `Missing required environment variables: ANTHROPIC_API_KEY`
- because `src/server.ts` starts eagerly on import

Implication:
- CP3 backend assertions are harder to verify than they should be
- this is a testability and architecture hygiene issue

### Prompt governance test already detects architecture drift

Observed failure:
- `test/prompts.test.ts` reports hardcoded prompt-like text in:
  - `/Users/shruti/Software/chatbox/packages/backend/src/routes/ai-proxy.ts:82`
  - `/Users/shruti/Software/chatbox/packages/backend/src/routes/ai-proxy.ts:184`

Implication:
- some implementation drift is already visible in test failures
- CP3 parity is not only about missing features; it is also about violating structural constraints

## Parity Conclusion

CP3 in Linear is overstated relative to the current implementation.

The current best assessment is:

- `SHR-108` lifecycle work is likely close to parity, but verification is incomplete
- `SHR-110` chess app bundle work is largely present, but the real board UX still needs debugging
- `SHR-109` health monitoring exists, but it does not fully match the persistence model implied by Linear
- `SHR-107` app routes are only partially aligned with the route contract in Linear because `/apps/{id}/commands` is missing
- `SHR-140` CP3 gate does not currently pass

## Recommended Next Actions

1. Fix the root Vitest config so `pnpm test` can be used as a real checkpoint gate.
2. Refactor `packages/backend/src/server.ts` so tests can import server code without eager startup and hard env failures.
3. Decide whether `TASK-APP-001` should be corrected in code or corrected in Linear:
   - add `/apps/{id}/commands`
   - or explicitly de-scope it
4. Replace or update the CP3 gate grep for Redis Pub/Sub so it matches the actual CBP implementation in:
   - `/Users/shruti/Software/chatbox/packages/backend/src/cbp/redis-dispatch.ts`
5. Add the missing golden dataset file expected by the gate:
   - `/Users/shruti/Software/chatbox/packages/backend/test/golden-dataset/scenarios.json`
6. Debug the chess iframe app itself, because host-side inline rendering is already working.

## Bottom Line

The CP3 work is real, but CP3 does **not** currently satisfy the assertions recorded in Linear.

This is not a “nothing was built” situation.
It is a “substantial CP3 implementation with several gate failures, contract drift, and incomplete verification” situation.
