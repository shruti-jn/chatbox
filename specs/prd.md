# ChatBridge v2 — Product Requirements Document

---

## Case Study Analysis

The ChatBridge case study presents what looks like a simple technical problem — let third-party apps run inside an AI chat — but conceals three deeply interconnected challenges. Getting any one wrong doesn't degrade the product; it creates liability for children.

**The Core Tension: Openness vs. Safety.** ChatBridge's value is that third parties can build things the platform didn't anticipate. But every app entering a child's learning environment is a vector for harm: data exfiltration, inappropriate content, manipulative design, or broken software wasting limited class time. The platform must be radically open to developers AND radically protective of children simultaneously. These goals are in direct opposition.

We resolved this through a contract-first architecture: apps declare exactly what data they need, what content they produce, and what permissions they require before any code runs in front of a student. A 5-layer security architecture — iframe sandboxing, the ChatBridge Bridge Protocol (CBP), backend-mediated dispatch, a 4-stage content safety pipeline, and automated app review — makes non-compliance technically impossible for the most dangerous categories. Every message crossing the trust boundary is validated, PII-stripped, and classified.

**The Ethical Decision: Who Controls the AI?** In most AI products, the user controls the experience. In K-12, the student is the user but the teacher is accountable. We faced a fundamental question: does the AI serve the student's immediate request, or the teacher's pedagogical intent? A student might ask the AI to solve their homework. The student wants the answer; the teacher wants guided learning. We chose teacher authority — AI behavior is configured per-classroom (Socratic vs. direct mode, subject boundaries, tone), and teachers can inject real-time guidance into the AI's context without the student seeing it. This is a meaningful power imbalance by design. We believe it's the correct one because an AI that undermines teacher authority in a classroom destroys institutional trust and kills adoption.

**The Trade-off: Platform Ambition vs. Product Quality.** The market has a 12-18 month window before OpenAI, Google, and Microsoft close the gap. The temptation is to ship an SDK and call it a platform. We resisted. Districts buy solutions, not platforms. The product will be judged on whether three reference apps — Chess, Spotify Playlist Creator, and Weather Dashboard — are genuinely good. The chess board materializing mid-conversation, the AI coaching a student through a position, the Spotify playlist built from natural language — these moments sell the platform more than any documentation. Platform quality without product quality is an empty promise.

**The Regulatory Reality.** COPPA's 2025 amendments (compliance deadline April 22, 2026), FERPA, and 121+ state privacy laws aren't a compliance checklist. They are architectural constraints. Third-party apps interacting with children's data under COPPA 2025 require separate parental consent for data disclosure. Biometric data rules expanded. We built compliance into the architecture — Row-Level Security for multi-tenant isolation, PII stripping at every boundary, US data residency, pseudonymous observability — not as a feature, but as a property of the system itself.

---

| Field | Value |
|-------|-------|
| **Project** | ChatBridge v2 |
| **Version** | 1.0.0 |
| **Date** | 2026-04-02 |
| **Status** | Draft |
| **Scope Phase** | Production |
| **Archetype** | Integration + Workflow + Hybrid |
| **AI-Native Level** | 3 (LLM in critical path) |
| **Source Artifact** | customer_understanding.json v1.0.0 |
| **Client** | TutorMeAI (fictional case study; closest real analog: SchoolAI) |

---

## 1. Problem Statement

### Summary

TutorMeAI's competitive advantage — teacher-configurable AI chatbot — is being copied. To survive, they must evolve from chatbot to platform: enabling third-party apps inside chat while maintaining teacher control and child safety. No K-12 AI platform currently combines governance AND extensibility. SchoolAI has governance (5/5) but no extensibility (1/5). OpenAI has extensibility (5/5) but no K-12 governance (2/5). ChatBridge v2 occupies the white space.

### Evidence

- 85% of teachers and 86% of students used AI in 2024-2025 school year
- K-12 AI market: $539.7M (2025), projected $13.6B by 2035 (38.1% CAGR)
- OpenAI Apps SDK (Nov 2025) validates apps-in-chat but lacks K-12 safety
- 96% of school apps share student data with third parties (Internet Safety Labs, 2022)
- Students tab-switch between 10-15 disconnected tools, losing 2-4 hours/week
- COPPA 2025 compliance deadline April 22, 2026
- MCP reached 97M monthly downloads by March 2026

### Impact if Unsolved

TutorMeAI becomes a commodity chatbot. OpenAI, Google, Microsoft offer free alternatives. Districts consolidate on whichever platform first offers AI chat + third-party apps + child safety.

---

## 2. Personas

### PER-001: Sam the Student (Primary)

**Role:** K-12 student (ages 5-18) interacting with AI chatbot and embedded apps.

**JTBD:** Get help with concepts, practice via interactive apps, ask follow-up questions about app interactions, continue sessions across visits.

**Pain points:** Tab-switches between 10-15 tools losing context; generic AI gives answers not guidance; no interactive experiences inside AI chat; age-inappropriate interfaces.

**Grade bands:** K-2 (5-7), 3-5 (8-10), 6-8 (11-13), 9-12 (14-18)

**Journeys:** JRN-001, JRN-002

### PER-002: Ms. Torres the Teacher (Primary)

**Role:** Classroom teacher configuring AI, managing apps, monitoring students via Mission Control.

**JTBD:** Configure AI behavior/tone/subject per classroom; curate apps per classroom; monitor in real time; inject whisper guidance; set async classroom config; review analytics.

**Pain points:** No visibility into AI/app content; can't shape AI for pedagogical goals; managing 10-15 separate platforms; delayed safety alerts; no real-time guidance injection.

**Journeys:** JRN-003, JRN-004

### PER-003: Dr. Patel the District Admin (Secondary)

