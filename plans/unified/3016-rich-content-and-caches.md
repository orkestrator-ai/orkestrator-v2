---
id: 3016
title: "Rich content, byte-bounded caches and capability caches per node"
phase: 3
plan: "§7.4 special cases and §12 Phase 3.9"
status: not-started
depends_on: [2001, 2003]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3016 · Rich content, byte-bounded caches and capability caches per node

- **Report:** [§7.4](../../docs/reports/unified-federation.md#74-services-and-module-state), [Appendix B](../../docs/reports/unified-federation.md#appendix-b-module-singletons)
- **Depends on:** [2001](2001-node-scope-core.md), [2003](2003-browser-credentials-and-auth-transport.md)
- **Blocks:** [3004](3004-project-and-environment-stores.md), [3008](3008-terminal-portal-and-artifact-hosts.md), [3009](3009-agent-and-transcript-stores.md), [3012](3012-workflow-stores-b.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Several live nodes neither clear each other's protected content nor multiply cache memory. Capability answers are cached per node.

## Current state (verified 2026-11-07)

- `lib/chat/rich-content-reset.ts:133-152`: identity and connection notes are module singletons, so a second backend identity clears everything.
- Byte-bounded caches, which should become node-qualified keys under window budgets:
  - `lib/chat/artifact-requests.ts`
  - `image-preview-cache.ts`
  - `rich-markdown/media-resolver.ts`
  - `useArtifactPublications.ts`
- Capability caches, each holding one answer per backend:
  - `client-state-capabilities.ts` (75 LOC, module lets at :13-16)
  - `backend/changes.ts:129`
  - `design-client.ts:109`
  - `useNativeAgentSession.ts:129-143`
  - `useTranscriptArtifactCapabilities.ts`

## Work

- [ ] Per-node identity and connection tracking in `rich-content-reset`. Clear by node, using the mechanism from [2003](2003-browser-credentials-and-auth-transport.md).
- [ ] Caches key by `(nodeId, key)` and reserve from the window `ByteBudget`.
- [ ] Capability caches move onto the scope. They are later folded into domain versions in Phase 7.

## Tests

- [ ] Two identities live at once: neither clears the other; one window budget is shared; a scope's capability cache is independent.

## Done when

- [ ] No module-level capability or identity singleton remains in the listed files.
