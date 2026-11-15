# Retire the compatibility paths the contract tooling still pins

## Task analysis

Analysed 2026-11-15 against main at `a8b89f154`. Created by the
legacy-retirement sweep (to-do 8108, retired 2026-11-15) for the paths it
could not remove without changing the contract tooling, which 8108 kept
unchanged until the user approves a forward compatibility policy.

### Tasks

1. **Remove the contract-pinned paths once the forward policy allows it**: the domain client adapters below each domain's current version, the legacy capability commands and the commands kept registered only for older clients. Status: open (blocked: waits on the user's forward-policy decision, 7568 item "8111 task 1").

### 1. Remove the contract-pinned paths once the forward policy allows it

**Problem.** The user decided on 2026-11-14 that all legacy support retires
now, with every machine and client updated together. The sweep removed every
compatibility path it could, but the contract CI job (`scripts/contract-ci.ts`,
`mise run contract:ci`) still computes the support floor from the 60-day
window and fails when:

- an in-window release speaks a (domain, version) whose client adapter is gone
  (`contracts/adapters.json`);
- a command an in-window release registered disappears without a domain bump
  and a register row;
- a `LEGACY_CAPABILITY_COMMANDS` command is retired before its condition.

So these paths stay in the tree although nothing the user runs needs them.

**Context.** What stays, with its register row in
[version-compatibility.md](../../architecture/version-compatibility.md#register):

- Every domain client adapter below its domain's current version, including
  adapter 0 (the pre-contract capability checks) of every domain
  (`packages/protocol/src/contract/domains/*/client.ts`,
  `apps/backend/src/core/nodes/node-domain-clients.ts`), and the
  `domain-adapter.*` counters. Code inside adapter 0, such as `node-mail` and
  `ticket-sync`'s hello-capability checks for leaves, stays with it.
- The capability commands kept for pre-contract renderers:
  `get_client_state_capabilities`, `get_native_agent_sync_capabilities`,
  `get_agent_handoff_capabilities` (`contracts/retirements.json`).
- Commands kept registered for older clients: `hide_coordinator_work`,
  `associate_coordinator_workflow`, `start_coordinator_multi_review`,
  `start_coordinator_node_multi_review`, the five `check_*_cli` commands,
  `cleanup_stale_local_servers_cmd`, `read_file_at_branch`,
  `read_local_file_at_branch`, `get_coordinator_upstream_auto_merge`,
  `set_coordinator_upstream_auto_merge`, and their `retired-command.*`
  counters; `save_agent_handoff`, `delete_agent_handoff` and
  `prune_agent_handoffs`; `claim_feature_plan_build` (its renderer
  sequence went with the one-request launch fallback); `update_global_config`
  and `arrange_projects` where no current caller is left.
- The `config` domain's workspace-client config writes: the echo answer for
  realms from before `patch_global_config` (`isGlobalConfigEcho`,
  `answerConfigEcho`, counter `workspace-grant.config-echo`) and
  `RETIRED_GLOBAL_SETTING_KEYS` with the `openCodeProtocol` schema fields.
  Refusing the writes outright or dropping the fields changes registered
  commands and schemas.
- Optional result fields that can become required only with a schema change:
  `legacyRuntimes` on `docker_cleanup_preview` (`DockerCleanupReview.tsx`)
  and `deleteFailure`/`deletingSince` on environment summaries
  (`environment-row-facts.ts`).
- Result fields no backend sets any more, kept so the registered result
  schemas are unchanged: `diffScopeUnsupported` in the coordinator
  worker-changes result (`schemas-controller.ts`) and `instructionsIgnored`
  in the native-sessions dispatch and session-action outcomes
  (`native-sessions/schemas.ts`).

The 2026-11-14 sweep note in
[version-compatibility.md](../../architecture/version-compatibility.md#the-support-window)
records that the window text stays the written policy until the user approves
a replacement.

**Investigation.** On 2026-11-15 the manifest had 29 domains, every one at
version 1 or higher, each with adapters down to 0
(`packages/protocol/contracts/adapters.json`). Every in-window release
snapshot under `packages/protocol/contracts/releases/` still names the kept
commands, so `checkRemovedCommands` would fail on each one without a domain
bump. Bumping a domain to remove a command adds an old-version adapter, which
is more compatibility code, not less.

**Decisions.**

- **How does the contract tooling follow the sweep?** This decision is
  reserved to the user (8108's "Not decided"); the checklist item asks it.
  - **Record a one-time floor at the sweep release: `contract-ci.ts` treats
    every release before the first release built from the sweep as outside
    the window, then delete the adapters, capability commands and kept
    commands with their register rows (recommended).**
    - Pros: matches the decision; the tooling stays as the guard for later
      changes; one edit to the floor computation.
    - Cons: the window text needs a matching sentence; release snapshots
      below the new floor stay on disk unused until pruned.
  - **Keep the 60-day window and let these paths retire on its schedule.**
    - Pros: no tooling change.
    - Cons: keeps code nothing runs for about two more months.
  - **Drop the window and the contract CI checks altogether.**
    - Pros: the least machinery.
    - Cons: loses the guard that a later change does not break a client the
      user still runs.

## Constraints and rationale

- Stored user data is not version skew; nothing here reads stored data.
- Removing an adapter needs `mise run contract:adapters` and
  `contract:manifest`, and its register rows move to Retired in the same
  change.

## Related

- [7568](../manual-test/7568-manual-test-checklist.md): the forward-policy
  decision (8111 task 1).
- [version-compatibility.md](../../architecture/version-compatibility.md):
  the register, the Retired table and the sweep note.
- [8109](8109-decided-removal-candidates.md): `import_legacy_build_pipelines`
  and the other removals the user decided on 2026-11-14.
