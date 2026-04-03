# ChatBridge v2 — Visual Quality Contract

## Purpose

This contract defines the minimum visual quality standards for ChatBridge v2. Every checkpoint verification must evaluate against these criteria. Violations are blocking.

## Design System Compliance

### Token Usage
- **Target:** ≥85% of all color, spacing, typography, and shadow values use design system tokens
- **Detection:** Automated scan for raw hex/px values in CSS/TSX that don't reference --cb-* tokens
- **Violation:** Any component using hardcoded colors or spacing outside the token system

### Typography
- **Primary font:** DM Sans (loaded, not system fallback)
- **Monospace:** JetBrains Mono (for code, FEN notation)
- **Detection:** Font-face loading verified, no unstyled text flash >100ms
- **Grade bands:** K-2 uses 18-20px body; 9-12 uses 15px body. Mismatch is blocking.

### Color Contrast
- **Target:** All text passes WCAG AA (4.5:1 for normal text, 3:1 for large text)
- **Detection:** axe-core automated scan
- **Violation:** Any text below 4.5:1 contrast ratio

### Spacing Consistency
- **Target:** All spacing uses 4px base grid (4, 8, 12, 16, 24, 32, 48, 64, 96)
- **Detection:** Visual audit for non-grid-aligned elements
- **Violation:** Spacing values not on the grid (e.g., 10px, 15px, 30px)

## Component State Coverage

Every interactive component must render correctly in ALL of these states:

| State | Required | Verification |
|-------|----------|-------------|
| Default | Yes | Screenshot |
| Hover | Yes | Screenshot |
| Focus | Yes | Keyboard tab, visible focus ring |
| Active/Pressed | Yes | Screenshot |
| Disabled | Yes | Screenshot, aria-disabled |
| Loading | Yes (if async) | Skeleton or spinner visible |
| Error | Yes (if can fail) | Error message + retry option |
| Empty | Yes (if can be empty) | Empty state illustration or message |

## App Card Visual Standards

### Loading State
- Skeleton shimmer renders within 200ms of invocation
- Card dimensions match expected app dimensions (no layout shift)
- CLS < 0.1 for app card insertion

### Active State
- Iframe border matches design system (--cb-border-radius, --cb-shadow-md)
- No visible scrollbar on the outer card (iframe handles its own scroll)
- App content fills card without letterboxing

### Suspended State
- Thumbnail clearly communicates "paused, tap to resume"
- Summary text is readable (not truncated to ellipsis without tooltip)
- Visual distinction from collapsed (completed) state

### Error State
- Red border from design system error color
- Error message is human-readable (not technical)
- Retry button is prominent and accessible

### Collapsed (Completed) State
- Summary shows meaningful completion data (not just "Done")
- Tap target for re-expansion covers entire card
- Visual distinction from suspended state

## Mission Control Visual Standards

### Student Grid
- 30 students visible without scrolling on 1920×1080 viewport
- Status dots are ≥12px diameter (accessible)
- Color coding passes WCAG AA against card background
- Last activity timestamp visible per student

### Safety Alerts
- Critical alerts visually distinct from warnings (color + icon + size)
- Alert slides in from right, does not push content
- Alert persists until dismissed (no auto-dismiss for critical)

### Real-time Updates
- No full-page re-renders (only affected student cards update)
- Status transitions are smooth (color fade, not instant swap)
- "Last updated" indicator visible if real-time connection drops

## Anti-Patterns (Blocking Violations)

| Anti-Pattern | Why It's Blocking |
|-------------|------------------|
| Raw iframe border visible | Breaks the "one product" illusion |
| System fonts rendering (DM Sans not loaded) | Amateur appearance |
| Console errors visible in production | Technical leak |
| Placeholder text ("Lorem ipsum", "Coming soon") | Incomplete |
| Inconsistent border-radius across cards | Sloppy |
| Missing loading state on any async operation >200ms | Feels broken |
| White flash on app card load | Jarring, preventable |
| Hardcoded colors not from design system | Maintenance nightmare |
| Layout shift on app card insertion (CLS >0.1) | Poor UX |
| Missing keyboard focus indicator on any interactive element | WCAG violation |

## Checkpoint Verification Criteria

### CP-1 (Shell)
- Design tokens loaded and applied
- DM Sans rendering
- Layout skeleton matches design system
- Navigation works, routes resolve
- Grade-band CSS variables respond to config

### CP-2 (Core Visual)
- Chat messages styled correctly per grade band
- Streaming text renders smoothly
- First app card (chess) renders in iframe with correct styling
- Suggestion chips styled and functional

### CP-3 (Data)
- Real data displays correctly (not mock data)
- Loading/empty/error states all styled
- Pagination styled correctly
- Conversation history renders with app cards

### CP-4 (Interaction)
- All 7 test scenarios visually correct
- Mission Control grid renders 30 students
- Safety alerts styled and positioned correctly
- OAuth popup styled (Spotify auth prompt)
- Collaborative session UI correct

### CP-5 (Polish)
- Token usage ≥85%
- WCAG AA passes (axe-core zero violations)
- CLS <0.1 across all pages
- FCP <1.5s
- All motion spec animations implemented
- Reduced motion mode works
- All component states covered (table above)
- Design fidelity audit: ≥80% match to wireframes
