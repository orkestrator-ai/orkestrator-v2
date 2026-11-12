# Compatibility paths waiting on the support floor

## Task analysis

Analysed 2026-11-11 against main at `963ffa6ab` (first analysed 2026-11-10
against `53340356c`, from the dead-code and fallback investigation of that
day). Everything that investigation found removable under the support window
of [version-compatibility.md](../../architecture/version-compatibility.md)
was removed in the same branch; this file holds what the window still
protects, with the date each becomes removable.

The floor is v2.21.0 until 2026-12-15, then v2.21.1 (12-15), v2.22.3
(12-16), v2.23.0 (12-18) and v2.36.0 (2027-01-02, 60 days after the
2026-11-03 Stable). Stable releases so far: v2.21.0, v2.21.1, v2.22.3,
v2.23.0, v2.36.0, v2.36.1; the newest tag on 2026-11-11 is v2.37.6-beta, so
no Stable release carries anything first shipped after v2.36.1.

On 2026-11-11 the floor was still v2.21.0, so no path in tasks 2 to 7 was
removable; every one of them serves a release the window still covers.

### Tasks

1. **Register the unregistered paths**: add a Register row (and a usage counter where the backend can see the path) for every path in tasks 2 to 7 that has none. Status: done (2026-11-11).
2. **Backend paths, removable 2027-01-02**: older bridges and nodes served by v2.21.0 to v2.35.x. Status: open (blocked until 2027-01-02; the real-install counter reads wait on 7568: 7570 task 2).
3. **Bridge paths, removable 2027-01-02**: Claude pid-only owner records and Codex per-login state adoption. Status: open (blocked until 2027-01-02).
4. **Protocol and CLI paths, removable 2027-01-02**: the no-hello backend path and the CLI capability gates; `extendedDeny` was decided not to be a compatibility path. Status: open (blocked until 2027-01-02).
5. **Renderer paths, removable 2027-01-02**: fallbacks for backends from v2.21.0 to v2.35.x. Status: open (blocked until 2027-01-02).
6. **Paths with no Stable release yet**: removable 60 days after the first Stable release that contains each command or field, now including `legacyAutoSwitchEvent`. Status: open (blocked until that release is 60 days old).
7. **The legacy Claude state file written by the image**: stop writing `/tmp/.claude-state` once the floor is v2.22.3. Status: open (blocked until 2026-12-16).

### 1. Register the unregistered paths

**Problem.** The rules in version-compatibility.md give every compatibility
path a Register row, an owner and a removal condition. The investigation
found about 25 paths in tasks 2 to 6 with no row, so the Stable-release
checklist in releasing.md could not find them.

**Context.** The Register is the table under "Register" in
version-compatibility.md. Rows name the path, where it lives, its counter,
what it serves, its retire condition and its owner. Counters live in
`compatibility-path-usage.ts`; the contract CI job
(`scripts/contract-ci-register.ts`) refuses a Counter cell naming an id that
is not in `COMPATIBILITY_PATH_IDS`.

**Investigation.** Done on 2026-11-11. Every location below was rechecked at
`963ffa6ab` and each first release was rechecked with `git log -S` and
`git tag --contains`. Every path now has a row whose owner is this file and
its task. Backend-visible paths got a counter, each covered by a test:

| Counter | Path | Test |
| --- | --- | --- |
| `bridge-observation.full-stream` | Observation stream without `"observe":true` | `http-bridge/observation-stream.test.ts` |
| `bridge-human-prompts.missing-route` | `/human-prompts` 404 or 405 | `http-bridge/provider.test.ts` |
| `host-agent-sign-ins.older-node` | `read_host_agent_sign_ins` unknown-command | `agent-accounts-machines.test.ts` |
| `worker-changes.diff-scope-older-node` | `diffScopeUnsupported` (now `olderNodeDiffScopeNote`) | `coordinator-worker-changes.test.ts` |
| `auto-switch.older-node` | A node's account list with no automatic-switch state | `coordinator-timers-and-accounts.test.ts` |
| `kanban.legacy-row-derived` | `normalizeKanbanTask` deriving sections | `storage-kanban-sections.test.ts` |
| `retired-command.read-file-at-branch` | `read_file_at_branch`, `read_local_file_at_branch` | `tests/commands-io-coverage.test.ts`, `compatibility-path-recording.test.ts` |
| `retired-command.coordinator-upstream-auto-merge` | `get_`/`set_coordinator_upstream_auto_merge` | `compatibility-path-recording.test.ts` |

Bridge, desktop, CLI, container and renderer paths have rows with
"None (… side)": the backend cannot observe them.

**Decisions.**

- **Rows only, or rows and counters?**
  - **Rows for every path, counters for backend-visible paths (recommended, done).**
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

