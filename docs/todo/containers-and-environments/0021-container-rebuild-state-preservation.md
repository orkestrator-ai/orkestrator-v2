# Container rebuild state preservation

Checked against `main` at `9906db30` (2026-10-16).

A preserving rebuild (`migrate` from a legacy writable layer, `rebuild` from
volumes) copies `/workspace` and the resume-critical provider state into a new
storage set and commits the new runtime in one write. The provider-state
inventory was re-traced against the current pins on 2026-10-16. Codex and
OpenCode still drop some user-visible, non-resume state by explicit decision.
The legacy writable-layer, whole-home-mount and shared-network code paths
remain, behind rollout switches, with no retirement plan.

## Current state

- `PROVIDER_STATE_LAYOUT` and `PROVIDER_PRESERVATION` in
  `apps/backend/src/core/container-state-layout.ts` define what is mounted by
  sub-path from the `state` volume and what the product may claim. Claude, Pi,
  Cursor and Grok are `full`; Codex and OpenCode are `partial`, and their
  limitation text reaches the user through `rebuildPreview`. The provider-state
  inventory in [container-lifecycle.md](../../architecture/container-lifecycle.md)
  ("Provider state") records what each provider preserves and excludes.
- `PROVIDER_STATE_TRACED_VERSIONS` in the same module names the versions the
  layout was traced against. `apps/backend/tests/container-state-layout.test.ts`
  fails when a manifest CLI pin or the `@cursor/sdk` pin moves away from it,
  and [upgrading agents](../../development/upgrade-agents.md#re-trace-preserved-provider-state)
  says how to re-trace.
- Storage selection is `selectStorageFormat` in
  `apps/backend/src/core/container-storage.ts`: `volume-v1` only when the
  image declares `persistent-workspace`, the daemon is Engine 26+
  (`MIN_ENGINE_FOR_VOLUME_SUBPATH`) and the switch below does not disable it.
  `imageWritesVolumeStorage` refuses newer state for an older image.
- Replacement is `replaceRuntimePreservingState` and `rebuildPreview` in
  `apps/backend/src/core/container-replacement.ts`. Copy and verification run
  in `docker/orkestrator-migrate.sh` (`copy_stream`, `verify`). Restore and
  discard are `restoreRecoveryCopy` and `discardRecoveryCopy` in
  `apps/backend/src/core/recovery-copies.ts`; `assertRecoveryCapacity`
  enforces the cap of 16 copies.
- A legacy runtime is never migrated by a start, read, status refresh or UI
  mount. Migration is the explicit "Rebuild (keeps files)" or
  `orkestrator environment recreate` without `--discard`.
- No export path exists. The only copies are recovery copies on the same
  daemon.
- Four rollout switches, read from the backend's environment when a container
  is created or a rebuild is admitted:
  - `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` (`selectStorageFormat`): new
    runtimes keep the legacy writable layer even on a capable image.
  - `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` (`createDockerContainer` in
    `apps/backend/src/core/commands-containers.ts`): skips staged inputs even
    for an image that declares `staged-inputs`. The container gets the
    read-only host agent-home mounts an older entrypoint expects, and an
    Anthropic API key goes into the creation environment
    (`-e ANTHROPIC_API_KEY`) instead of a staged file. `get_environment_inputs`
    reports it as `host-mounts`.
  - `ORKESTRATOR_NETWORK_POLICY=1` (`createDockerContainer`): skips the
    per-environment network and policy 2 even for an image that declares
    `network-policy=2`. The container joins the shared default bridge, and
    the firewall's legacy policy allows the whole gateway `/24`, which
    includes sibling containers.
  - `ORKESTRATOR_CONTAINER_REPLACEMENT=paused` (`replacementAdmissionPaused`):
    refuses new rebuilds and migrations (the preview reports
    `admission-paused`) while listing, restoring and discarding copies and
    resolving an interrupted operation keep working.

  The `host-mounts` and policy-1 opt-outs are documented nowhere else.
- Quiescing the source stops its Claude state poll
  (`shutdownClaudeStatePolling`), and `ContainerGitFetchPolicy.forgetContainer`
  drops a container's fetch records on lifecycle changes, so the committed
  runtime starts fresh. Environment-keyed work (sessions, parked dispatches,
  queued prompts) resolves the new runtime on its next use.

## Outstanding work

### Code

1. Stop seeding OpenCode `snapshot/`, `storage/` and `account.json` from the
   host in `docker/entrypoint.sh` (the `/opencode-data` block), after
   confirming with a live run that nothing reads them. The static trace of
   1.19.0 found no reader for any of the copies: a snapshot directory is keyed by
   `sha1(worktree path)`, which a host path never matches against
   `/workspace/...`; `storage/` is a legacy store with no reader; and
   `account.json` no longer appears in the binary (accounts live in the
   database). Large snapshot stores are already skipped by the copy caps.
   Re-check at the OpenCode 2.x move (see [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md)),
   which may change `OPENCODE_DB` semantics and the `opencode/db` entry.
2. Legacy retirement. This needs the decision under "Open questions" first.
   Then:
   - provide an export or migration path for legacy writable-layer
     containers;
   - account for retained resources (recovery copies, `legacy-unadopted`
     containers, runtimes still on host mounts or policy 1);
   - remove the `legacy-layer`, `host-mounts` and policy-1 code paths with
     their switches, giving each switch an owner, removal criteria and safe
     disabled behaviour until then.

   Do not tie retirement to an app launch count or to automatic migration on
   startup. Persisted capability and layout versions stay the long-term
   compatibility boundary; old images keep their guarded behaviour rather
   than a second lifecycle engine.

### Qualification

- Per-provider resume after a rebuild (C13) and a re-run of C14 are tracked in
  [0019-container-platform-qualification.md](0019-container-platform-qualification.md).
  C14 now also asserts a Codex `thread_history_1.sqlite` relocation, the Codex
  bridge title index, a Grok session directory, and that Grok's
  `active_sessions.json` is not carried over; none has run live yet.

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
- Old images never gain capabilities by default.
- An interrupted copy discards the candidate and a retry recopies from
  scratch; there is no resumable copy journal.
- Keep the identities distinct: `environmentId`, `runtimeGeneration`,
  `bootId`, `workspaceGeneration`, `storageSetId`, `operationId` and the
  lifecycle `revision`.
- Scope: Docker CLI primitives behind a small backend service. No Kubernetes,
  no wholesale Docker SDK rewrite, no per-agent image matrix.
- Provider state is classified per path as preserve (needed to resume, rewind
  or fork, or a bridge map without which the host session id cannot be
  resolved), accept losing (user-visible, named in the limitation text, makes
  the provider `partial`) or drop (credentials, configuration, caches, logs,
  process registries, host-seeded content). The 2026-10-16 re-trace (static:
  pinned binaries' strings and bundled docs, no Docker) found every preserved
  path still correct at Claude 2.1.296, Codex 0.162.1, OpenCode 1.19.0, Pi
  1.2.0, `@cursor/sdk` 1.0.37 and Grok 1.0.52.
- Re-tracing is forced, not just documented: a test pinned to the manifest
  fails on every bump until `PROVIDER_STATE_TRACED_VERSIONS` is updated. It
  proves the step was acknowledged, not that the trace was right; the upgrade
  guide carries the per-provider checks.
- Codex: `session_index.jsonl` is still written at the home root, and Codex
  offers no variable to relocate it alone. A single-file mount would break as
  soon as Codex replaced the file by rename, so it is accepted as lost.
  A name set in Orkestrator now also goes into the bridge's own title index
  (`orkestrator-bridge/session-titles.jsonl`, preserved), as generated titles
  already did, so only a name set inside the Codex CLI is lost. Every
  `*_N.sqlite` runtime database at 0.162.1 (state, thread history, goals,
  queue, memories, logs) follows `CODEX_SQLITE_HOME` and matches the migrate
  selection.
- OpenCode: `snapshot/` (a per-project git directory used only for revert and
  diff, recreated on demand and pruned after 7 days) and `tool-output/` are
  accepted as lost rather than mounted. Preserving them would copy a
  workspace-sized object store on every rebuild, for revert of turns that may
  already be pruned. Sessions, messages and parts are entirely in the database
  `OPENCODE_DB` relocates (still an absolute file path at 1.19.0).
- Grok: `active_sessions.json` is a live-process registry and `worktrees.db`
  tracks only worktrees Grok creates under its own home, which are not
  preserved either. `session/load` needs only the session directory under
  `~/.grok/sessions`. Both are dropped deliberately, so Grok is `full`.
  `memory-v2/` is opt-in and off by default; it is not preserved.

## Open questions

- When does legacy retirement happen, and what does the export look like (an
  archive on the host, or a volume set to adopt)? Does
  `ORKESTRATOR_CONTAINER_REPLACEMENT=paused` stay as a permanent safety switch
  after the others go?
- `restoreRecoveryCopy` swaps a retained runtime back in with its older
  `runtimeGeneration` when that container still exists; only a new runtime
  gets `nextRuntimeGeneration`. Should a restore always assign a new
  generation, so a stale handle bound to the old generation through
  `expectedRuntimeGeneration` is refused?
- Is a resumable copy journal worth its complexity for very large workspaces?

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md),
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md)
  (policy-1 retirement), [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (volumes and copies removed through the deletion ledger),
  [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md),
  [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md) (container-private
  overlay writes).
- [Container lifecycle](../../architecture/container-lifecycle.md) (the
  provider-state inventory is under "Provider state"),
  [container qualification](../../development/container-qualification.md),
  [upgrading agents](../../development/upgrade-agents.md).
- Living-doc drift to fix in `docs/architecture/container-lifecycle.md`:
  - "Preserving rebuild" says extended attributes are not preserved.
    `tar_filter_args` in `docker/orkestrator-migrate.sh` preserves `user.*`
    and `security.capability` xattrs (not verified), preserves and verifies
    hard links, recreates FIFOs and refuses device nodes.
  - "Portable inputs" says the Anthropic API key is still in the creation
    environment and visible in `docker inspect`. For a staged-inputs
    container `createDockerContainer` writes it to
    `/claude-config/.orkestrator-anthropic-key` and `docker/runtime-env.sh`
    exports it into shells; only a container without staged inputs gets
    `-e ANTHROPIC_API_KEY`. It stays visible to same-user processes, but no
    longer in `docker inspect`. The "Credentials" bullet in the same section
    repeats the old claim.
  - Only `ORKESTRATOR_CONTAINER_STORAGE` and
    `ORKESTRATOR_CONTAINER_REPLACEMENT` are documented; the `host-mounts` and
    policy-1 opt-outs are not.

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
