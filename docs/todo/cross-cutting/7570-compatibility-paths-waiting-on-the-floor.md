# Compatibility paths waiting on the support floor

## Task analysis

Analysed 2026-11-10 against main at `53340356c`, from the dead-code and
fallback investigation of that day. Everything that investigation found
removable under the support window of
[version-compatibility.md](../../architecture/version-compatibility.md) was
removed in the same branch; this file holds what the window still protects,
with the date each becomes removable.

The floor is v2.21.0 until 2026-12-15, then v2.21.1 (12-15), v2.22.3
(12-16), v2.23.0 (12-18) and v2.36.0 (2027-01-02, 60 days after the
2026-11-03 Stable). Stable releases so far: v2.21.0, v2.21.1, v2.22.3,
v2.23.0, v2.36.0, v2.36.1.

### Tasks

1. **Register the unregistered paths**: add a Register row (and a usage counter where the backend can see the path) for every path in tasks 2 to 6 that has none. Status: open.
2. **Backend paths, removable 2027-01-02**: older bridges and nodes served by v2.21.0 to v2.35.x. Status: open (depends on 1; blocked until 2027-01-02).
3. **Bridge paths, removable 2027-01-02**: Claude pid-only owner records and Codex per-login state adoption. Status: open (depends on 1; blocked until 2027-01-02).
4. **Protocol and CLI paths, removable 2027-01-02**: the no-hello backend path, CLI capability gates, `legacyAutoSwitchEvent`, and a decision on `extendedDeny`. Status: open (depends on 1; blocked until 2027-01-02).
5. **Renderer paths, removable 2027-01-02**: fallbacks for backends from v2.21.0 to v2.35.x. Status: open (depends on 1; blocked until 2027-01-02).
6. **Renderer paths with no Stable release yet**: removable 60 days after the first Stable release that contains each command. Status: open (blocked until that release is 60 days old).
7. **The Claude state file written by the image**: find the first Stable release that stops reading `/tmp/.claude-state`, then remove the write. Status: open.

### 1. Register the unregistered paths

**Problem.** The rules in version-compatibility.md give every compatibility
path a Register row, an owner and a removal condition. The investigation
found about 25 paths in tasks 2 to 6 with no row, so the Stable-release
checklist in releasing.md cannot find them.

**Context.** The Register is the table under "Register" in
version-compatibility.md. Rows name the path, where it lives, its counter,
what it serves, its retire condition and its owner. Counters live in
`compatibility-path-usage.ts`.

**Investigation.** Each path in tasks 2 to 6 lists its location and the
first release with the newer behaviour, found with `git log -S` and
`git tag --contains`. Recheck each location, since line numbers drift.

**Decisions.**

- **Rows only, or rows and counters?**
  - **Rows for every path, counters for backend-visible paths (recommended).**
    - Pros: matches the documented rule; counters show whether a peer still
      needs a path before it goes.
    - Cons: a counter per path adds a few lines of code each.
  - **Rows only.**
    - Pros: documentation-only.
    - Cons: removal then has no usage evidence, which the doc asks for.

### 2. Backend paths, removable 2027-01-02

**Problem.** These backend paths serve bridges, nodes or renderers from
v2.21.0 to v2.35.x. The first Stable release with the newer behaviour is
v2.36.0, which becomes the floor on 2027-01-02.

**Context.** Paths, all under `apps/backend/src/core/`:

- Observation stream without `"observe":true` (`http-bridge/observation-stream.ts`, about line 186): bridges before 2026-10-23 (first in v2.27.0-beta).
- `/session/:id/human-prompts` 404 answered as `null` (`http-bridge/provider.ts`, about line 543): bridges before 2026-10-26 (first in v2.33.0-beta).
- The `read_host_agent_sign_ins` fallback (`agent-accounts-machines.ts`, about line 75): nodes before 2026-10-24 (first in v2.29.0-beta).
- `diffScopeUnsupported` (`coordinator-worker-changes.ts`, about lines 740-745) and the "machine predates this" auto-switch pin (`control-mcp-account-tools.ts`, about line 548): nodes before 2026-11-01 (first in v2.35.0-beta).
- `normalizeKanbanTask` rebuilding sections on every read (`storage-kanban-board.ts`, about lines 22-31): sections arrived in #1388 (first in v2.34.2-beta), so v2.21.0 to v2.34.1 write rows without them. When the floor passes, convert it into a one-time upgrade in `storage-record-upgrades.ts` (the data rule makes the upgrade permanent) and keep the `sectionsBasis` mismatch check.
- `read_file_at_branch` and `read_local_file_at_branch`: `DiffViewerTab.tsx` in v2.21.0 to v2.23.0 calls them; they are gone from v2.24.0-alpha.
- `get_coordinator_upstream_auto_merge` and `set_coordinator_upstream_auto_merge` (`commands-registry-client-state.ts`): the v2.35.5-beta renderer still calls them.

