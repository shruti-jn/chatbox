`SHR-179` behavioral assertions

1. When a submitted version has an uploaded artifact, submission automatically creates a scan run and waits for a terminal scan outcome before returning.
2. When automated scan findings include blocker evidence, the version ends in `scan_failed` instead of entering review.
3. When automated scan findings are non-blocking, the version ends in `awaiting_review` with a persisted completed scan run.
4. When scan execution crashes after a version enters `scanning`, the scan run ends in `failed` and the version is forced into a recoverable terminal state of `scan_failed`.
5. When a version is already `published`, `approved`, `deprecated`, or `rolled_back`, the workflow rejects a new scan run rather than destabilizing runtime registry resolution.

Proof expectations

- Assertions must be verified by store or API behavior, not by static text inspection.
- Audit history must retain the scan run record even when execution fails.
- Manual review decisions must continue to reference real persisted scan run IDs.
