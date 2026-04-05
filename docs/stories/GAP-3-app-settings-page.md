# GAP-3: App Management Settings Page

**Epic:** Web Foundation — Settings
**PRD Reference:** docs/PRD.md § "Saturday — Should Have: App management settings page"
**Status:** NOT IMPLEMENTED

---

## Problem

There is no UI for users to see which apps are available, enable/disable them, or configure them. Teachers and students have no visibility into what apps are registered on the platform.

---

## Acceptance Criteria

The system shall expose a Settings → Apps tab at `/settings/apps`.

The system shall list all registered apps with name, icon, description, and enabled status.

The system shall allow toggling an app on/off per session (does not affect other users).

The system shall show the tools each app exposes.

---

## Pre-Written Assertions

### Test file: `src/renderer/routes/settings/apps.test.tsx`

```typescript
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'

describe('Apps settings page', () => {
  it('The system shall render a list of available apps', () => {
    expect(true).toBe(false) // RED
  })

  it('The system shall show a toggle for each app', () => {
    expect(true).toBe(false) // RED
  })
})
```

---

## Implementation Steps

### Step 1: Create `src/renderer/routes/settings/apps.tsx`
- Fetch app list from `/api/v1/apps`
- Render a card per app: icon, name, description, tools list, enabled toggle
- Follow the pattern of `src/renderer/routes/settings/mcp.tsx`

### Step 2: Add route to settings router
**File:** `src/renderer/routes/settings/route.tsx`
- Add "Apps" tab alongside existing tabs

---

## Definition of Done

- [ ] Settings → Apps tab renders
- [ ] App list loads from backend
- [ ] Each app shows name, description, tools
- [ ] `pnpm run build:renderer` succeeds
