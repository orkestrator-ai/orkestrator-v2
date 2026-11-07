---
id: 0007
title: "Fix the unknown-command helper that never matches"
phase: 0
plan: "§11.1 (found during research)"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 0007 · Fix the unknown-command helper that never matches

- **Report:** [§11.1](../../docs/reports/unified-federation.md#111-where-skew-actually-is) mentions two text-matching helpers. Research for this plan found a third, and found that one of the two never matches.
- **Depends on:** none
- **Blocks:** nothing, but [1005](1005-typed-incompatibility-errors.md) replaces all of them
- **Parallel with:** everything
- **Size:** S
- **Track:** F (fixes now)

## Goal

Every client check for "this backend does not have that command" recognises what real backends send. Older nodes get the intended fallback instead of an error.

## Current state (verified 2026-11-07)

- Backends answer `Unknown backend command: <name>`:
  - `apps/backend/src/core/index.ts:3019-3024` and 6 other sites in that file
  - `public-api/dispatch.ts:131`
- `apps/web/src/lib/portal/unknown-command.ts` `isUnknownBackendCommand` matches only `Unknown command: X`, or the name plus "not available in this backend". `packages/protocol/src/unknown-command.ts:5-9` says no backend has ever answered `Unknown command:`. So this helper misses real answers. Its callers:
  - `lib/backend/agent-accounts.ts:138`
  - `lib/backend/config-integrations.ts:423`
  - `lib/backend/projects-environments.ts:180`
  - `lib/federation/remote-project-writes.ts:139`
  - `lib/portal/command-node-config.ts:102`
- `apps/web/src/lib/backend/shared.ts:51` `isUnsupportedBackendCommand` matches both spellings. It has 5 callers.
- `packages/protocol/src/unknown-command.ts` `isUnknownCommandError` is used by 9 files.
- About 11 more inline text matches exist in the web app: `useNativeAgentSession.ts:367`, `agent-handoff.ts:212`, `backend/agent-handoffs.ts:77`, `terminals.ts:254`, `chat/media-presentation.ts:102`, `design-client.ts:51`, `portal/portal-layout.ts:51`, `portal/portal-store.ts:175`, `read-coordinator.ts:343`, `resource-sync.ts:354, 473`.

## Work

- [ ] Make `lib/portal/unknown-command.ts` delegate to the protocol `isUnknownCommandError`, keeping its "not available in this backend" case.
- [ ] Check each of its five callers: what fallback was meant to run on an older node, and does it run now? Record the answer per caller in Notes, because a fallback that never ran may itself be broken.
- [ ] Do not convert the 11 inline matches here. That is [1005](1005-typed-incompatibility-errors.md). List any that are also wrong.

## Tests

- [ ] The helper matches the exact string the backend throws (import the backend's message builder or the protocol's `unknownBackendCommandMessage`), not a hand-typed copy.
- [ ] One test per caller where the fallback changes behaviour.

## Done when

- [ ] All five callers take their fallback against a backend that lacks the command.