**Role:** District-level admin managing app allowlists, compliance, analytics.

**JTBD:** Maintain vetted app catalog; enforce district policies; review aggregate analytics; ensure COPPA/FERPA compliance.

**Pain points:** 96% of school apps share data; 121+ state privacy laws; no aggregate AI usage view; 6+ month procurement cycles.

**Journeys:** JRN-005

### PER-004: Alex the App Developer (Tertiary)

**Role:** Third-party developer building apps via CBP/SDK.

**Justification:** Platform thesis depends on well-designed integration contract. 3 reference apps built against it. Ensures SDK designed for external consumption.

**JTBD:** Register app and define tools; render UI in chat; receive context and send state updates; test in sandbox.

**Pain points:** No K-12 AI platform has a developer SDK; COPPA/FERPA compliance is prohibitively complex; no distribution channel.

**Journeys:** JRN-006

---

## 3. User Journeys

### JRN-001: Student Chat-to-App Session

**Persona:** PER-001 | **Trigger:** Student logs in and asks a question or requests an activity.

1. Student logs in via LTI SSO or platform JWT
2. Student sees conversation history and classroom context
3. Student types message or taps suggestion chip ("Let's play chess")
4. AI identifies clear intent to invoke an app
5. AI responds with text and invokes app tool
6. Tool invocation visualization ("Opening Chess...")
7. App card renders inline: loading skeleton → interactive content (< 2s)
8. Student interacts with app
9. App sends state updates via CBP
10. AI responds to app state ("Good move! Your knight controls the center.")
11. **Decision:** Follow-up (AI analyzes state) | Continue (repeat 8-10) | End (card collapses, conversation continues)

**Success:** Seamless session — feels like one product, not two glued together.

**Failures:** App fails to load (error + retry) | Wrong app invoked (dismiss + correct) | App crashes (collapse + AI acknowledges) | Can't interpret state (AI admits limitation)

**Requirements:** FR-CHAT-001–008, FR-APP-001–008, FR-STATE-001–006, FR-AI-001–006, FR-SAFE-001–006, FR-SAFE-008, FR-AUTH-003, FR-AUTH-004, FR-CHESS-001–003, FR-SPOT-001–003, FR-WTHR-001–003, FR-OBS-001

### JRN-002: Student Collaborative App Session

**Persona:** PER-001 | **Trigger:** Teacher assigns group activity or student initiates.

1. Create shared instance with session code
2. Students join
3. All see same state in real time
4. Turn-based enforcement (chess)
5. AI observes and comments
6. Session ends on completion or teacher close
7. All see summary

**Success:** Multiple students interact with same app instance, AI provides commentary.

**Failures:** Sync fails (stale warning) | Teacher force-closes (session ended message)

**Requirements:** FR-COLLAB-001–005, FR-CHESS-004

### JRN-003: Teacher Classroom Config and Monitoring

**Persona:** PER-002 | **Trigger:** Teacher creates or modifies classroom.

1. Login to Mission Control
2. Create/select classroom
3. Configure AI: subject, tone, Socratic mode, complexity
4. Browse district-approved app catalog
5. Enable/disable apps per classroom (single toggle)
6. Share join code
7. Monitor real-time grid (up to 30 students)
8. **Decision:** Safety alert → review + action | Student struggling → whisper guidance | Normal → periodic review

**Success:** Classroom configured in <5 min, apps enabled in <3 clicks, real-time monitoring with whisper.

**Requirements:** FR-CTRL-001–008, FR-SAFE-004–006, FR-CHAT-008, FR-AUTH-001, FR-AUTH-002

### JRN-004: Teacher Reviews Learning Analytics

**Persona:** PER-002 | **Trigger:** Teacher wants to understand progress.

1. Navigate to Analytics in Mission Control
2. Select classroom and date range
3. View per-student engagement, per-app usage, outcomes
4. Drill into details, adjust AI config or plan whispers

**Requirements:** FR-CTRL-007–008

### JRN-005: District Admin Manages App Catalog

**Persona:** PER-003 | **Trigger:** New app submitted or policy update needed.

1. Login to admin portal
2. Review automated review results (schema, security, safety, accessibility, performance)
3. Approve/reject app for district catalog
4. Configure district-wide defaults
5. Review aggregate analytics
6. **Decision:** Compliance concern → suspend app district-wide immediately

**Requirements:** FR-SAFE-007–008, FR-CTRL-008, FR-AUTH-005, FR-COMP-001–004, FR-OBS-001–003

### JRN-006: Developer Integrates an App

**Persona:** PER-004 | **Trigger:** Developer wants to build an app.

1. Read SDK docs
2. Register app via API with tool definitions + compliance metadata
3. Implement CBP protocol
4. Build UI for app card
5. Test in sandbox
6. Submit for automated review (5 stages)
7. Pass → enters catalog pipeline | Fail → specific violations with fix guidance

**Success:** Working app in under 4 hours using SDK docs.

**Requirements:** FR-APP-001–004, FR-SAFE-007–008, FR-STATE-001

---

## 4. Functional Requirements

### Chat Domain

**FR-CHAT-001** (event_driven, Must): When a student submits a message, the system shall transmit to the AI backend, display in thread, and show typing indicator within 200ms.
- AC-001-01: Given student logged in, when message sent, then appears in thread, typing indicator within 200ms, sent to `POST /api/v1/conversations/{id}/messages`

**FR-CHAT-002** (event_driven, Must): When the AI generates a response, the system shall stream token-by-token with first token within 1 second.
- AC-002-01: Given message sent, when AI responds, then first token streams within 1s, complete response within 10s
- AC-002-02: Given K-2 classroom, when AI responds, then displayed as complete message (no streaming) with age-appropriate vocabulary
- *Dep: anthropic (ANTHROPIC_API_KEY) → Fallback: "I'm having trouble thinking right now. Please try again."*

