# Container rebuild state preservation

Checked against `main` at `2459b05c` (2026-10-15).

A preserving rebuild (`migrate` from a legacy writable layer, `rebuild` from
volumes) copies `/workspace` and the resume-critical provider state into a new
storage set and commits the new runtime in one write. Three providers still
lose some state across a rebuild, and the inventory that says what survives
was traced against agent versions that have since been upgraded several
times. The legacy writable-layer, whole-home-mount and shared-network code
paths also remain, behind rollout switches, with no retirement plan.

## Current state

- `PROVIDER_STATE_LAYOUT` and `PROVIDER_PRESERVATION` in
  `apps/backend/src/core/container-state-layout.ts` define what is mounted by
  sub-path from the `state` volume and what the product may claim. Claude, Pi
  and Cursor are `full`; Codex, OpenCode and Grok are `partial`, and their
  limitation text reaches the user through `rebuildPreview`. The module's
  header cites the
  [provider-state inventory](../improvements/containers/plan/05-persistent-workspace-and-agent-state.md),
  which records what each provider preserves and excludes.
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

1. Close the partial-preservation gaps, or accept each one explicitly and keep
   its limitation text:
   - Codex: `session_index.jsonl` (thread names) at the Codex home root. The
     Codex bridge reads it there (`bridges/codex-bridge/src/history/rollout.ts`),
     so names drawn from it are lost after a rebuild.
   - OpenCode: `snapshot/` (revert and diff history). `docker/entrypoint.sh`
     seeds it from the host's OpenCode data with `copy_agent_directory_entries`,
     so preserving it also needs a rule for host-seeded versus in-container
     content.
   - Grok: `active_sessions.json` and `worktrees.db` at the `~/.grok` root.

   Each fix needs an explicit mount at the provider's real path (or a
   provider-supported relocation variable, as with `CODEX_SQLITE_HOME` and
   `OPENCODE_DB`), a `PROVIDER_STATE_LAYOUT` entry, a `PROVIDER_PRESERVATION`
   update, the matching row of the provider-state inventory, and a live C14 assertion
   in `apps/backend/tests/container-live-replacement.test.ts`.
2. Re-trace provider state paths after each agent upgrade. The inventory was
   traced against the 2026-09-27 pins; #880, #888, #891, #935 and #964 have
   upgraded agents since. `docs/development/upgrade-agents.md` has no step for
   it; add one that checks every `PROVIDER_STATE_LAYOUT` path and the
   relocated databases. The OpenCode 2.x move changes `OPENCODE_DB` semantics
   and must update the `opencode/db` entry (`OPENCODE_DB_PATH`).
3. Legacy retirement. This needs the decision under "Open questions" first.
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
  [container-platform-qualification.md](container-platform-qualification.md).
  Each gap closed above needs its own live assertion before the preview
  claims it.

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

## Needs verification

- Whether Codex at the current pin still writes `session_index.jsonl` at the
  home root, and Grok `active_sessions.json` and `worktrees.db` at the
  `~/.grok` root. Only third-party binaries can confirm this.

## Related

- [container-platform-qualification.md](container-platform-qualification.md),
  [container-network-and-credential-isolation.md](container-network-and-credential-isolation.md)
  (policy-1 retirement), [environment-and-disk-cleanup.md](environment-and-disk-cleanup.md)
  (volumes and copies removed through the deletion ledger),
  [opencode-v2.md](opencode-v2.md),
  [mcp-environment-delivery.md](mcp-environment-delivery.md) (container-private
  overlay writes).
- [Provider-state inventory](../improvements/containers/plan/05-persistent-workspace-and-agent-state.md)
  and [rollout stages](../improvements/containers/plan/14-integrated-qualification-and-rollout.md).
- [Container lifecycle](../architecture/container-lifecycle.md),
  [upgrading agents](../development/upgrade-agents.md).
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
  - The "Authority" table's `storage` row ("`legacy-layer` until persistent
    volumes") is stale wording.
  - Only `ORKESTRATOR_CONTAINER_STORAGE` and
    `ORKESTRATOR_CONTAINER_REPLACEMENT` are documented; the `host-mounts` and
    policy-1 opt-outs are not.

## Replaces

- `docs/improvements/containers/plan/05-persistent-workspace-and-agent-state.md`
  (partial-preservation gaps; the inventory table stays in place)
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