**Investigation.** Before removing, read each counter added by task 1 on
the machines you can reach, and recheck with
`git grep <symbol> v2.36.0` that v2.36.0 has the newer behaviour.

**Decisions.**

- **One change or several?**
  - **One change for the whole list on or after 2027-01-02 (recommended).**
    - Pros: one validation run; the paths share the same retire date.
    - Cons: a larger diff.
  - **One change per path.**
    - Pros: smaller reviews.
    - Cons: seven full validation runs for small edits.

### 3. Bridge paths, removable 2027-01-02

**Problem.** Two groups of bridge code read state that releases v2.21.0 to
v2.33.x still write.

**Context.**

- Claude "older bridge wrote only the pid" readers: `RecordedOwner`
  (`bridges/claude-bridge/src/.../process-identity.ts`, about line 33), lock
  metadata without `instance` (`session-preferences.ts`, about lines 237,
  360 and 406), and the two-line owner file (`change-evidence.ts`, about line
  368). They arrived in v2.34.2-beta (7d8174dff). v2.21.0 to v2.33 write
  pid-only records, and a downgrade writes them again.
- Codex per-login state adoption: `adoptLoginRecords`, the login-directory
  journal merge in `dispatch-journal.ts` (about lines 273-297), the legacy
  path in `session-title-index.ts` (about line 96), the legacy journal in
  `command-changes.ts` (about lines 91-97) and `migrateCodexChangeEvidence`.
  Until #1295 (first in v2.32.0-beta), bridges wrote state into each Codex
  account's own directory.

**Investigation.** Session records expire after 7 days of no access, so after
2027-01-02 any remaining per-login record is leftover user state rather than
skew. Titles, change evidence and journals do not expire.

**Decisions.**

- **What to do with leftover per-login Codex titles, change evidence and journals?**
  - **Adopt them once, through a one-time upgrade at bridge start, then delete the adoption code in a later release (recommended).**
    - Pros: no user loses a title or change evidence; the hot path loses the merge.
    - Cons: the one-time upgrade itself stays for the data rule.
  - **Drop them.**
    - Pros: the least code.
    - Cons: a user who never restarted a Codex session since v2.32 loses those titles.

### 4. Protocol and CLI paths, removable 2027-01-02

**Problem.** Protocol and CLI code serves backends from v2.21.0 to v2.23.0,
which have no hello handshake, and backends before two CLI capabilities.

**Context.**

- The no-hello backend path in `packages/protocol/src/node/node-link/backend-hello.ts` (about lines 81-149), and the matching `legacy-backend` route in the desktop's `connection-route-selection.ts`. The hello handshake first shipped in the unpublished v2.25.0-alpha, so v2.21.0 to v2.23.0 need it; v2.36.0 is the first Stable with it.
- The CLI's `nodeRouting` and `transcriptKnownToken` capability gates (`packages/cli`).
- `legacyAutoSwitchEvent`.
- The `extendedDeny` split in `native-agent-capabilities.ts` (from v2.34.4-beta).

**Investigation.** `extendedDeny` is safety-relevant: it may be the permanent
wire form rather than a compatibility path. Read its introduction (`git log
-S extendedDeny`) before treating it as removable.

**Decisions.**

- **Is `extendedDeny` a compatibility path?**
  - **Decide from its introducing change, and record a Register row only if it is (recommended).**
    - Pros: avoids weakening a safety boundary by mistake.
    - Cons: needs a careful read of the capability policy.
  - **Treat it as one and remove it with the rest.**
    - Pros: simpler.
    - Cons: may drop a permanent safety field.

### 5. Renderer paths, removable 2027-01-02

**Problem.** These renderer fallbacks serve backends without a command or
field that first reached a Stable release in v2.36.0.

**Context.** Paths under `apps/web/src/`:

