# SHR-181: Runtime Registry API For ChatBridge Integration

## Story Summary

Expose registry endpoints that ChatBridge runtime can use to discover approved plugins, fetch the active platform-hosted version for a plugin, retrieve policy metadata, and build a flattened tool manifest for routing and iframe rendering.

## Dependencies And Assumptions

- Assumes plugin versions reach `published` only after review and publish workflow decisions.
- Assumes runtime should only ever receive platform-hosted URLs.
- Assumes district/classroom context is part of the registry contract even if the current prototype does not yet persist district-specific plugin policy overrides.

## Behavioral Assertions

1. Runtime registry app listings return only enabled, approved, platform-hosted plugins.
2. Runtime registry version lookups return active version, hosted URL, trust tier, and status for a single plugin.
3. Runtime policy lookups return enough metadata for iframe policy and tool-use constraints.
4. Flattened tool-manifest responses provide one entry per tool with plugin metadata attached, so ChatBridge can inject tools into routing without extra joins.
5. Draft, rejected, scan-failed, suspended, or otherwise non-runtime-ready plugins are filtered from the runtime registry surface by default.
