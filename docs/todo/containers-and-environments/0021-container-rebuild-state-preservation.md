# Container rebuild state preservation

Checked against `main` at `ba7cc8d4` (2026-10-25).

A preserving rebuild (`migrate` from a legacy writable layer, `rebuild` from
volumes) copies `/workspace` and the resume-critical provider state into a new
storage set and commits the new runtime in one write. Codex, OpenCode and
Grok still drop some user-visible, non-resume state by explicit decision.
On 2026-10-25 the OpenCode host seeding was narrowed to the login, the
`host-mounts` and policy-1 opt-outs were removed, the legacy-retirement and
restore-generation questions were decided, and a volume rebuild stopped
dropping file capabilities. One item remains: removing the
`ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` switch, which waits for a Linux
rootless qualification.

## Current state

- `PROVIDER_STATE_LAYOUT` and `PROVIDER_PRESERVATION` in
  `apps/backend/src/core/container-state-layout.ts` define what is mounted by
  sub-path from the `state` volume and what the product may claim. Claude, Pi
  and Cursor are `full`; Codex, OpenCode and Grok are `partial`, and their
  limitation text reaches the user through `rebuildPreview`. The provider-state
  inventory in [container-lifecycle.md](../../architecture/container-lifecycle.md)
  ("Provider state") records what each provider preserves and excludes.
