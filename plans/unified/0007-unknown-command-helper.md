---
id: 0007
title: "Fix the unknown-command helper that never matches"
phase: 0
plan: "§11.1 (found during research)"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] Make `lib/portal/unknown-command.ts` delegate to the protocol `isUnknownCommandError`, keeping its "not available in this backend" case.
- [x] Check each of its five callers: what fallback was meant to run on an older node, and does it run now? Record the answer per caller in Notes, because a fallback that never ran may itself be broken.
- [x] Do not convert the 11 inline matches here. That is [1005](1005-typed-incompatibility-errors.md). List any that are also wrong.

## Tests

- [x] The helper matches the exact string the backend throws (import the backend's message builder or the protocol's `unknownBackendCommandMessage`), not a hand-typed copy.
- [x] One test per caller where the fallback changes behaviour.

## Done when

- [x] All five callers take their fallback against a backend that lacks the command.

## Notes

- **Change.** `isUnknownBackendCommand` now returns `isUnknownCommandError(error, command)` from `@orkestrator/protocol/unknown-command` (the exact `Unknown backend command: <name>` answer, a wrapper prefix allowed, a longer name refused), or the kept case: the message names the command and says "not available in this backend". The `Unknown command: <name>` arm is gone; no backend sends it. The kept case also never matches today: every backend "not available in this backend" message names a feature, not a command (`commands-registry-nodes.ts:52-64`, `commands-registry-ticket-sync.ts:47`, …).
- **How the answer reaches each caller.** A direct invoke carries the backend's text: the gateway returns it as `{ error }` (`gateway-handlers.ts`), and the desktop preload strips Electron's "Error invoking remote method" prefix (`preload-api.ts:42-49`). A routed `invoke_on_node` rethrows the leaf's error unchanged (`node-routing.ts` `routeToNode`), so the command node returns the same text. `backend-core.test.ts:46` pins the real dispatcher's wording, and `packages/protocol/src/unknown-command.test.ts` pins `unknownBackendCommandMessage` to it.
- **Per caller** (each fallback had never run against a real backend: every one of them threw the backend's error instead):
  1. `lib/backend/agent-accounts.ts` `getCoordinatorAccountSwitchGrant`. Meant: a machine older than the grant (added 2026-11-04, #1744) reads as `null`, so `CoordinatorAccountSwitchGrant.tsx` renders nothing and coordinators keep asking. Before: the section showed the raw "Unknown backend command: get_coordinator_account_switch_grant" in red. Now: `null`, on the local path and routed through `invoke_on_node`. Fallback is sound.
  2. `lib/backend/projects-environments.ts` `arrangeProjectsByIntent`. Meant: a backend older than `arrange_projects_by_intent` (2026-11-01, #1549) gets the client's preview as a whole `arrange_projects`. Before: every sidebar drag against such a backend failed. Now: falls back. `arrange_projects` takes `{ projectIds, folders }` with `assertOnlyKeys` at v2.21.0 (the floor), the same shape sent. Fallback is sound.
  3. `lib/backend/config-integrations.ts` `patchRepositorySettings`. Meant: a backend older than `patch_repository_settings` (2026-11-01) gets the whole record through `update_repository_config`. Before: repository settings saves failed. Now: falls back; `update_repository_config { projectId, repoConfig }` is unchanged since v2.21.0, and the whole record drops unset keys as intended. Fallback is sound.
  4. `lib/federation/remote-project-writes.ts` (routed arrangement writes). Meant: an owner older than intents gets the latest whole arrangement via `invoke_on_node` `arrange_projects`, and queued intents are dropped. Before: the drag on another machine's projects was reported as an error and the overlay forgotten. Now: falls back. Fallback is sound.
  5. `lib/portal/command-node-config.ts` `patchGlobalOnNode`. Meant: a node older than `patch_global_config` (2026-11-01) gets read-merge-write (`get_config`, then `update_global_config`). Before: settings saves to such a node failed. Now: falls back. Checked at v2.21.0: `update_global_config` strips renderer credentials and preserves stored ones, so writing back the redacted `get_config` copy loses no secret. `preserveInheritedSettings` (added 2026-10-22) is ignored by v2.21.0–v2.23.0, which have no inherited settings to protect. The merge is not atomic, which is the older behaviour by design. Fallback is sound.
- **Tests.** The four existing fallback tests (`lib/backend.test.ts` "commands an older backend may not know" for callers 2 and 3, `remote-project-writes.test.ts` for 4, `command-node-config.test.ts` for 5) hand-typed `Unknown command: <name>`, which is why they passed while production never matched. They now build the error with `unknownBackendCommandMessage`. Caller 1 had no test; `agent-accounts.test.ts` gains one (local and routed paths, and a non-matching failure still throws). New `lib/portal/unknown-command.test.ts` covers the helper. With the old helper restored, all 7 of those tests fail; with the new one they pass.
- **Inline matches that are also wrong** (not converted; [1005](1005-typed-incompatibility-errors.md)):
  - `lib/portal/portal-layout.ts:51` `unsupportedCommand` and `lib/portal/portal-store.ts:175` (`unsupported`): `/unknown command|not available in this backend/i` does not match `Unknown backend command: …`. Only a backend without the command-node service ("… is not available in this backend") is recognised; a backend that predates the portal commands is not. `portal-layout.test.ts:112` hand-types `Unknown command: get_portal_layout`, so its test passes regardless.
  - Not command-specific (any command's unknown answer counts, for example one from a nested call): `lib/agent-handoff.ts:212`, `lib/backend/agent-handoffs.ts:77`, `lib/backend/terminals.ts:254`, `lib/read-coordinator.ts:353`.
  - No name boundary (a longer command name would also match): `hooks/useNativeAgentSession.ts:367`, `lib/resource-sync.ts:354` and `:473`, and `lib/backend/shared.ts:51` `isUnsupportedBackendCommand` (whose `Unknown command:` arm is also dead).
  - Anchored at the start of the message: `lib/design-client.ts:51`, `lib/chat/media-presentation.ts:102`. Correct today, because the preload strips Electron's prefix and routed errors pass unchanged, but any added wrapper prefix would break them.
- **Evidence level.** "All five callers take their fallback" is shown by unit tests driving each caller's real code with the backend's exact text (transport mocked), and by the wording chain above. No live check against an older backend was run.
- Web typecheck on 2026-11-07 reported 2 errors, both in other agents' untracked files (`src/lib/node-scope/byte-budget.ts`, `src/test/render-in-node-scope.tsx`); none in this item's files.
- Effect: not used; a synchronous string predicate shared with a browser bundle.

## Work log

- 2026-11-07 (claude-worker): `isUnknownBackendCommand` delegates to the protocol `isUnknownCommandError`, keeping the "not available in this backend" case. Five caller tests now use `unknownBackendCommandMessage` (one new for `getCoordinatorAccountSwitchGrant`), plus `unknown-command.test.ts`. Tests: the 5 files, 151 pass, 0 fail (`test:logged --name unknown-command`). oxlint and `bun fmt` clean on the touched files. Web typecheck: no errors in these files (2 in other agents' untracked files).
