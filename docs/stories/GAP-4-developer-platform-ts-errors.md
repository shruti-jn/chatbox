# GAP-4: Fix developer-platform TypeScript Errors

**Epic:** Developer Platform
**Status:** PRE-EXISTING — blocks clean `tsc --noEmit`

## Problem

`packages/developer-platform/src/app.ts` and test files call `store.approveVersion()` but the method is not defined in `packages/developer-platform/src/store.ts`. Two errors:

```
packages/developer-platform/src/app.ts(125,52): error TS2339: Property 'approveVersion' does not exist
packages/developer-platform/test/store.test.ts(63,17): error TS2339: Property 'approveVersion' does not exist
```

Also `packages/developer-platform/vitest.config.ts` has a `test` property in the wrong config shape.

## Acceptance Criteria

The system shall have `approveVersion(versionId, reviewerId, notes)` on the store that marks a plugin version approved in the DB.

`npx tsc --noEmit` shall produce zero errors in `packages/developer-platform/`.

## Implementation Steps

1. Read `packages/developer-platform/src/store.ts` to understand existing method patterns
2. Read how `approveVersion` is called in `app.ts` and the test to understand its expected signature
3. Implement the missing method following existing patterns in the file
4. Fix `vitest.config.ts` — change `test:` to `export default defineConfig({ ... })` with correct shape

## Definition of Done
- [ ] `tsc --noEmit` shows zero errors in developer-platform
- [ ] Existing tests still pass
