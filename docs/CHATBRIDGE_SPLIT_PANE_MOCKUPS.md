# Split-Pane Mockup Coverage

This document records the six mockups that now map to the ChatBridge v2 split-pane workspace for SHR-170, SHR-169, and SHR-171.

## Covered mockups

1. `specs/mockups/student-chat.html`
Desktop baseline for the three-column experience: global sidebar, center app workspace, right chat rail.

2. `specs/mockups/student-chat--empty.html`
No active app in the center column. Chat remains primary and the workspace shell stays unobtrusive.

3. `specs/mockups/student-chat--loading.html`
New panel app opens with the workspace visible while chat remains readable during load.

4. `specs/mockups/student-chat--error.html`
Panel failures stay scoped to the app workspace without collapsing the whole conversation view.

5. `specs/mockups/student-chat--collaborative.html`
The chat rail must remain legible even when app activity and collaboration are both present.

6. `specs/mockups/student-chat--mobile.html`
On constrained widths, the split-pane workspace degrades gracefully by prioritizing chat and compact app controls.

## Behavioral mapping

- `uiManifest.displayMode = "panel"` routes app instances into the center workspace column instead of embedding a live iframe inline in chat.
- `uiManifest.displayMode = "inline"` preserves the existing inline app-card behavior inside assistant messages.
- Minimized panel apps remain resumable through the mini player strip so app state can continue in the background.
- Opening a newer panel app steals workspace focus while older panel apps remain recoverable from the mini player.