**Context.** Paths, all under `apps/backend/src/core/`, each with a Register
row and a counter (task 1):

- Observation stream without `"observe":true` (`http-bridge/observation-stream.ts`, `accept`): bridges before 2026-10-23 (first in v2.27.0-beta).
- `/session/:id/human-prompts` 404 or 405 answered as `null` (`http-bridge/human-prompts.ts`, `readBridgeHumanPrompts`): bridges before 2026-10-26 (first in v2.33.0-beta).
- The `read_host_agent_sign_ins` fallback (`agent-accounts-machines.ts`): nodes before 2026-10-24 (first in v2.29.0-beta).
- `diffScopeUnsupported` (`coordinator-worker-changes.ts`, `olderNodeDiffScopeNote`) and the "machine predates this" auto-switch pin (`control-mcp/account-tools.ts`, `set_account_auto_switch`): nodes before 2026-11-01 (first in v2.35.0-beta).
- `normalizeKanbanTask` rebuilding sections on every read (`storage-kanban-board.ts`): sections arrived in #1388 (first in v2.34.2-beta), so v2.21.0 to v2.34.1 write rows without them. When the floor passes, convert it into a one-time upgrade in `storage-record-upgrades.ts` (the data rule makes the upgrade permanent) and keep the `sectionsBasis` mismatch check. The floor alone gates this path: its counter keeps rising while untouched old rows stay on disk, and only that upgrade rewrites them, so a non-zero count does not block it.
- `read_file_at_branch` and `read_local_file_at_branch` (`commands-registry-terminal.ts`): the diff viewer of v2.21.0 to v2.23.0 calls them. Unused renderer wrappers stayed in `lib/backend/files-sessions.ts` until v2.37.4-beta, but nothing called them after v2.23.0.
- `get_coordinator_upstream_auto_merge` and `set_coordinator_upstream_auto_merge` (`commands-registry-client-state.ts`): v2.35.5-beta is the last renderer that calls them; v2.36.0 does not.

**Investigation.** Before removing, recheck with `git grep <symbol> v2.36.0`
that v2.36.0 has the newer behaviour, and read each counter. An agent can
read the counters only on a throwaway profile, which proves nothing about
the user's peers; the reads on the user's real installs are a human-only
item on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)
("7570 task 2 (user part)"). Record those results here.

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
  (`bridges/claude-bridge/src/services/process-identity.ts`), lock
  metadata without `instance` (`services/session-preferences.ts`), and the
  two-line owner file (`services/change-evidence.ts`, `parseOwnerFile`).
  They arrived in v2.34.2-beta (7d8174dff). v2.21.0 to v2.33 write pid-only
  records, and a downgrade writes them again.
- Codex per-login state adoption: `adoptLoginRecords`
  (`sessions/persistence.ts`), the login-directory journal merge in
  `sessions/dispatch-journal.ts`, the legacy path in
  `session-title-index.ts`, the legacy journal in
  `sessions/command-changes.ts` and `migrateCodexChangeEvidence`
  (`change-evidence-migration.ts`). Until #1295 (first in v2.32.0-beta),
  bridges wrote state into each Codex account's own directory.

Both groups have Register rows with no counter: the backend cannot see a
bridge's own files.

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

- The no-hello backend path in `packages/protocol/src/node/node-link/backend-hello.ts` (`checkBackendRoute` answering `legacy`), and the matching `legacy-backend` route in the desktop's `connection-route-selection.ts`. The hello handshake first shipped in the unpublished v2.25.0-alpha, so v2.21.0 to v2.23.0 need it; v2.36.0 is the first Stable with it. A backend acting as command node already refuses such a node as needing an update, so only the desktop uses the path.
- The CLI's `nodeRouting` (#1268, first in v2.31.0-beta) and `transcriptKnownToken` (#1668, first in v2.36.0) capability gates (`packages/cli/src/client/session.ts`, `packages/cli/src/client/commands/session.ts`).

