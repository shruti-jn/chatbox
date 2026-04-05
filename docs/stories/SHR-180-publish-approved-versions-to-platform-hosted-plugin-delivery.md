## SHR-180 — Publish approved versions to platform-hosted plugin delivery

### Story Summary
Separate reviewer approval from platform publish so the control plane can approve a plugin version, publish it to a platform-hosted immutable URL, and roll runtime traffic back to a prior approved version without re-reviewing the whole submission.

### Dependencies And Assumptions
- Depends on artifact upload and immutable artifact metadata from `SHR-178`.
- Depends on review decisions producing an `approved` version state from `SHR-188`.
- Runtime registry consumers must continue reading only platform-published versions, never merely approved ones.
- This story assumes platform hosting metadata is derived by the control plane and not supplied by the developer.

### Behavioral Assertions
- When a reviewer approves or waives a submitted version, the version moves to `approved` and does not appear in runtime registry listings yet.
- When platform publish is triggered for an approved version with an uploaded artifact, the version moves to `published`, receives platform-generated `publishMetadata`, and becomes the active runtime version.
- When a newer version is published, any previously active published version is deprecated and removed from active registry resolution.
- When rollback targets a prior approved or previously published version, the target becomes the active published version and runtime registry resolution flips back to that version.
- When publish is requested for a non-approved version, the control plane rejects the request.
- What counts as proof for this story:
  - runtime registry endpoints only expose versions after explicit publish
  - publish metadata is platform-generated and tied to the uploaded artifact hash
  - rollback updates active registry resolution without changing developer-supplied manifest contents
- What does not count as proof:
  - approval alone
  - developer-hosted URLs
  - grep-level confirmation without asserting runtime registry behavior

### Cross-Story Notes
- `SHR-181` runtime registry behavior now depends on explicit publish semantics.
- Future runtime event and rollout stories should treat publish and rollback as separate auditable control-plane events.