| Path | Where | First tag |
| --- | --- | --- |
| `get_ticket_sync_status` unknown-command | `TicketSyncStrip.tsx` | v2.36.0 |
| `arrange_projects_by_intent` fallback | `lib/backend/projects-environments.ts`, `lib/federation/remote-project-writes.ts` | v2.35.2-beta (draft) |
| `patch_repository_settings` fallback | `lib/backend/config-integrations.ts` | v2.35.2-beta |
| `patch_global_config` fallback | `lib/portal/command-node-config.ts` | v2.35.2-beta |
| `get_node_status` read as "no command-node support" | `lib/portal/portal-store.ts` | v2.25.0-alpha (draft) |
| Ticket `kind`/`sections` optional, derived from text | `lib/backend/kanban.ts`, `tickets/ticket-content.ts` | v2.34.2-beta |
| `containerTerminals` absent | `HostUpdatesPanel.tsx` | v2.32.0-beta |
| Change-tracking older-backend catches (not the transcript-row presentation, which is permanent) | `changes/subscriptions.ts` | v2.24.0-alpha |
| MCP environment overlay commands | `McpEnvironmentOverlay.tsx` | v2.27.0-beta |

The backend keeps `update_global_config` and `arrange_projects` for older
clients; they are not purely compatibility code while current web calls
them, so check their callers at the same time.

**Investigation.** Recheck each with `git grep <command> v2.36.0 --
apps/backend/src`.

**Decisions.**

- **Remove all at once on 2027-01-02 (recommended)**, in the same change as
  task 2 if both are ready: one validation run. The alternative, per-path
  changes, costs a full run each.

### 6. Renderer paths with no Stable release yet

**Problem.** These renderer fallbacks handle backends without commands that
have only shipped in betas or alphas.

**Context.**

| Path | Where | First tag |
| --- | --- | --- |
| `record_domain_adapter_usage` | `domain-adapter-usage-ring.ts` | v2.37.0-alpha |
| `get_fleet_update_policy` | `FleetUpdatePolicySection.tsx` | v2.37.0-alpha |
| `get_coordinator_account_switch_grant` | `lib/backend/agent-accounts.ts` | v2.36.2-beta |
| `reauthenticate_agent_account` | `lib/backend/agent-accounts.ts` | v2.37.2-beta |
| Coordinator activity and launch-override unsupported latches | `coordinatorActivityStore.ts`, `coordinatorLaunchOverrideStore.ts` | v2.37.4-beta |

**Investigation.** When the next Stable release is published, its date plus
60 days is the removal date for every row here. Write that date into this
task then.

**Decisions.** None until that release exists.

### 7. The Claude state file written by the image

**Problem.** `docker/orkestrator-state-signal.sh` writes
`/tmp/.claude-state`. The investigation assumed only v2.21.x read it, but
`git grep claude-state v2.36.0 -- apps/backend/src` still finds readers
(`tmux-poll.ts`, `claude-state-signal.ts`, `tmux-hook-signal.ts`).

**Context.** A new image must keep working under every backend in the
window, so the write stays while any supported backend reads the file.

**Investigation.** Find whether HEAD still reads it (through
`ORKESTRATOR_STATE_FILE` or the default path), and the first Stable release
that does not. If HEAD still reads it, this is not a compatibility path and
the task closes.

**Decisions.**

- **Close the task if HEAD reads the file (recommended)**; otherwise set the
  removal date to 60 days after the first Stable release that does not.

## Current state

Nothing in this file is removable on 2026-11-10. The rollback switches the
investigation found are tracked where they already were: the remaining
`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` drivers in
[0048](../transcripts-and-observation/0048-recurring-work-qualification.md)
task 13 (with `ORKESTRATOR_NATIVE_OBSERVATION_SHARING`, which waited on 0049
until it was retired on 2026-11-11), and
`ORKESTRATOR_EGRESS_FILTER=off` in 6101. The retired-command Register rows
(195 to 200 at the time of writing) wait on the next Stable release and
their counters.

## Constraints and rationale

- Migrations and record upgrades are permanent; only per-load readers turn
  into one-time upgrades.
- Detect by shape or capability, never by version number.
- Before removing a counted path, read its counter on the machines you can
  reach.

## Related

- [version-compatibility.md](../../architecture/version-compatibility.md)
- [Cross-cutting index](0000-index.md)
