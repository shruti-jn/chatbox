`SHR-176` behavioral assertions

1. When a plugin is created, the registry persists a first-class developer record and links the plugin to that developer instead of leaving ownership implicit.
2. When plugin creation includes DPA metadata, the registry persists a first-class DPA record linked to the same developer for auditability.
3. When audit views are requested for a plugin, they include the linked developer record and DPA history alongside scan, review, publish, and runtime control events.
4. Lifecycle state remains explicit at the version level for upload, scan, review, publish, rollback, and runtime lookup decisions.
5. District overrides and runtime audit data remain attached to the plugin without breaking developer or DPA linkage.

Dependencies and assumptions

- Reviewer authz and district policy ownership are handled by later stories.
- This story establishes schema and persisted relationships; richer CRUD for developers and DPA workflows can land separately.
- Existing plugin creation flows remain backward-compatible, so developer and DPA metadata may be defaulted when not supplied.