**FR-CHAT-003** (ubiquitous, Must): The system shall persist all messages, app interactions, and state across sessions.
- AC-003-01: Given previous session exists, when student logs in, then history loads from `GET /api/v1/conversations/{id}/messages?limit=50` with pagination, collapsed app cards visible

**FR-CHAT-004** (event_driven, Must): When AI completes a response, the system shall display 2-3 contextual suggestion chips within 150ms.
- AC-004-01: Given AI responded, when response complete, then 2-3 chips appear, tapping sends as next message

**FR-CHAT-005** (state_driven, Must): While conversation active, the system shall maintain context: last 20 messages, current app state, classroom config, grade level.
- AC-005-01: Given active chess app, when student asks "What should I do?", then `POST /api/v1/ai/completions` includes FEN board state, last 20 messages, classroom config, grade level
- *Dep: anthropic → Fallback: truncate oldest messages first, preserve app state + config*

**FR-CHAT-006** (state_driven, Must): While student in configured grade band, the system shall adapt UI via CSS variables (K-2: 18-20px font, 56px touch targets, no streaming; 9-12: 15px font, standard targets, full streaming).
- AC-006-01: Given K-2 classroom, when chat loads, then font 18-20px, touch targets 56px min, chips primary interaction, no streaming, config from `GET /api/v1/classrooms/{id}/config`
- AC-006-02: Given 9-12 classroom, when chat loads, then font 15px, full streaming, standard chat UX

**FR-CHAT-007** (unwanted, Must): If an app fails/times out/errors, then the system shall collapse card to error state, notify AI, allow conversation to continue.
- AC-007-01: Given app unresponsive >5s, when detected, then error state with retry, AI informed, AI responds "The app isn't responding right now."

**FR-CHAT-008** (event_driven, Must): When user accesses platform, the system shall authenticate via LTI 1.3 SSO or platform JWT, establish role-based session, set RLS tenant context.
- AC-008-01: Given Canvas link clicked, when LTI 1.3 completes via `POST /api/v1/auth/lti/launch`, then JWT issued with role, district_id set as RLS tenant
- AC-008-02: Given platform login, when auth succeeds via `POST /api/v1/auth/login`, then JWT with role, teacher sees Mission Control
- *Dep: LTI 1.3 (LTI_PLATFORM_KEYS) → Fallback: manual login form*

### App Integration Domain

**FR-APP-001** (event_driven, Must): When developer registers app, the system shall accept tool definitions (MCP-compatible), UI manifest, permissions, compliance metadata, and validate against schema.
- AC-001-01: Given valid payload to `POST /api/v1/apps/register`, then app registered as 'pending_review', developer receives app_id
- AC-001-02: Given invalid payload, then 422 with specific validation errors

**FR-APP-002** (event_driven, Must): When AI identifies clear explicit intent for a tool, the system shall invoke with parameters and return result to AI.
- AC-002-01: Given "Let's play chess", when AI identifies intent, then calls `POST /api/v1/apps/{app_id}/tools/{tool_name}/invoke`, AI receives initial board state
- AC-002-02: Given tool exceeds 5s, then timeout error to AI, AI informs student
- *Dep: app endpoints (PER_APP_API_TOKENS) → Fallback: "I wasn't able to open that app. Continue our conversation?"*

**FR-APP-003** (event_driven, Must): When app invoked, the system shall render UI in sandboxed iframe inline in chat with loading, active, collapsed states.
- AC-003-01: Given AI invokes app, then card appears with loading skeleton within 200ms, interactive content within 2s, sandbox attrs prevent navigation/forms/DOM access
- AC-003-02: Given active card, when different app invoked, then current app suspends (collapses to thumbnail), new app becomes active

**FR-APP-004** (event_driven, Must): When app transitions lifecycle states (loading→active→suspended→collapsed→terminated→error), the system shall enforce rules, update UI, notify AI.
- AC-004-01: Given student re-expands suspended app, then previously active suspends, tapped app restores state, AI context updated
- AC-004-02: Given app in error >30s, then transitions to terminated, permanent error message, event logged

**FR-APP-005** (event_driven, Must): When app signals completion via CBP, the system shall collapse card to summary, pass completion data to AI, continue conversation with context.
- AC-005-01: Given checkmate, when chess sends completion, then card shows "Game over: [result]", AI discusses game

**FR-APP-006** (state_driven, Must): While conversation has active app, only one app active at a time; new invocation suspends current; student can re-expand suspended.
- AC-006-01: Given active chess, when weather invoked, then chess suspends ("Chess game in progress"), weather becomes active, student can tap chess to re-expand

**FR-APP-007** (state_driven, Must): While app running, enforce: max 600px width (desktop), 400px (mobile), 50MB memory, 100 requests/min.
- AC-007-01: Given app exceeds 50MB, then terminated, resource limit message, logged via `GET /api/v1/apps/{app_id}/events`

**FR-APP-008** (state_driven, Should): While apps registered, the system shall monitor health and transition degraded apps.
- AC-008-01: Given endpoint unresponsive >30s, then status 'degraded', AI stops invoking, teachers see warning

### State & Communication Domain

**FR-STATE-001** (ubiquitous, Must): The system shall implement CBP using JSON-RPC 2.0 over postMessage for all platform↔iframe communication.
- AC-001-01: Given app sends state_update, when valid JSON-RPC 2.0, then validated, safety-checked, persisted to `PUT /api/v1/apps/instances/{instance_id}/state`
- AC-001-02: Given message >64KB, then rejected before JSON parsing

**FR-STATE-002** (event_driven, Must): When app updates state via CBP, the system shall persist snapshot, update AI context, broadcast to Mission Control.
- AC-002-01: Given chess move, then new state persisted, in AI's next context, broadcast to teacher via WebSocket