- `PROVIDER_STATE_TRACED_VERSIONS` in the same module names the versions the
  layout was traced against (Claude 2.1.309, Codex 0.164.0, OpenCode 1.19.4,
  Pi 1.4.0, `@cursor/sdk` 1.0.40, Grok 1.0.67).
  `apps/backend/tests/container-state-layout.test.ts` fails when a manifest
  CLI pin or the `@cursor/sdk` pin moves away from it, and
  [upgrading agents](../../development/upgrade-agents.md#re-trace-preserved-provider-state)
  says how to re-trace. For OpenCode that now includes
  `scripts/qualify-opencode-seeded-data.sh`.
- Storage selection is `selectStorageFormat` in
  `apps/backend/src/core/container-storage.ts`: `volume-v1` only when the
  image declares `persistent-workspace`, the daemon is Engine 26+
  (`MIN_ENGINE_FOR_VOLUME_SUBPATH`) and `ORKESTRATOR_CONTAINER_STORAGE` is not
  `legacy-layer`. `imageWritesVolumeStorage` refuses newer state for an older
  image.
- Replacement is `replaceRuntimePreservingState` and `rebuildPreview` in
  `apps/backend/src/core/container-replacement.ts`; both use the current
  image, so a `migrate` also moves a runtime off an old image. Copy and
  verification run in `docker/orkestrator-migrate.sh` (`copy_stream`,
  `verify`). Restore and discard are `restoreRecoveryCopy` and
  `discardRecoveryCopy` in `apps/backend/src/core/recovery-copies.ts`;
  `assertRecoveryCapacity` enforces the cap of 16 copies. A restore always
  assigns a new runtime generation.
- A legacy runtime is never migrated by a start, read, status refresh or UI
  mount. Migration is the explicit "Rebuild (keeps files)" or
  `orkestrator environment recreate` without `--discard`.
- No host-archive export exists, by decision (below). The only copies are
  storage sets and recovery copies on the same daemon.
- OpenCode's `/opencode-data` input is `auth.json` alone: `portableInputSpec`
  in `apps/backend/src/core/portable-inputs.ts` stages only it, and the
  `/opencode-data` block of `docker/entrypoint.sh` copies only it.
- Rollout switches, read from the backend's environment when a container is
  created or a rebuild is admitted, are listed with their owner, status and
  removal criteria in [container-lifecycle.md](../../architecture/container-lifecycle.md)
  ("Rollout switches and legacy runtimes"):
  - `ORKESTRATOR_CONTAINER_REPLACEMENT=paused` (`replacementAdmissionPaused`):
    permanent.
  - `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` (`selectStorageFormat`):
    temporary, the item below.
  - `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` and
    `ORKESTRATOR_NETWORK_POLICY=1`: removed; `createDockerContainer`
    (`commands-containers.ts`) and `containerNetworkPolicy`
    (`container-network.ts`) ignore them.
- Quiescing the source stops its Claude state poll
  (`shutdownClaudeStatePolling`), and `ContainerGitFetchPolicy.forgetContainer`
  drops a container's fetch records on lifecycle changes, so the committed
  runtime starts fresh. Environment-keyed work (sessions, parked dispatches,
  queued prompts) resolves the new runtime on its next use.

## Outstanding work

### Code

1. ~~Stop seeding OpenCode `snapshot/`, `storage/` and `account.json` from the
   host.~~ Done 2026-10-25. `docker/entrypoint.sh` copies only `auth.json`
   from `/opencode-data`, and `portable-inputs.ts` stages only `auth.json` for
   it. Live evidence, `scripts/qualify-opencode-seeded-data.sh` on
   `orkestrator-v2:review-ede1e368-arm64`
   (`sha256:4c74b68de8c2c735795df7078ed7c87d0b1d08f2c5145d8fc695bcecd9a6a97f`,
   OpenCode 1.19.4, arm64, Docker Desktop 4.96.3, Engine 29.9.2): five
   network-less containers, each running a real `opencode serve` and one turn
   against a local mock model (a `write` tool call, the session diff, revert
   and unrevert) while inotify watched OpenCode's data directory. All checks
   passed:
   - With nothing seeded, in both the volume (`OPENCODE_DB` relocated) and
     legacy database layouts, the turn finished, the diff listed the written
     file, revert removed it and unrevert restored it.
   - With a host-shaped seed, nothing opened `account.json` or either seeded
     `snapshot/` directory (one keyed by a host worktree hash, one in the
     older per-project layout). OpenCode created its own
     `snapshot/<root commit>/<worktree hash>` instead.
   - Of a current host's `storage/`, only `storage/migration` (the
     legacy-migration index) was opened. With no index (an old host's seed),
     OpenCode ran its legacy storage migrations over the seeded session JSON
     and wrote `migration=2`; with nothing seeded it ran them over an empty
     directory. No host session was ever listed.

   The static trace was wrong on one point: `storage/` is not dead at 1.19.4.
   OpenCode still writes each session's change list to
   `storage/session_diff/<session>.json`. Those are container-written, not
   host-seeded, and are not preserved across a rebuild; the provider-state
   inventory now says so. The re-check at the OpenCode 2.x move
   ([0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md)) is now part of
   the re-trace every OpenCode bump requires: the upgrade guide's OpenCode row
   runs the same script.

   An image built from this change, `orkestrator-v2:dev-b1beedeedb67`
   (`sha256:976b45babde1b29e3b167bebeeeb50379839dcb5080bd7d4fd6c8f4a849a5c9a`,
   arm64; built before a comment-only edit to `entrypoint.sh`), was checked
   as well:
   - `docker/tests/final-image-smoke.sh` passes on it.
   - The same five-variant script passes on it.
   - Its real entrypoint, started with `NETWORK_MODE=full` and a host-shaped
     `/opencode-data` mount (`auth.json`, `account.json`, `storage/`,
     `snapshot/`), left only `auth.json` (mode `0600`) in
     `~/.local/share/opencode` beside the image's own `log/` and `repos/`.
2. ~~Legacy retirement.~~ Done 2026-10-25, except the `legacy-layer` switch
   (item 3). The decision is under "Assumptions and decisions".
   - Export or migration path: the preserving rebuild (`migrate`) is the
     path. It copies a writable-layer runtime into a verified storage set of
     the current image; no host-archive export was added.
   - Retained resources are accounted for in
     [container-lifecycle.md](../../architecture/container-lifecycle.md)
     ("Rollout switches and legacy runtimes"). Each shape keeps a handler:
     - writable-layer runtimes are migrated by an explicit rebuild;
     - runtimes on host mounts or policy 1 keep them until rebuilt, and the
       inputs and network status report them;
     - legacy recovery copies are listed, restored, discarded and
       ledger-deleted like any copy;
     - `legacy-unadopted` containers are offered for reattachment and never
       removed.
   - Switches: `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` and
     `ORKESTRATOR_NETWORK_POLICY=1` are removed. A capable image always gets
     staged inputs and at least policy 2, and an older image keeps its
     guarded behaviour, which is the capability boundary rather than a
     switch. Tests: `a capable image ignores the retired host-mount and
     shared-bridge opt-outs` (`apps/backend/tests/docker-image.test.ts`) and
     the policy cases in `apps/backend/tests/container-network.test.ts`. Both
     fail against the previous code.
   - `ORKESTRATOR_CONTAINER_REPLACEMENT=paused` stays as a permanent safety
     switch. `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` has an owner,
     removal criteria and safe disabled behaviour; it is documented at
     `selectStorageFormat` and in the lifecycle doc.
3. Remove `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` (the branch in
   `selectStorageFormat` and the `disabled-by-configuration` reason) once
   volume storage has passed on a real Linux rootless host. That run is
   tracked in
   [0019-container-platform-qualification.md](0019-container-platform-qualification.md),
   and Linux rootless is the last platform where `volume-v1` is unqualified.
   Until then the switch is the only fallback if volume storage fails on a
   daemon. While it is set, new runtimes keep the writable layer and
   preserving rebuilds are refused before anything is copied, so no data is
   at risk. When it goes, `scripts/qualify-backend-upgrade-rollback.ts` still
   works: it sets the switch only on the old release's backend, which keeps
   honouring it. Blocked on 0019: this machine has only Docker Desktop.

### Qualification

- C14 (legacy migration and volume rebuild) ran live on 2026-10-16 with the
  Codex `thread_history_1.sqlite` relocation, the Codex bridge title index,
  the Grok session directory and the exclusion of Grok's
  `active_sessions.json`, all passing
  ([container-qualification.md](../../development/container-qualification.md),
  "Provider-state review evidence"). On 2026-10-25 the live replacement suite
  (`container-live-replacement.test.ts`, C14–C19) passed again on
  `orkestrator-v2:review-ede1e368-arm64` with this branch's backend,
  including the new assertions that a restored runtime takes generation 3,
  then 4: 10 of 10 tests. On `orkestrator-v2:dev-b1beedeedb67`, built from
  this change and so carrying the `copy-volume` fix, the same suite passed
  10 of 10, and the live rebuild-fault suite
  (`container-live-rebuild-faults.test.ts`, C15) passed 5 of 5. Per-provider
  resume after a rebuild (C13; Grok remains) is tracked in 0019.
- The volume-rebuild capability fix was checked live by running the changed
  `orkestrator-migrate.sh copy-volume` in a helper of the same image, with
  real volumes. A `setcap` file kept `cap_net_bind_service=ep` (the image's
  own script dropped it), hard links and symlinks survived, and the source
  marker was excluded. The image built from this change gave the same
  result with its own script. It reaches users with the next image release.

## Constraints and rationale

- Always copy into a new storage set, including for volume rebuilds, so
  candidate setup can never damage the only pre-rebuild copy. The source is
  stopped, never restarted, to export it.
- One revision-checked write moves the runtime and storage pointers together
  and records the retained copies. Never revert automatically after the
  commit; prefer forward repair. Restoring an older copy is explicit and keeps
  the current state as a `restore-source` copy.
- Recovery copies have no age expiry. The cap blocks another rebuild rather
  than evicting a copy.
- Never mount all of `/home/node` or the host checkout to get persistence. No
  writable symlink tricks for state paths: they weaken the credential
  destination checks.
- Credentials, configuration, caches and binaries stay in the container layer;
  staged credentials are never part of the preserved set.
- SQLite stores are copied only with their writer stopped, and their `-wal`
  and `-shm` files travel with them.
- Dispatch journals stay beside their session identity, so an ambiguous
  dispatch survives reconstruction as unknown. Resuming never manufactures a
  new turn.
- Named volumes are persistence, not backup.
- Old images never gain capabilities by default, and keep their guarded
  behaviour. Persisted capability and layout versions are the long-term
  compatibility boundary. Retirement is never tied to an app launch count or
  to automatic migration on startup.
- An interrupted copy discards the candidate and a retry recopies from
  scratch; there is no resumable copy journal.
- Keep the identities distinct: `environmentId`, `runtimeGeneration`,
  `bootId`, `workspaceGeneration`, `storageSetId`, `operationId` and the
  lifecycle `revision`. Runtime generations only increase.
- Scope: Docker CLI primitives behind a small backend service. No Kubernetes,
  no wholesale Docker SDK rewrite, no per-agent image matrix.
- Provider state is classified per path as one of:
  - preserve: needed to resume, rewind or fork, or a bridge map without which
    the host session id cannot be resolved;
  - accept losing: user-visible, named in the limitation text, and makes the
    provider `partial`;
  - drop: credentials, configuration, caches, logs, process registries and
    host-seeded content.
- Re-tracing is forced, not just documented: a test pinned to the manifest
  fails on every bump until `PROVIDER_STATE_TRACED_VERSIONS` is updated. It
  proves the step was acknowledged, not that the trace was right; the upgrade
  guide carries the per-provider checks.
- Codex: `session_index.jsonl` is still written at the home root, and Codex
  offers no variable to relocate it alone. A single-file mount would break as
  soon as Codex replaced the file by rename, so it is accepted as lost. A name
  set in Orkestrator also goes into the bridge's own title index
  (`orkestrator-bridge/session-titles.jsonl`, preserved), so only a name set
  inside the Codex CLI is lost.
- OpenCode: `snapshot/` (a per-project, per-worktree git directory used only
  for revert and diff), `tool-output/` and `storage/session_diff/` are
  accepted as lost rather than mounted. Preserving `snapshot/` would copy a
  workspace-sized object store on every rebuild, for revert of turns that may
  already be pruned. Sessions, messages and parts are entirely in the
  database `OPENCODE_DB` relocates.
- Grok: `active_sessions.json` is a live-process registry and `worktrees.db`
  tracks only worktrees Grok creates under its own home, which are not
  preserved either. `session/load` needs only the session directory under
  `~/.grok/sessions`. Grok is `partial` because its resume after a rebuild is
  still unqualified (C13).

## Open questions

None. The three earlier questions are answered under "Assumptions and
decisions".

## Assumptions and decisions

1. **OpenCode host data (item 1).**
   - Options:
     - keep seeding `snapshot/`, `storage/` and `account.json`;
     - seed only `storage/migration`, to spare an old host's migrations;
     - seed only `auth.json`.
   - Choice: seed only `auth.json`, in both the entrypoint and the staging
     allowlist, since they must stay in step.
   - Why: the live run showed nothing reads the other three in a container.
     The migration index only saves OpenCode re-running migrations over an
     empty directory, which costs nothing.
   - Pros: fewer bytes staged and copied on every start; less host data (git
     objects of the user's other worktrees) inside containers; one less
     allowlist to keep in step.
   - Cons: an image built before this change still has the old entrypoint,
     but receives no seeded copies from a new backend's staging. That is
     harmless, because its entrypoint skips missing files.
2. **Export format and when legacy retirement happens (first open
   question).**
   - Options:
     - a host-archive export (a tar of `/workspace` and provider state on the
       host);
     - a volume set to adopt, which is what `migrate` already produces;
     - removing legacy support after N launches or by migrating
       automatically.
   - Choice: the volume set. `migrate` is the export path, and old-image
     behaviour is not retired.
   - Why: a host archive would be a second, unverified format with no import
     path. It would also put workspace and transcript content (which can hold
     user secrets) outside the volumes' private permissions, against "never
     exported implicitly". The automatic options are ruled out by the
     constraints.
   - Pros: one verified copy path, already qualified (C14–C19). Recovery
     copies, capacity checks and ledger deletion apply unchanged.
   - Cons: an Engine older than 26, or a remote daemon, has no path off the
     writable layer except upgrading Docker. Nobody can move an environment
     to another machine. Both are accepted, as neither is in scope.
3. **Which switches go (item 2).**
   - Options:
     - remove all three legacy switches now;
     - remove none and only document them;
     - remove the two that weaken isolation and keep `legacy-layer` until
       its platform gate passes.
   - Choice: the third.
   - Why: `host-mounts` exposed whole host agent homes and put the Anthropic
     key in `docker inspect`. Policy 1 put the container on the shared
     bridge, reachable by siblings. Neither is a fallback for anything: the
     address-pool error already tells users to widen Docker's pools.
     `legacy-layer` protects data, and is the only fallback while Linux
     rootless volume storage is unqualified.
   - Pros: removes two reachable security downgrades at once; the remaining
     switch has a measurable removal criterion.
   - Cons: an operator who relied on `host-mounts` or policy 1 silently gets
     the safe default (no warning is logged). One temporary switch remains.
4. **`paused` (first open question, second half).**
   - Options: retire it with the others, or keep it permanently.
   - Choice: keep it permanently.
   - Why: it only refuses new rebuilds and migrations, and recovery keeps
     working, so it cannot strand data. It is the rollback lever the rollout
     rules ask for.
   - Pros: an immediate stop for a bad copy path without a release.
   - Cons: one permanent environment knob to document and test.
5. **Restore generation (second open question).**
   - Options:
     - keep the swapped-back runtime's original generation;
     - always assign `nextRuntimeGeneration`.
   - Choice: always assign a new generation.
   - Why: generations should only increase. A handle bound to generation 1
     before a rebuild otherwise matched again after the generation-1 runtime
     was restored, which is the A-B-A case `expectedRuntimeGeneration`
     exists to refuse.
   - Pros: stale handles are refused with `runtime-changed` across every
     replacement.
   - Cons: a swapped-back container's `orkestrator-runtime-generation` label
     and `-gN` name keep its creation generation, so the label no longer
     equals the record. Only `findOperationContainers` reads the label, for a
     container the operation itself created, and a swap creates none.
6. **Resumable copy journal (third open question).**
   - Options: add a resumable copy journal, or keep discard-and-recopy.
   - Choice: keep discard-and-recopy.
   - Why: an interrupted copy already rolls back with the original
     authoritative, and the capacity preflight and admission limits bound the
     cost. A journal would need partial-state verification across daemon
     restarts, which is the riskiest part of the copy path. No measurement
     shows a workspace large enough for a recopy to matter.
   - Pros: the copy stays one verified pass.
   - Cons: a very large workspace pays the full copy again after an
     interruption. Revisit only with a measured case.
7. **Living-doc drift.**
   - The xattr claim was not only stale but hid a defect. Extraction kept
     file capabilities, but the volume producer archived without `--xattrs`,
     so a volume rebuild dropped them.
   - Choice: fix the producer (`copy-volume` now archives `user.*` and
     `security.capability`) and document what each source path carries,
     rather than only correcting the sentence.
   - Pros: the script now does what its own header says.
   - Cons: a destination filesystem that refused `user.*` attributes would
     now fail extraction. Source and candidate are volumes on the same daemon
     filesystem, so it accepts what the source holds.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (Linux rootless, which gates item 3; C13),
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md)
  (the policy-1 path is retired here), [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (volumes and copies removed through the deletion ledger),
  [0058-legacy-migration-root-symlink.md](0058-legacy-migration-root-symlink.md)
  (a `migrate` refusal that can block the migration path),
  [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md),
  [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md) (container-private
  overlay writes).
- [Container lifecycle](../../architecture/container-lifecycle.md) (the
  provider-state inventory is under "Provider state"; switches and legacy
  accounting under "Rollout switches and legacy runtimes"),
  [container qualification](../../development/container-qualification.md),
  [upgrading agents](../../development/upgrade-agents.md).
- The living-doc drift recorded here was fixed on 2026-10-25 in
  `docs/architecture/container-lifecycle.md`:
  - "Preserving rebuild" states the actual copy policy.
  - "Portable inputs" says the Anthropic key is staged, not in `docker
    inspect`, for a staged-inputs container.
  - The switches are listed in one table.

## Replaces

- `docs/improvements/containers/plan/05-persistent-workspace-and-agent-state.md`
  (partial-preservation gaps; the inventory table moved to
  `docs/architecture/container-lifecycle.md`, "Provider state")
- `docs/improvements/containers/plan/06-migration-and-transactional-replacement.md`
  (copy and commit decisions; the rest shipped in #877)
- `docs/improvements/containers/plan/07-recovery-deletion-and-cleanup-ux.md`
  (retention decisions, restore-generation limitation)
- `docs/improvements/containers/plan/08-portable-inputs-and-credential-lifecycle.md`
  (`host-mounts` opt-out, legacy inputs retained by old runtimes)
- `docs/improvements/containers/plan/09-environment-networks-and-egress-policy.md`
  (policy-1 opt-out)
- `docs/improvements/containers/plan/14-integrated-qualification-and-rollout.md`
  (rollout stage 6 and the rules for temporary switches)
- `docs/improvements/containers/plan/00-index.md` (cross-cutting storage,
  replacement, rollback and scope decisions; identities that must not be
  conflated)
- `docs/improvements/containers.md` (findings 1–3, superseded by #877)
