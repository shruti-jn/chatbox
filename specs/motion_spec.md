# ChatBridge v2 — Motion Specification

## Principles

1. **Purposeful, not decorative** — every animation communicates state change or spatial relationship
2. **Fast, not flashy** — 200-300ms for most transitions, never >500ms
3. **Consistent easing** — ease-out for entries, ease-in for exits, linear for progress
4. **Reduced motion respected** — all animations disabled when prefers-reduced-motion is set

## Global Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--duration-fast` | 150ms | Hover states, focus rings |
| `--duration-normal` | 200ms | Most transitions |
| `--duration-slow` | 300ms | App card expand/collapse |
| `--duration-loading` | 1500ms | Skeleton shimmer loop |
| `--easing-enter` | cubic-bezier(0, 0, 0.2, 1) | Elements appearing |
| `--easing-exit` | cubic-bezier(0.4, 0, 1, 1) | Elements leaving |
| `--easing-move` | cubic-bezier(0.4, 0, 0.2, 1) | Layout changes |

## Chat Animations

### Message Entry
- **Student message:** slide up 8px + fade in, 200ms ease-enter
- **AI response (streaming):** tokens appear inline, cursor blink at end
- **AI response (K-2 non-streaming):** fade in complete message, 300ms ease-enter
- **Suggestion chips:** stagger-fade, 50ms delay per chip, 150ms each

### Typing Indicator
- Three dots pulse animation, 1.2s loop
- Appears within 200ms of message send (NFR-PERF-003)

## App Card Animations

### Loading State
- Skeleton shimmer: gradient sweep left-to-right, 1.5s loop, #E2E8F0 → #F1F5F9 → #E2E8F0
- Card height: auto-expand from 0 to content height, 300ms ease-enter

### Active State
- Iframe content fade-in after load, 200ms
- No ongoing animation (iframe controls its own content)

### Suspension (another app invoked)
- Card shrinks to thumbnail (48px height), 300ms ease-move
- Content fades to 60% opacity during shrink
- Thumbnail shows app icon + summary text

### Re-expansion
- Thumbnail expands to full height, 300ms ease-move
- Content fades back to 100%
- Previously active app simultaneously shrinks (synchronized)

### Collapse (completion)
- Card shrinks to summary view (64px height), 300ms ease-move
- Summary text fades in: "Game over: Checkmate in 24 moves"
- Confetti optional for game completion (K-2 only, reduced motion respected)

### Error State
- Red border fade-in, 200ms
- Error icon + message fade in, 200ms
- Retry button pulse (subtle, 2s loop)

### Termination
- Card grays out (filter: grayscale(0.5)), 300ms
- "Disabled by district" badge fades in

## Tool Invocation Animation

### Intent Detection
- Pill appears below AI response: "[icon] Opening Chess..."
- Pill fade-in + slide right, 200ms
- Icon rotates slowly (loading spinner, 1s loop)

### Transition to App Card
- Pill expands into app card skeleton, 300ms ease-move
- Pill text fades out as skeleton fades in

## Mission Control Animations

### Student Grid
- Status dot color transitions: 300ms ease-move (green→amber→red)
- New student appears: fade-in + scale from 0.95, 200ms
- Student disconnects: fade to 50% opacity, 300ms

### Safety Alert
- Alert card slides in from right, 300ms ease-enter
- Red pulse on alert icon, 2s loop (attention-grabbing but not alarming)
- Alert dismissal: slide out right, 200ms ease-exit

### Whisper Confirmation
- Subtle green check animation, 200ms
- Fades out after 3s

## Collaborative Session

### Player Join
- Avatar appears with scale-up from 0 + fade, 200ms
- Player name label slides in below avatar

### Turn Indicator
- Active player's border pulses gently (indigo glow), 2s loop
- Non-active player's border is static gray

### Move Sync
- Board updates appear immediately (optimistic), no animation on the piece movement itself (the chess UI handles its own animation)

## OAuth Flow

### Auth Prompt
- Prompt card slides up from bottom, 300ms ease-enter
- "Connect to Spotify" button has hover scale (1.02), 150ms

### Popup Opening
- Dim overlay behind chat (opacity 0.3), 200ms
- "Waiting for authorization..." spinner in prompt card

### Success
- Popup closes, overlay fades out, 200ms
- Prompt card transforms into app card, 300ms

## Grade-Band Adaptations

### K-2 (ages 5-7)
- Slower transitions: all durations × 1.5 (300ms becomes 450ms)
- Larger animation amplitudes (slide 16px instead of 8px)
- Confetti/celebration on game completion
- No skeleton shimmer (use simple spinner instead)

### 3-5 (ages 8-10)
- Standard transitions
- Subtle celebration on completion (no confetti)

### 6-8, 9-12
- Standard transitions
- No celebration animations
- Professional feel

## Reduced Motion

When `prefers-reduced-motion: reduce` is set:
- All transitions become instant (duration: 0ms)
- No skeleton shimmer (show static placeholder)
- No pulse/loop animations
- State changes still communicated via color/opacity, just without animation
- Confetti/celebration disabled entirely