**FR-STATE-003** (event_driven, Must): When student refreshes/reconnects, the system shall restore app states, re-render cards, resume context.
- AC-003-01: Given refresh during chess, then history from `GET /api/v1/conversations/{id}/messages`, board from `GET /api/v1/apps/instances/{instance_id}/state`, resumes

**FR-STATE-004** (ubiquitous, Must): All tool invocations shall route through backend; no direct iframe↔LLM communication.
- AC-004-01: Given AI invokes tool, then command flows through `POST /api/v1/apps/{app_id}/commands`, validated, PII-stripped, published to Redis `cbp:{instance_id}:commands`, relayed via WebSocket

**FR-STATE-005** (ubiquitous, Must): The system shall validate origin of every postMessage against allowlist, rejecting unknown origins.
- AC-005-01: Given unknown origin, then message silently dropped, rejection logged

**FR-STATE-006** (ubiquitous, Must): Every CBP message shall be validated against JSON-RPC 2.0 schema before processing.
- AC-006-01: Given missing 'jsonrpc' field, then rejected with error code -32600

### Safety Domain

**FR-SAFE-001** (event_driven, Must): When student submits message, run 4-stage pipeline: PII detection → injection detection → LLM classification → crisis detection.
- AC-001-01: Given message, then blocked→422, critical→200+crisis resources, safe→202
- AC-001-02: Given phone/email in message, then redacted to [REDACTED] before AI
- *Dep: anthropic (Sonnet for classification) → Fallback: conservative blocking + teacher alert*

**FR-SAFE-002** (ubiquitous, Must): Strip PII from all outbound CBP payloads before reaching apps.
- AC-002-01: Given CBP command with PII patterns, then redacted before leaving platform

**FR-SAFE-003** (event_driven, Must): When message received, scan for injection patterns, extract real intent when possible.
- AC-003-01: Given "ignore instructions", then flagged, injection stripped, real question extracted or blocked

**FR-SAFE-004** (event_driven, Must): When crisis keywords detected, always run crisis detection, return resources immediately, alert teacher.
- AC-004-01: Given crisis indicators, then student receives hotline/text resources, teacher gets real-time Mission Control alert, severity='critical' logged

**FR-SAFE-005** (state_driven, Must): Enforce rate limits: students 60 msg/min, teachers 120 msg/min, apps 100 calls/min.
- AC-005-01: Given >60 student messages/min, then 429 with Retry-After

**FR-SAFE-006** (event_driven, Must): When AI generates response, run output guardrails: strip PII, classify safety, enforce teacher boundaries, prevent direct answers in Socratic mode.
- AC-006-01: Given Socratic math classroom, when student asks "What is 12×15?", then AI guides ("What's 12×10? What's 12×5? Add them.") instead of answering

**FR-SAFE-007** (event_driven, Must): When developer submits app, run full review: schema validation, static security, runtime safety, accessibility audit, performance profiling.
- AC-007-01: Given submission to `POST /api/v1/apps/{app_id}/submit-review`, then results via `GET /api/v1/apps/{app_id}/review-results` with per-check pass/fail
- AC-007-02: Given external scripts from non-allowed domains, then fail with 'external_script_violation'

**FR-SAFE-008** (event_driven, Must): When app sends CBP message with text, run content safety classifier before processing.
- AC-008-01: Given app text with severity='blocked', then rejected, app receives error, teacher notified

### Auth Domain

**FR-AUTH-001** (event_driven, Must): When user clicks ChatBridge link in LMS, authenticate via LTI 1.3 OIDC, extract role + district, establish session.
- AC-001-01: Given Canvas link, when LTI completes via `POST /api/v1/auth/lti/launch`, then role + district extracted, JWT issued
- *Dep: LTI 1.3 (LTI_PLATFORM_KEYS) → Fallback: redirect to platform login*

**FR-AUTH-002** (event_driven, Should): When student completes graded activity, pass grade to LMS via LTI AGS.
- AC-002-01: Given chess puzzle completed, then grade posted to LMS via `POST {lti_ags_endpoint}/scores`
- *Dep: LTI AGS → Fallback: store locally, retry, teacher sees "grade sync pending"*

**FR-AUTH-003** (event_driven, Must): When app requires user auth, present prompt, handle OAuth2 via popup, store tokens, refresh automatically.
- AC-003-01: Given "Make me a Spotify playlist" with no token, then auth explanation + OAuth popup via `GET /api/v1/auth/oauth/spotify/authorize`, token stored via `POST /api/v1/auth/oauth/spotify/callback`
- AC-003-02: Given expired token, then auto-refresh via `POST /api/v1/auth/oauth/spotify/refresh`
- *Dep: Spotify (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET) → Fallback: "I can't connect to Spotify. Try something else?"*

**FR-AUTH-004** (state_driven, Must): While student under 13, require verified parental consent before AI/app interaction.
- AC-004-01: Given no consent, then blocked with parent notification via `POST /api/v1/consent/request`

**FR-AUTH-005** (ubiquitous, Must): Enforce RBAC: students chat + use enabled apps; teachers configure + monitor + manage; admins manage catalog + policies + analytics.
- AC-005-01: Given student accessing `GET /api/v1/admin/apps`, then 403
- AC-005-02: Given teacher attempting district-wide suspend, then 403

### AI Domain

**FR-AI-001** (state_driven, Must): While student in classroom with enabled apps, inject tool schemas of enabled apps into AI system prompt.
- AC-001-01: Given Chess + Weather enabled, Spotify disabled, then system prompt includes chess + weather tools, NOT Spotify

