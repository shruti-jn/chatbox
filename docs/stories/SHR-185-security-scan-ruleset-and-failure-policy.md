# SHR-185: Submission Security Scanning Ruleset And Failure Policy

## Story Summary

Define the concrete, versioned security scanning policy for third-party plugin submissions so the platform can explain why a submission failed, warned, or required manual review. The policy must cover static analysis, dependency/SCA checks, blocked behavior patterns, and thresholds that reviewers can cite during approval.

## Dependencies And Assumptions

- Assumes scan execution will land in a later story; this story defines the policy contract and deterministic threshold behavior.
- Assumes production plugin delivery remains platform-controlled, so scan policy is advisory to publish workflow and not a substitute for hosted delivery controls.
- Assumes reviewers need a single source of truth for blocked patterns and severity thresholds, rather than copying policy into freeform review notes.

## Behavioral Assertions

1. Every scan run must reference a concrete `rulesetVersion`.
2. Dynamic code execution, tracking SDKs, and undeclared network destinations are explicit blocked patterns and do not rely on reviewer interpretation alone.
3. Obfuscation and suspicious bundling behavior cannot silently pass; they must at least trigger manual review.
4. Dependency/SCA policy is first-class and includes hard-fail rules for known exploited or critical unpatched packages.
5. Severity thresholds are documented, deterministic, and machine-readable.
6. Reviewer decisions can reference the ruleset version and specific finding rule IDs that informed the decision.

## What Counts As Proof

- Static-analysis signatures or AST matches tied to a policy rule.
- Bundle-inspection evidence showing obfuscation, remote loaders, hidden payloads, or artifact anomalies.
- Dependency advisories or SCA evidence tied to affected packages and versions.
- Manifest-to-observed-behavior mismatches such as undeclared network destinations.

## What Does Not Count

- A developer saying a pattern is benign without independent evidence.
- A generic “scan passed” note with no ruleset version.
- Severity labels with no rule ID or threshold rationale.

## Underspecified / Follow-On Areas

- Actual scanner implementation and artifact unpacking pipeline.
- Runtime correlation between post-approval evidence and the submission-time scan ruleset.
- Ownership and queues for manual-review findings once scanners emit them.
