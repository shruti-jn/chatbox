# SHR-178: Artifact Upload And Version Submission Pipeline

## Story Summary

Developers can create a plugin version, upload an artifact bundle for that version, and submit it for review only after the version is complete. The platform stores immutable artifact metadata so later scan, review, and publish stages can reference the exact uploaded bundle.

## Dependencies And Assumptions

- Assumes manifest validation happens when the version record is created.
- Assumes artifact storage remains platform-controlled and keyed by plugin slug plus version record.
- Assumes later publish workflow stories will consume the stored `storageKey`, `sha256`, and artifact inventory produced here.

## Behavioral Assertions

1. A developer can create a version record for an existing plugin.
2. An artifact upload stores immutable metadata: normalized filename, content hash, size, and storage key.
3. Artifact bytes are persisted so later pipeline stages can retrieve the exact uploaded content.
4. Archive uploads produce a deterministic file inventory for later review and publish checks.
5. Unsafe archive traversal paths are rejected before inventory or metadata are persisted.
6. A version cannot transition to submitted unless both manifest and artifact are present.