**FR-AI-002** (event_driven, Must): When student sends message, AI shall invoke tool only on clear explicit intent; otherwise respond conversationally.
- AC-002-01: Given "Let's play chess", then invoke chess.start_game
- AC-002-02: Given "I'm bored", then conversational response without tool invocation
- AC-002-03: Given "What's the capital of France?", then direct answer, no tool

**FR-AI-003** (event_driven, Must): When student asks about active app state, AI shall analyze from context and respond contextually.
- AC-003-01: Given mid-chess "What should I do?", when FEN in context, then AI suggests move with grade-appropriate explanation
- *Dep: anthropic → Fallback: "I can see you're playing chess but having trouble analyzing right now."*

**FR-AI-004** (event_driven, Must): When query unrelated to available apps, AI responds helpfully without tools, within classroom subject boundaries.
- AC-004-01: Given math-only classroom, when student asks about history, then "Great question! In this classroom I help with math and science."

**FR-AI-005** (state_driven, Must): While multiple tool schemas in context, manage window within limits prioritizing: app state > classroom config > recent messages > tool schemas.
- AC-005-01: Given context approaching limit, then truncate oldest messages, preserve app state + config + schemas

**FR-AI-006** (event_driven, Should): When AI completes response, generate 2-3 context-aware suggestion chips considering app state, history, classroom config.
- AC-006-01: Given chess just started, then suggestions like "Show me an opening strategy" not generic

### Teacher Controls Domain

**FR-CTRL-001** (event_driven, Must): When teacher creates/edits classroom, allow config of AI mode, subject, tone, grade band, join code.
- AC-001-01: Given `POST /api/v1/classrooms` with mode='socratic', subject='math', grade_band='6-8', then classroom created with join code

**FR-CTRL-002** (event_driven, Must): When configuring classroom, display district-approved catalog, enable/disable apps per classroom with single toggle.
- AC-002-01: Given `GET /api/v1/classrooms/{id}/apps`, when Chess toggled via `PATCH /api/v1/classrooms/{id}/apps/{app_id}`, then Chess tools available to students

**FR-CTRL-003** (event_driven, Must): When teacher sends whisper, inject into AI context for that student's next response, invisible to student.
- AC-003-01: Given whisper via `POST /api/v1/classrooms/{id}/students/{student_id}/whisper`, then AI's next response reflects guidance, student never sees whisper

**FR-CTRL-004** (event_driven, Must): When teacher sets persistent guidance, include in AI system prompt for all conversations in that classroom.
- AC-004-01: Given guidance set via `PATCH /api/v1/classrooms/{id}/config`, then all student AI prompts include guidance

**FR-CTRL-005** (state_driven, Must): While Mission Control open, display real-time grid of up to 30 students with status, activity, last message.
- AC-005-01: Given Mission Control open, then grid via `WS /api/v1/ws/mission-control` with color-coded status (green=active, amber=idle, red=alert)

**FR-CTRL-006** (event_driven, Must): When safety pipeline flags blocked/critical, send real-time alert to Mission Control with severity, context, intervention options.
- AC-006-01: Given severity='critical', then teacher push notification within 2s: student name, context, severity, options (view/block/contact parent)

**FR-CTRL-007** (event_driven, Should): When teacher navigates to analytics, display per-student engagement, per-app usage, outcome trends.
- AC-007-01: Given `GET /api/v1/classrooms/{id}/analytics?start_date=X&end_date=Y`, then metrics load within 3s

**FR-CTRL-008** (event_driven, Must): When district admin suspends app, immediately terminate all instances, remove from catalogs, notify teachers.
- AC-008-01: Given `POST /api/v1/admin/apps/{app_id}/suspend`, then instances terminated, students see "app disabled by district", teachers notified, removed from catalogs within 5s

### Collaboration Domain

**FR-COLLAB-001** (event_driven, Should): When collaborative activity assigned/initiated, create shared instance with session code.
- AC-001-01: Given `POST /api/v1/collaborative-sessions`, then session code generated, students join via `POST /api/v1/collaborative-sessions/{code}/join`

**FR-COLLAB-002** (state_driven, Should): While turn-based session active, enforce turn order, reject out-of-turn actions.
- AC-002-01: Given Player A's turn, when Player B moves, then rejected with "It's not your turn"

**FR-COLLAB-003** (state_driven, Should): While collaborative session active, sync state across participants within 200ms via Redis Pub/Sub.
- AC-003-01: Given Player A moves, then Player B sees updated board within 200ms

**FR-COLLAB-004** (state_driven, Should): While session active, teacher can observe in Mission Control and close if needed.
- AC-004-01: Given active session, then teacher sees participants, state, "Close Session" button

**FR-COLLAB-005** (event_driven, Could): When participant disconnects, preserve position for 5-minute reconnection window.
- AC-005-01: Given disconnect, when reconnect within 5min, then rejoin with current state and turn order

### Chess App Domain

**FR-CHESS-001** (event_driven, Must): When chess invoked, render interactive board with legal move validation, drag-and-drop, valid move indicators.
- AC-001-01: Given active game, when piece selected, then valid squares highlighted, only legal moves accepted
- AC-001-02: Given illegal move attempt, then error indicator, AI explains why invalid

**FR-CHESS-002** (event_driven, Must): When student asks for help, AI analyzes FEN from context with grade-appropriate advice.
- AC-002-01: Given K-2 "Help me", then simple guidance ("Your queen is powerful!")
- AC-002-02: Given 9-12 "What should I do?", then tactical analysis ("Knight fork on e6 attacks king and rook")
- *Dep: anthropic → Fallback: "I can see the board but having trouble analyzing right now."*

**FR-CHESS-003** (event_driven, Must): When game ends, signal completion with final state, collapse card, AI discusses game.
- AC-003-01: Given checkmate, then CBP completion, card shows result, AI discusses ("Great game! Your bishop pair was effective.")

