# SHR-188: Reviewer Rubric And Approval Decision Framework

## Story Summary

Add a repeatable manual review framework for the developer platform so reviewers cannot approve third-party plugins with only freeform notes. Every decision needs a checklist outcome, structured reason code, reviewer evidence, and a clear distinction between clean approvals, waivers, rejections, and escalations.

## Behavioral Assertions

1. A plugin version is publishable only after a structured review decision that includes reviewer identity, checklist results, and independent evidence.
2. A clean approval must fail validation if any checklist item is failed or waived.
3. A waiver must record explicit waiver metadata and remain distinguishable from a clean approval in audit history.
4. An escalation must record a defined escalation path and must not publish the version into the runtime registry.
5. Developer claims alone do not count as proof for approval; at least one platform-generated or reviewer-captured proof artifact is required.
6. The rubric itself must be retrievable from the service so review UIs and workflows can stay aligned with the same checklist, reason codes, and escalation rules.

## Proof Standard

- Counts as proof: platform scan output, artifact hash verification, reviewer-captured runtime evidence, linked policy documents.
- Does not count as proof on its own: developer notes, copied manifest text, or generic "scan passed" statements with no linked evidence.

## Dependencies And Assumptions

- Assumes the developer platform service remains a separate package in the monorepo and owns manual review workflows.
- Assumes later stories will add persistent identities, reviewer authz, scan-finding IDs, and artifact storage beyond the current file-backed store.
- Assumes publish still occurs immediately after an approval or waiver in the current prototype; production rollout controls belong to later workflow stories.

## Policy Gaps Still Open

- No reviewer authentication or role enforcement yet.
- No runtime-enforcement feedback loop yet; runtime evidence is represented structurally, but ingestion and correlation land in later stories.
- No legal/privacy reviewer assignment workflow yet; escalation paths are defined, but not routed to actual queues or owners.