`legacyAutoSwitchEvent` was listed here, but it first shipped in v2.36.4-beta
(#1836), so v2.36.0 and v2.36.1 command nodes still need it; it moved to
task 6.

**Investigation.** `extendedDeny` (`native-agent-capabilities.ts`,
introduced by #1674, first in v2.36.0) is not a compatibility path. Every
bridge, including the current one, validates `capabilityPolicy.deny` with
`isNativeAgentCapability` and drops the whole policy on an unknown name,
while `extendedDeny` tolerates and skips unknown names
(`nativeAgentDeniedCapabilities`). The split is therefore how any future
capability reaches an older bridge without widening its session, whatever
the floor. It gets no Register row.

**Decisions.**

- **Is `extendedDeny` a compatibility path?**
  - **Decide from its introducing change, and record a Register row only if it is (recommended, done: it is not).**
    - Pros: avoids weakening a safety boundary by mistake.
    - Cons: needs a careful read of the capability policy.
  - **Treat it as one and remove it with the rest.**
    - Pros: simpler.
    - Cons: drops the permanent wire form, so the next new capability name
      would make every older bridge drop the whole policy.

### 5. Renderer paths, removable 2027-01-02

**Problem.** These renderer fallbacks serve backends without a command or
field that first reached a Stable release in v2.36.0.

**Context.** Paths under `apps/web/src/`, each with a Register row and no
counter (renderer side):

| Path | Where | First tag |
| --- | --- | --- |
| `get_ticket_sync_status` unknown-command | `components/kanban/TicketSyncStrip.tsx` | v2.36.0 |
| `arrange_projects_by_intent` fallback | `lib/backend/projects-environments.ts`, `lib/federation/remote-project-writes.ts` | v2.35.2-beta (draft) |
| `patch_repository_settings` fallback | `lib/backend/config-integrations.ts` | v2.35.2-beta |
| `patch_global_config` fallback | `lib/portal/command-node-config.ts` | v2.35.2-beta |
| `get_node_status` read as "no command-node support" | `lib/portal/portal-store.ts` | v2.25.0-alpha (draft) |
| Ticket `kind`/`sections` optional, derived from text | `lib/backend/kanban.ts`, `components/tickets/ticket-content.ts` | v2.34.2-beta |
| `containerTerminals` absent | `components/settings/HostUpdatesPanel.tsx` | v2.32.0-beta |
| Change-tracking older-backend catches (not the transcript-row presentation, which is permanent) | `lib/changes/subscriptions.ts` | v2.24.0-alpha |
| MCP environment overlay commands | `components/settings/mcp-servers/McpEnvironmentOverlay.tsx` | v2.27.0-beta |

The backend keeps `update_global_config` and `arrange_projects` for older
clients; they are not purely compatibility code while current web calls
them, so check their callers at the same time.

**Investigation.** Recheck each with `git grep <command> v2.36.0 --
apps/backend/src`.

**Decisions.**

- **Remove all at once on 2027-01-02 (recommended)**, in the same change as
  task 2 if both are ready: one validation run. The alternative, per-path
  changes, costs a full run each.

### 6. Paths with no Stable release yet

**Problem.** These fallbacks handle peers without commands or fields that
have only shipped in betas or alphas.

**Context.** Each has a Register row with no counter:

| Path | Where | First tag |
| --- | --- | --- |
| `record_domain_adapter_usage` | `apps/web/src/lib/domain-adapter-usage-ring.ts` | v2.37.0-alpha |
| `get_fleet_update_policy` | `apps/web/src/components/settings/machines/FleetUpdatePolicySection.tsx` | v2.37.0-alpha |
| `get_coordinator_account_switch_grant` | `apps/web/src/lib/backend/agent-accounts.ts` | v2.36.2-beta |
| `reauthenticate_agent_account` | `apps/web/src/lib/backend/agent-accounts.ts` | v2.37.2-beta |
| Coordinator activity and launch-override unsupported latches | `apps/web/src/stores/coordinatorActivityStore.ts`, `coordinatorLaunchOverrideStore.ts` | v2.37.4-beta |
| `legacyAutoSwitchEvent` (the `five-hour` reason sent as `limit` on the event stream) | `apps/backend/src/core/index.ts`, `packages/protocol/src/agent-account-auto-switch.ts` | v2.36.4-beta |

**Investigation.** On 2026-11-11 the newest Stable release is still v2.36.1,
which contains none of these. When the next Stable release is published, its
date plus 60 days is the removal date for every row here. Write that date
into this task then.

**Decisions.** None until that release exists.

### 7. The legacy Claude state file written by the image

**Problem.** `docker/orkestrator-state-signal.sh` writes
`/tmp/.claude-state` beside `/tmp/.claude-state-snapshot`. The investigation
assumed only v2.21.x read it, but `git grep claude-state v2.36.0 --
apps/backend/src` still finds readers.

**Context.** A new image must keep working under every backend in the
window, so the write stays while any supported backend reads only the file.

**Investigation.** Done on 2026-11-11. HEAD still names the file:
`claudeStateReadCommand` (`tmux-poll.ts`) reads `/tmp/.claude-state-snapshot`
and falls back to `/tmp/.claude-state` only when no snapshot exists.
Every image whose hook writes the snapshot writes it on every state change,
so on such an image HEAD never reads the legacy file; the fallback serves
containers built before #1041, which is unmigrated user state, not skew. The
snapshot reader arrived in #1041 (b21ff90c5, first tagged v2.22.0, first
published v2.22.3); `git grep claude-state-snapshot` finds no reader in
v2.21.0 or v2.21.1. The legacy write therefore serves only v2.21.0 and
v2.21.1 backends, and becomes removable when the floor reaches v2.22.3 on
2026-12-16. The task does not close as "HEAD reads it", because HEAD reads
the file only as the old-container fallback. It has a Register row.

**Decisions.**

- **What does HEAD's fallback read mean for the write?**
  - **Remove the write once the floor is v2.22.3, keep the fallback read (recommended).**
    - Pros: matches what each backend actually reads; new images stop writing
      a file no supported backend needs.
    - Cons: two removals with different owners (the read goes with old
      containers, not the window).
  - **Close the task because HEAD names the file.**
    - Pros: no further work.
    - Cons: keeps a write that no supported backend needs after 2026-12-16.

## Current state

Every path in this file has a Register row in
[version-compatibility.md](../../architecture/version-compatibility.md#register)
whose owner is this file, and the eight backend-visible paths count their
use. Nothing here is removable on 2026-11-11. The rollback switches the
investigation found are tracked where they already were: the remaining
`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` drivers in
[0048](../transcripts-and-observation/0048-recurring-work-qualification.md)
task 13 (with `ORKESTRATOR_NATIVE_OBSERVATION_SHARING`, which waited on 0049
until it was retired on 2026-11-11), and
`ORKESTRATOR_EGRESS_FILTER=off` in 6101. The retired-command Register rows
(195 to 200 at the time of writing) wait on the next Stable release and
their counters.

## Outstanding work

- 2026-12-16: task 7 (stop writing `/tmp/.claude-state`).
- 2027-01-02: tasks 2 to 5, ideally in one change.
- The next Stable release: write task 6's removal date.

## Constraints and rationale

- Migrations and record upgrades are permanent; only per-load readers turn
  into one-time upgrades.
- Detect by shape or capability, never by version number.
- Before removing a counted path, read its counter on the machines you can
  reach.
- Do not raise the floor to remove a path sooner; the floor moves by itself.

## Assumptions and decisions

### Task 1: counters only where the backend sees an older peer directly

Counters were added where the backend itself takes the older-peer branch,
and each counts only that branch, never the current path (the tests assert
both). `kanban.legacy-row-derived` counts row reads rather than rows, because
the derivation runs on every read. It is informational only; see the next
decision. `auto-switch.older-node` counts only a remote machine whose whole
account list has no automatic-switch state, since every current backend
sends that state for each platform. `legacyAutoSwitchEvent` has no counter:
the backend emits the event for every subscriber and cannot tell which
command node reads it.

### Task 1: the diff-scope note moved into a helper

The `diffScopeUnsupported` note was inlined in the
`get_coordinator_worker_changes` handler, which needs a routed remote node to exercise.
It moved into `olderNodeDiffScopeNote` (same text, same condition) so its
counter is testable without one.

### Task 4: `extendedDeny` is permanent

Decided from #1674 and the current validator, as recorded under task 4.

### Task 4 to task 6: `legacyAutoSwitchEvent`

Its introducing change (#1836) is first in v2.36.4-beta, not v2.36.0, so it
waits on the next Stable release like the rest of task 6.

### Task 2: the real-install counter reads are on the checklist

Reading the eight counters on the user's own machines needs their real
installs, which an agent must not touch, so that part of task 2 is an item
on [7568](../manual-test/7568-manual-test-checklist.md) naming this to-do and
task. The removal itself stays here, blocked until 2027-01-02.

### Task 2: the Kanban legacy-row counter does not gate the upgrade

Review round 2 found that a quiet `kanban.legacy-row-derived` counter could
never be reached: an old row is rewritten only when its ticket next changes,
so an untouched one keeps the counter rising on every board read and sync,
with or without an older peer, and only the one-time upgrade that the quiet
counter was meant to unlock would stop it. The path covers stored user state
that needs a permanent record upgrade, like task 7's legacy state file, so
its retire condition is now the floor alone (v2.36.0, 2027-01-02): after
that no supported node writes or syncs a row without `sections`, and the
upgrade rewrites the rows already on disk. The counter stays as information
(a non-zero count says old rows remain on that machine) and the Register row
and the 7568 item say it does not block. Counting only rows that arrive by
sync from an older peer was not chosen: it needs new plumbing in the sync
path for a signal the floor already settles.

### Task 7: keep the task open with a date

The to-do's recommended decision assumed HEAD either reads the file or does
not. HEAD reads it only as a fallback for containers older than #1041, so the
task now records the date the write can go (2026-12-16) instead of closing.

## Related

- [version-compatibility.md](../../architecture/version-compatibility.md)
- [7571](7571-removal-candidates-needing-a-decision.md): removals that need a decision rather than a date.
- [Cross-cutting index](0000-index.md)