**FR-CHESS-004** (event_driven, Should): When collaborative session created, assign colors, enforce turns, sync board real-time.
- AC-004-01: Given two students join, then Player 1=white, Player 2=black, turn indicator shown

### Spotify App Domain

**FR-SPOT-001** (event_driven, Must): When Spotify invoked with no token, present auth explanation and OAuth2 popup.
- AC-001-01: Given "Make me a study playlist" with no token, then AI explains need for Spotify access, platform opens OAuth popup
- *Dep: Spotify (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET) → Fallback: "Can't connect to Spotify."*

**FR-SPOT-002** (event_driven, Must): When student describes playlist in natural language, search Spotify and create real playlist.
- AC-002-01: Given "chill study playlist with lo-fi", then search via `POST /api/v1/apps/spotify/tools/search_tracks/invoke`, create via `POST /api/v1/apps/spotify/tools/create_playlist/invoke`, card shows playlist with tracks
- *Dep: Spotify API (user OAuth token) → Fallback: "No results found, try more specific."*

**FR-SPOT-003** (event_driven, Must): When Spotify token expires, auto-refresh without user interaction.
- AC-003-01: Given expired token, then refresh via `POST /api/v1/auth/oauth/spotify/refresh`, retry invocation, no interruption
- *Dep: Spotify (refresh token) → Fallback: re-prompt OAuth popup*

### Weather App Domain

**FR-WTHR-001** (event_driven, Must): When student asks about weather, invoke with location, fetch real data, display results.
- AC-001-01: Given "Weather in Chicago", then `POST /api/v1/apps/weather/tools/get_weather/invoke` with location="Chicago", AI responds with conditions
- *Dep: OpenWeatherMap (OPENWEATHER_API_KEY) → Fallback: "Can't check weather right now."*

**FR-WTHR-002** (event_driven, Must): When data retrieved, render visual dashboard: temperature, conditions, forecast, icons.
- AC-002-01: Given weather data, then dashboard shows temp, icon, conditions, 5-day forecast, location name

**FR-WTHR-003** (event_driven, Could): When student asks to compare locations, display side by side.
- AC-003-01: Given "Compare Chicago and Miami", then both cities shown side by side

### Infrastructure Failure Mode Domain

**FR-INFRA-001** (unwanted, Must): If Redis becomes unavailable, then the system shall degrade to direct database queries for session data, disable real-time Mission Control updates (show "real-time updates paused" banner), disable collaborative session sync, and continue serving chat with increased latency.
- AC-INFRA-001-01: Given Redis connection pool health check fails, when a student sends a message, then the message is processed via direct PostgreSQL query, the student experiences chat normally (with ~200ms added latency), and Mission Control shows a "real-time updates paused" warning banner
- AC-INFRA-001-02: Given Redis recovers, when the connection pool detects availability, then real-time features resume automatically within 10 seconds and the warning banner clears

**FR-INFRA-002** (unwanted, Must): If PostgreSQL becomes unavailable, then the system shall return 503 Service Unavailable, display a maintenance page to users, and alert the operations team.
- AC-INFRA-002-01: Given PostgreSQL connection pool exhausted or unreachable, when any API request arrives, then the system returns 503, users see "ChatBridge is temporarily unavailable. Please try again in a few minutes.", and an alert is sent to the ops channel

**FR-INFRA-003** (unwanted, Must): If a WebSocket connection drops, then the client shall automatically reconnect with exponential backoff (1s, 2s, 4s, max 30s), display a reconnection indicator, and resume message delivery on reconnection.
- AC-INFRA-003-01: Given a WebSocket disconnect, when the client detects the drop, then a "Reconnecting..." indicator appears, reconnection attempts follow exponential backoff, and on successful reconnect any missed messages are fetched via `GET /api/v1/conversations/{id}/messages?after={last_message_id}`
- AC-INFRA-003-02: Given reconnection fails after 5 attempts (30s), then the indicator changes to "Connection lost. Please refresh the page." with a refresh button

### App Lifecycle State Machine

The app lifecycle follows this formal state machine:

**States:** loading, active, suspended, collapsed, terminated, error

**Transitions:**

| From | To | Trigger | Guard | Action |
|------|----|---------|-------|--------|
| (none) | loading | AI invokes app tool | Tool invocation valid | Create app instance, render loading skeleton |
| loading | active | Iframe content ready | Load completes within 2s | Show interactive content, notify AI |
| loading | error | Iframe fails to load | Load timeout (>2s) or error event | Show error state with retry |
| active | suspended | Another app invoked OR user scrolls past | Single-active constraint (CLR-005) | Collapse to thumbnail, preserve state |
| active | collapsed | App signals completion | CBP completion message received | Collapse to summary, pass data to AI |
| active | error | App unresponsive | Heartbeat timeout >5s | Show error, notify AI, log event |
| active | terminated | Admin suspends OR resource limit exceeded | Admin action OR monitor violation | Force close, show message, notify teacher |
| suspended | active | User re-expands card | Tap on collapsed card | Restore state, suspend other active app |
| suspended | terminated | Session ends OR admin suspends | Session close OR admin action | Clean up resources |
| error | loading | User clicks retry | Retry attempt | Re-initialize iframe |
| error | terminated | Error persists >30s | Timeout | Permanent error message |
| collapsed | active | User re-expands | Tap on summary card | Restore or restart app |
| terminated | (none) | — | — | Resources freed, card remains as static record |

**Invalid transitions (rejected):** active→loading, terminated→any, collapsed→suspended, error→active, error→suspended

### Observability Domain

**FR-OBS-001** (ubiquitous, Must): Trace every LLM call in Langfuse: prompt, response, latency, tokens, cost, model, tool_calls, guardrail_results, pseudonymous context (no PII).
- AC-001-01: Given message sent, when AI responds, then Langfuse trace with parent-child spans: safety→LLM→tool→guardrail→response
- *Dep: Langfuse (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY) → Fallback: log locally, replay when available. Never block on observability.*

**FR-OBS-002** (event_driven, Must): When tool invoked, log: tool name, app_id, params, result, latency, status, conversation context.
- AC-002-01: Given chess start_game, then log entry queryable via `GET /api/v1/admin/tool-invocations?app_id=X`

**FR-OBS-003** (ubiquitous, Must): Maintain immutable audit trail of all safety events.
- AC-003-01: Given any safety event, then record with timestamp, type, severity, pseudonymous user_id, district_id, action, queryable via `GET /api/v1/admin/safety-events?district_id=X`

### Compliance Domain

**FR-COMP-001** (ubiquitous, Must): Track parental consent for every student under 13, require before AI/app interaction.
- AC-001-01: Given no consent, then block and trigger `POST /api/v1/consent/request`

**FR-COMP-002** (event_driven, Must): When deletion requested, delete all student data within 30 days.
- AC-002-01: Given `POST /api/v1/consent/delete-request`, then data marked, purged within 30 days, admin confirmation

**FR-COMP-003** (ubiquitous, Must): Maintain FERPA audit trails for all access to student records.
- AC-003-01: Given teacher views student history, then audit record: teacher_id, student_id, resource, timestamp, queryable via `GET /api/v1/admin/audit-trail?student_id=X`

**FR-COMP-004** (ubiquitous, Must): Store all student data on US infrastructure, Anthropic calls with inference_geo='us'.
- AC-004-01: Given AI request, then inference_geo='us' parameter included. Never fall back to non-US.
- *Dep: anthropic → Fallback: queue and retry. Never fall back to non-US regions.*

---

## 5. Differentiation

### Market Position
ChatBridge v2 occupies the intersection of K-12 governance and third-party app extensibility — a space no competitor holds.

### Table Stakes
- Real-time AI chat with streaming and persistent history
- FERPA/COPPA compliance including 2025 amendments
- Teacher auth and per-classroom AI config
- 3+ working app integrations
- Content safety pipeline
- LMS integration via LTI 1.3

### Standout Features

**WOW-001: The Chess Demo (AI-Aware App State)** — Student asks "What should I do?" mid-game, AI analyzes ACTUAL board position with grade-appropriate advice. Zero competitors offer this.

**WOW-002: Teacher App Curation with Governance** — Per-classroom app toggles with district approval pipeline. Transforms teacher from consumer to curator.

**WOW-003: ChatBridge Bridge Protocol (CBP)** — Open MCP extension for K-12 safety. Could become industry default like LTI for LMS.

**WOW-004: Real-Time Teacher Whisper** — Teacher injects guidance into AI's next response mid-conversation. Student never sees it. No competitor has this.

**WOW-005: 4-Stage Content Safety Pipeline** — PII→injection→LLM classification→crisis detection. Deepest K-12 AI safety architecture.

### Signature Experience
Chess Demo: "let's play chess" → board appears → play → "what should I do?" → AI analyzes actual position → game ends → AI discusses. Teacher sees everything in Mission Control. One flow demonstrating tool discovery, UI embedding, bidirectional state, AI reasoning, completion signaling, and governance.

---

## 6. AI-Native Experience Design

AI is not a feature of ChatBridge — it IS ChatBridge. Remove the LLM and there is no product.

| Workflow | AI Role | Why Core | Override | Trust Signal |
|----------|---------|----------|----------|-------------|
| Chat response | Generate contextual, grade-appropriate responses | Product IS the AI | Teacher whisper + config | Streaming shows generation; config visible to teacher |
| Tool routing | Identify app from natural language | NL app discovery requires intent understanding | Conservative: explicit intent only | AI explains actions ("Opening Chess...") |
| State analysis | Reason about live app state | Connects conversation to interactive content | Student can ask follow-ups | AI cites specific positions/data |
| Safety classification | Classify every message | 200K+ daily messages impossible manually | Teacher alerts + override | Classification visible in audit |
| Suggestion generation | Generate context-aware next actions | Reduces cognitive load | Student can ignore | Clearly labeled, never auto-executed |

---

## 7. Non-Functional Requirements

| ID | Statement (EARS) | Target | Measurement |
|----|-----------------|--------|-------------|
| NFR-PERF-001 | When student sends message, first AI token within 1s | <1s p95 | Langfuse latency |
| NFR-PERF-002 | When app invoked, card interactive within 2s | <2s p95 | Render event timing |
| NFR-PERF-003 | When message submitted, typing indicator within 200ms | <200ms | Client timing |
| NFR-PERF-004 | When state published via Redis, relay to WebSocket within 100ms | <100ms | Pub/Sub to client timing |
| NFR-REL-001 | System shall maintain 99% monthly uptime | 99% | Uptime monitoring |
| NFR-SEC-001 | Iframes shall enforce sandbox attrs (deny same-origin, navigation, external forms) | Zero DOM violations | CSP reports + audit |
| NFR-SEC-002 | Rate limits: students 60/min, teachers 120/min, apps 100/min | Zero unthrottled abuse | 429 rate metrics |
| NFR-USAB-001 | Loading indicators for all async ops >200ms | 100% coverage | UI audit |
| NFR-ACC-001 | WCAG 2.1 AA: screen reader, keyboard nav, 4.5:1 contrast | Zero violations | axe-core + manual |
| NFR-OBS-001 | 100% LLM calls traced in Langfuse, no PII | 100% coverage, 0 PII | Trace count audit |
| NFR-COMP-001 | COPPA 2025 + FERPA compliance, US data residency | Zero violations | Annual audit |
| NFR-SCAL-001 | 30 students/classroom, 100 classrooms/district | Concurrent load | Load testing |

---

## 8. Scope

### In-Scope
Real-time AI chat with streaming; third-party apps via CBP (Chess, Spotify, Weather); sandboxed iframes with 5-layer security; Mission Control; district admin portal; LTI 1.3 Advantage; collaborative sessions; COPPA/FERPA compliance; 4-stage safety pipeline; 4 grade bands; automated app review; Langfuse observability; developer SDK; Railway deployment.

### Out-of-Scope
| Item | Rationale |
|------|-----------|
| Offline mode | Product fundamentally online |
| Google Classroom LTI | Doesn't support LTI; custom API in V2 |
| Mobile native | Web + Electron for V1; Capacitor V2 |
| Marketplace billing | V1 platform-owned apps; V2 |
| Multi-language UI | English only V1 |
| Video/voice chat | Text only V1 |

### Agent Boundaries
**ALWAYS:** Tool invocation on clear intent; safety classification; token refresh; rate limiting; app lifecycle transitions.
**ASK FIRST:** District-wide suspension; data deletion; classroom config changes; app catalog approvals.
**NEVER:** Bypass safety pipeline; share student data unauthorized; allow parent DOM access; store PII in traces; downgrade from US residency.

---

## 9. Success Metrics

7 brief test scenarios + chess lifecycle + Spotify OAuth + Mission Control + safety pipeline + RLS isolation + LTI SSO + Langfuse coverage + app review pipeline — all must pass per release.

---

## 10. AI Infrastructure [BLOCKING — all 6 subsections required for ai_native Level 3]

### 10a. Observability [BLOCKING]
Langfuse self-hosted (US). Per call: prompt, response, latency, tokens, cost, model, tools, guardrails. Context: pseudonymous user_id, session_id, classroom_id, district_id. Spans: conversation_turn → [safety → llm → tool → guardrail → response].

### 10b. Eval Rubrics [BLOCKING]
| Output | Dimensions | Threshold |
|--------|-----------|-----------|
| Chat response | Helpfulness, grade-appropriateness, safety, accuracy (1-5) | Avg ≥3.5 |
| Tool routing | Correct app, intent threshold | ≥95% accuracy |
| State analysis | Factual accuracy, grade-appropriate (1-5) | Avg ≥4.0 |
| Safety classification | Precision, recall | P≥95%, R≥99% |

Offline: score golden dataset before deploy. Online: 5% trace sampling weekly. Alert: >10% drop over 7 days.

### 10c. Guardrails [BLOCKING]
Input (sequential, <600ms total): PII detection (<50ms) → injection detection (<20ms) → LLM classification (<500ms) → crisis detection (<10ms, always runs).
Output: strip PII, classify safety, enforce teacher config, prevent direct answers in Socratic mode.

### 10d. Golden Dataset [BLOCKING]
20 scored scenarios covering: tool routing (4), state analysis (1), safety (4), grade adaptation (2), teacher features (2), auth (1), context (1), error recovery (1), RLS (1), collaboration (1), completion (1), refusal (1).

### 10e. Prompt Management [BLOCKING]
Langfuse prompt registry (not in code). Semantic versioning linked to eval scores. Assembly: base + classroom_config + grade_band + tool_schemas + whisper + safety. Change: draft → score → compare → deploy → monitor 48h.

### 10f. Failure Modes [BLOCKING]
| Component | Failure | Fallback |
|-----------|---------|----------|
| Anthropic | Timeout/5xx | Retry 2x → graceful message |
| Langfuse | Down | Log locally, replay. Never block. |
| Redis | Lost | Direct DB, disable real-time |
| PostgreSQL | Lost | 503, maintenance page |
| App iframe | Unresponsive >5s | Terminate, collapse, AI acknowledges |
| Safety stage 3 | Fails | Conservative block + teacher alert |
| Spotify | Auth fail | Re-prompt OAuth |
| WebSocket | Disconnect | Auto-reconnect with backoff |

---

## 11. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Canvas/Schoology add MCP AI features | Medium | High | Ship fast, differentiate on safety depth |
| LLM hallucination on routing | Medium | Medium | Conservative routing + golden dataset |
| COPPA complexity | High | High | Architecture-first; legal review |
| Chatbox fork diverges | Medium | Low | Minimize core changes |
| OAuth in iframe restrictions | Medium | Medium | Popup pattern |
| Safety false positives | Medium | Medium | Grade-band thresholds + teacher override |

---

## 12. Traceability Index

| Persona | Journeys | Requirement Domains |
|---------|----------|-------------------|
| PER-001 Student | JRN-001, JRN-002 | CHAT, APP, STATE, AI, SAFE, AUTH, CHESS, SPOT, WTHR, COLLAB |
| PER-002 Teacher | JRN-003, JRN-004 | CTRL, SAFE, AUTH, CHAT |
| PER-003 Admin | JRN-005 | SAFE, CTRL, COMP, OBS, AUTH |
| PER-004 Developer | JRN-006 | APP, STATE, SAFE |

Orphaned personas: 0 | Orphaned journeys: 0 | Orphaned requirements: 0

---

## Appendix

**Glossary:** CBP (ChatBridge Bridge Protocol), MCP (Model Context Protocol), RLS (Row-Level Security), LTI (Learning Tools Interoperability), FEN (Forsyth-Edwards Notation), COPPA (Children's Online Privacy Protection Act), FERPA (Family Educational Rights and Privacy Act)

**References:** raw_brief.md, customer_understanding.json v1.0.0, market_research.json (11 competitors), ux_guidelines.json (48 sources), chatbox_codebase_audit.json, prd_clarifications.json, ChatBridge reference architecture
