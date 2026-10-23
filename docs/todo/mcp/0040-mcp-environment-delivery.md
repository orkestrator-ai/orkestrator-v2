# MCP environment delivery

Checked against `main` at `2459b05c` (2026-10-15). Code items implemented and
re-checked on branch `todo-0040-mcp-env-delivery-024e7c80895b` (base
`06297124`, 2026-10-23).

MCP scopes used to be truthful only on the backend host: a container's
provider homes are copies made by the entrypoint, so the editor could not
offer environment-private configuration, and Cursor's user servers never
reached containers. This file covered durable container-private
configuration, deliberate delivery of host defaults, and the location,
network and authentication semantics outside the backend host. The code is
done; what is left is live qualification with real provider sessions and a
remote browser.

## Current state

- **Environment overlay** (`apps/backend/src/core/mcp-management/overlay.ts`,
  `overlay-store.ts`, `overlay-service.ts`). A container target's copies of the
  backend user's files are `environment-private` sources (owner
  `environment-overlay`) and the target's default source. A save records the
  intent in a private record under the `mcp-environment-overlays` environment
  state root, keyed by environment id, then writes the container's file
  through a narrow writer. After every boot, `startContainerRuntime` calls
  `materialiseEnvironment`, which rebases each record on the fresh inherited
  copy and writes it back before any bridge or terminal starts.
  `CONTAINER_READ_ONLY_REASON` is retired. The full behaviour is in
  [`mcp-management.md`](../../architecture/mcp-management.md#containers).
- **Writer** (`writeContainerMcpFile`, `commands-registry-mcp.ts`): a fixed
  Node program run with `docker exec -i --user node`. The destination, expected
  digest, mode and bound go in argv; the payload goes on stdin. It only writes
  under `/home/node` or `/workspace`, follows no symlinks, compares and swaps
  on the exact bytes, and replaces the file atomically. The renderer never
  supplies a command or a path.
- **Container project scope**: writable through the same writer, without an
  overlay, only when the environment's workspace is a persistent `volume-v1`
  volume. Otherwise it is read-only, with
  `CONTAINER_PROJECT_EPHEMERAL_REASON`.
- **Cursor** (`portable-inputs.ts`, `docker/entrypoint.sh`, `staged-inputs=2`):
  only `~/.cursor/mcp.json` is staged and copied (mode 0600), and existing
  opt-outs apply. The `blocked-policy` branch in `containerDelivery` is gone.
- **Refresh defaults** (`preview_mcp_environment_defaults`,
  `refresh_mcp_environment_defaults`): shows the change first and refuses a
  stale preview. It keeps this environment's changes on top and rewrites the
  container's staged input, so the next boot inherits the refreshed servers.
- **Copy** (`containerDelivery`, `backendUserContainerNote`): Claude
  containers pick a backend-user change up at their next start, because
  `.claude.json` is staged again before every start. Other providers point at
  "refresh defaults, or rebuild". A real rebuild was run to confirm this (see
  Evidence).
- **Hints** (`network-hints.ts`, `path-audit.ts`):
  - Save previews say when `localhost` is the container itself.
  - Save previews say when a restricted container's allowlist lacks the URL's
    host and port. The allowlist is never changed.
  - Rows flag host-only or Windows `command` and `cwd` paths that are missing
    in the container. Nothing is installed.
  - Container targets do not advertise in-app sign-in.

## Outstanding work

### Code

All six code items are done; the decisions behind them are in
[Assumptions and decisions](#assumptions-and-decisions).

1. ~~**Durable environment overlay.**~~ Done. Records are private, keyed by
   environment and source, schema-versioned and bounded
   (`overlayRecordMaxBytes`). They hold additions, replacements and tombstones
   relative to the inherited entries, plus the overlay revision, the baseline
   fingerprint and the materialised fingerprint.
   - Materialisation runs after the entrypoint copies and before bridges
     start, and touches only the server map.
   - Divergence is reported (`diverged`). Edits are refused with
     `environment-diverged` until the user imports or reapplies. A rebuild over
     a changed inherited entry holds a conflict instead of choosing a side.
   - The record is in an environment state root, so environment deletion and
     the orphan reconciler remove it. No export or diagnostic bundle exists to
     exclude it from, and no environment-clone feature exists to copy it.
   - Writes go through the narrow writer. Container write capabilities are
     enabled and `CONTAINER_READ_ONLY_REASON` is removed.
2. ~~**Container project scope.**~~ Done for `volume-v1` workspaces; read-only on
   legacy layers.
3. ~~**Cursor user-MCP delivery.**~~ Done (`staged-inputs=2`). Only `mcp.json`
   is staged, with opt-outs, bounds, symlink refusal and 0600.
4. ~~**Refresh defaults.**~~ Done. The copy now points at rebuild, confirmed by a
   real rebuild run. The preview → refresh operation is implemented.
5. ~~**Path audit.**~~ Done. Every container source is checked, including the
   copied `.claude.json`, Grok and OpenCode. Missing absolute `command` and
   `cwd` paths, and Windows paths, become row warnings. Nothing is installed.
6. ~~**Network and authentication.**~~ Done on the backend:
   - container-`localhost` and allowlist warnings in previews (the allowlist
     is never widened);
   - container sign-in unsupported, with a reason;
   - host OAuth stores never copied.

   The editor shows the execution location near URL fields, and the agent
   info panel shows it beside failed MCP connections (see the UI note in
   Evidence).

### Qualification

Container runs batch with
[0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md);
remote runs with
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- ~~The overlay survives backend restart, container stop and start, and a
  preserving rebuild; tombstones hold.~~ Proved on real Docker (Evidence).
- ~~Host files are byte-for-byte unchanged by container-private edits.~~ Proved
  for the host user file (service test) and the staged input (live).
- ~~An in-container edit produces a conflict and can be imported.~~ Proved live
  (`diverged`, then `import`, then a restart keeps it).
- ~~Environment deletion removes only its own overlay and jobs.~~ The overlay is
  in `ENVIRONMENT_STATE_ROOTS`, so the per-environment cleanup entry and the
  orphan reconciler cover it (`environment-cleanup.test.ts`,
  `environment-state-paths.test.ts`). The overlay has no jobs. No real-stack
  deletion was run for this change.
- ~~Pi and Cursor delivery respect opt-outs, size bounds, symlink rules and
  modes.~~ Cursor: unit tests plus the live entrypoint run. Pi was already
  covered.
- A remote browser and a restricted network show the right execution and
  callback scope. **Restricted network: done** (service tests). **Remote
  browser: open.** It needs a browser on a second machine against a remote
  backend: check that the URL location hint and the container sign-in reason
  show, and that no callback is offered.
- Existing terminal work and background native sessions are not interrupted.
  **Open for a live run.** By construction the save path writes one file and
  schedules no restart, and materialisation runs only after a boot, before
  launch. What is still missing is a run with real provider sessions in a
  container: save an environment-private server during a running turn, then
  check the turn continues and the next turn loads it (Claude, Codex reload,
  Cursor and Pi reattach). The harness exists:
  `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 ORKESTRATOR_AGENT_TEST_MCP_CONTAINER=1`
  runs `e2e/agent-testing/mcp-apply-live.spec.ts` against container
  environment-private sources. It needs provider credentials and has not been
  run for this change.
- **Real-browser pass of the overlay UI: open.** The overlay states, the
  conflict and divergence actions, and the refresh dialog need a check in a
  real browser on a `dev:test` profile with a container fixture. See the UI note
  in Evidence for what the unit tests cover.
  `e2e/agent-testing/mcp-overlay-recovery.spec.ts` (opt-in,
  `ORKESTRATOR_AGENT_TEST_DOCKER=1`) drives the corrupt-record reset through
  the real renderer and a disposable container, including a reload. No run of
  it is recorded for this change.

### Evidence

- Unit and service tests:
  - `overlay.test.ts`: merge, rebase, tombstones, conflicts, divergence,
    import and the server-map rewrite.
  - `service-overlay.test.ts`: 20 cases covering the private save, an
    unchanged host file, backend restart, stop and start, rebuild, pending
    restarts, conflicts and both resolutions, blocked divergence, import,
    reapply, reset, an unreadable record, defaults refresh with a stale token,
    persistent project writes, the container apply plan, network and
    `localhost` warnings, the path audit and sign-in.
  - Also updated: `providers.test.ts`, `service.test.ts`,
    `service-apply.test.ts`, `service-limits.test.ts`, `service-pi.test.ts`,
    `commands-registry-mcp.test.ts`, `environment-state-paths.test.ts`, and the
    Cursor staging tests in `apps/backend/tests/portable-inputs.test.ts` and
    `tests/unit/runtime-env-wiring.test.ts`.
- Live Docker, 2026-10-23: `apps/backend/tests/mcp-overlay-live.test.ts`
  against an image built from this tree (`orkestrator-v2:mcp0040-qual`,
  capabilities include `staged-inputs=2`), run with `RUN_LIVE_DOCKER_TESTS=1`.
  All three cases passed:
  1. Cursor and the writer:
     - only `mcp.json` is copied, with mode 0600;
     - the writer reports a conflict on a stale digest;
     - environment-private files are written 0600 and owned by `node`;
     - a new project file gets 0644;
     - writes are refused outside the homes, on traversal, and through file
       and directory symlinks;
     - the boot id and the path probe work.
  2. Overlay round trip:
     - a save, then a backend restart (new service), then a real
       `docker stop`/`docker start`: the entrypoint restored the inherited copy,
       the snapshot showed `pending`, and materialising restored the overlay
       (the tombstone held);
     - a replacement container for the same environment: the overlay was
       reapplied;
     - an in-container `sed` edit was reported `diverged`, imported, and kept
       after another restart;
     - the staged input was byte-for-byte unchanged.
  3. Real rebuild:
     - a `volume-v1` environment created by `createDockerContainer`, with the
       backend user's Codex `config.toml` changed between creation and
       rebuild;
     - `replaceRuntimePreservingState` returned `rebuild` with a new inputs
       revision label;
     - the real `startAssignedContainerRuntimeTask` produced the new host
       servers plus the overlay's server, without the in-container edit.

  This confirms item 4's premise that a rebuild re-imports current defaults
  and drops edits made only inside the old container.
  The existing `container-live-replacement.test.ts` C14 rebuild case also
  passed on the same image.

  After the Multi Review fixes and a merge of `origin/main`, the same suite
  was rerun against a fresh image built from the merged tree
  (`orkestrator-v2:mcp0040-qual2`). All 3 cases passed (46 assertions, none
  skipped), and no containers were left behind.
- Observation, not investigated here: my first version of the rebuild test
  went through a legacy-to-volume **migration** of a container that had
  staged Codex inputs, and the migration refused with `root-symlink` twice.
  C14, which stages no inputs, passes, and a fresh staged container has no
  symlinks in its homes. This is tracked in
  [0058-legacy-migration-root-symlink.md](../containers-and-environments/0058-legacy-migration-root-symlink.md).
- UI (`apps/web/src/components/settings/mcp-servers/`):
  - `McpEnvironmentOverlay.tsx` shows each overlay state with its actions:
    reapply when pending; import or reapply when diverged; keep or use
    inherited per conflict; and reset behind a confirm dialog.
  - It also adds "Refresh from backend user…": a preview dialog, then a
    confirm that sends the preview token. A stale token offers "Preview
    again".
  - Rows show the path-audit warnings.
  - The URL field says "Connects from {location}, not from this browser" and
    shows the container sign-in reason.
  - The agent info panel shows the execution location next to failed or
    needs-auth MCP servers. This is the one place users see live connection
    errors. Its label is built in the renderer with the same wording as
    `targets.ts`.
  - Tests: `McpEnvironmentOverlay.test.tsx` (14) and
    `AgentInfoMcpSection.test.tsx` (3 new). The web typecheck and the MCP web
    tests pass.
  - `mise run test:browser` has no MCP settings spec. Two unrelated specs,
    `AgentLaunchDialog.spec.ts:7` and `MonacoRuntime.spec.ts:3`, failed in the
    aggregate run. MonacoRuntime passed on rerun. AgentLaunchDialog `:7` also
    fails on an untouched checkout of the base commit `062971245`, so it is
    pre-existing and not caused by this change.

### Multi Review outcome

Review `action-3c17fc0ed92229805417a24b4140af95` (head `8dbb9b6d5`) found
8 issues and 10 test-coverage gaps (verdict: with fixes). A Fix session
committed `a8392601d`. I checked each fix against its finding and test, and
hardened one of them in `58f784b8b`.

| # | Finding | Outcome |
| --- | --- | --- |
| 1 (P0) | When the backend user has no staged file, the entrypoint leaves the previous output in place. Rebase then treated the overlay's own output as inherited and dropped the changes. | Fixed. Materialisation does not rebase when the file matches the last verified output. Covered by a service test (retained output, then an empty rebuild). |
| 2 | A corrupt record could not be reset. | Fixed. Snapshots report a `corrupt` overlay state. Reset restores the backend user's current servers and removes the record. The UI offers it. Covered by service, web and e2e (opt-in) tests. |
| 3 | A failed boot write was stamped as successful, then misread as divergence. | Fixed. The success stamp is written only after the container write. Hardened further in `58f784b8b`: the rebased baseline is persisted before the write, and observation treats a file that already holds the expected servers as in sync. A record write failing after the container write therefore cannot make the next retry rebase on the overlay's own output. The test fails without the change. |
| 4 | Boot materialisation did not take the per-source lock. | Fixed. It runs under the same lock as saves, resolutions and refresh. Barrier tests cover interleaving with each. |
| 5 | Resolutions while pending used the stale baseline. | Fixed. Every resolution first rebases on the fresh inherited copy. Covered by tests for reset, keep and take. |
| 6 | Server names such as `toString` collided with `Object.prototype`. | Fixed. All map lookups check own properties. Covered by round-trip tests. |
| 7 | An OpenCode overlay vanished when a rebuild inherited a different filename. | Fixed. Recorded OpenCode source ids stay discoverable, limited to the fixed filename allowlist. |
| 8 (P2) | A Claude defaults refresh reported a false staged-copy warning. | Fixed. A new `not-needed` outcome; Claude is re-staged before every start. |

Gaps 1–8 and 10 have tests now. Gap 10, the writer program, runs the exact
production script against remapped scratch roots, with no Docker. Gap 9 (real
provider sessions in a container) remains open; the harness is listed under
Qualification. No finding was rejected.

Other changes in the fix commit:

- an opt-in container mode in `mcp-apply-live.spec.ts`;
- the new opt-in `mcp-overlay-recovery.spec.ts`;
- recurrence notes in flake cases 0197, 0518, 0627 and 0382, from its own
  validation runs.

All of these are additive and in scope.

## Constraints and rationale

- The overlay exists only because container homes are copies, not a durable
  statement of intent. It is not a second registry for native sources, and it
  records intent relative to inherited inputs rather than a copy of a whole
  provider home.
- Do not mount writable host homes into containers, and never write a
  container-home edit through to the host staging copy. A defaults refresh
  rewrites only the server map of the environment's own staged input, from the
  backend user's file, never from the container.
- All paths, environment references and stdio executables resolve on the
  execution machine: a remote browser's `localhost`, the backend's and a
  container's are three different hosts.
- Container network policy stays authoritative, for coordinator and review
  sessions too. Do not log rejected URL query strings or headers.
- Terminal sessions get guidance only; no command is injected and nothing is
  restarted.

## Assumptions and decisions

1. **Where the overlay lives.**
   - Options: a JSON record per environment and source under an environment
     state root; a table in the backend SQLite database; files inside the
     container's persistent `state` volume.
   - Chosen: a private JSON record under a new `mcp-environment-overlays`
     state root, keyed by `environmentStateKey`.
   - Why: deletion, the orphan reconciler and the hashed naming already exist
     for state roots. It never enters a container, a volume or a recovery copy.
   - Pros: no new cleanup path; it is outside every container boundary.
   - Cons: it is one more private directory, and it holds literal
     credentials. The mitigation is owner-only files, written atomically and
     bounded. A SQLite table would have given transactions with the
     operation store, but needs a migration and its own deletion hook. The
     volume option was rejected because a rebuild copies volumes into
     recovery copies, and the backend would have to reach into a volume to
     read its own intent.
2. **What a change records.**
   - Options: per-name changes with the keyed digest of the inherited entry
     they were made against, plus a stored baseline; a copy of the whole
     desired server map.
   - Chosen: per-name changes plus the baseline.
   - Why: rebase can tell "inherited unchanged" from "inherited changed under
     my change", which is what the conflict rule needs. Tombstones fall out
     naturally.
   - Pros: precise conflicts; additions and removals survive rebuilds.
   - Cons: the stored baseline duplicates inherited entries, which can carry
     credentials, in backend data. That data is private and on the same
     machine as the host file.
3. **Conflict outcome.**
   - Options: the inherited value wins until the user decides; the
     environment's change wins; fail materialisation.
   - Chosen: the inherited value is written, the change is held, and the
     conflict is surfaced with "keep this environment's" or "use inherited".
   - Why: the todo forbids silently choosing a side and failing the
     environment. Something must be in the file, and the inherited value is
     what every other environment sees.
   - Pros: starts always succeed; no intent is lost.
   - Cons: until the user resolves it, sessions use the inherited server for
     that name.
4. **Divergence.**
   - Options: block edits until resolved; auto-import; auto-reapply.
   - Chosen: block, and offer import or reapply.
   - Why: the todo says "never a silent overwrite".
   - Pros: no lost edits.
   - Cons: one extra click after an in-container edit.
5. **Restarts outside Orkestrator** (`docker start` by hand).
   - Options: rewrite during the snapshot; report `pending` and write on the
     next save or reapply; ignore.
   - Chosen: report `pending`. A boot id that differs from the one recorded is
     treated as a fresh inherited copy, never as an edit.
   - Why: snapshots stay passive.
   - Cons: bridges launched before the next save or reapply load the inherited
     copy, and a draft made against the bare copy becomes stale (revision
     conflict, reload).
6. **Edits need a running container.**
   - Options: also allow recording against the stored baseline while stopped.
   - Chosen: running only. A stopped container is `offline`, as before.
   - Why: every save is checked against the bytes actually in the file.
   - Cons: the environment must be started to edit.
7. **The writer.**
   - Options: a script shipped in the image (a new capability); a fixed
     program passed to the image's `node`; shell `cat >`.
   - Chosen: a fixed Node program in backend code.
   - Why: it works on every existing image, which already ships Node 24, and
     it can do lstat checks, compare-and-swap, atomic rename and modes,
     which `cat` cannot.
   - Cons: the program text is passed on each exec. It is a constant and is
     never built from data.
8. **Claude private-local in containers.**
   - Options: make it writable through the overlay too.
   - Chosen: read-only, with a reason.
   - Why: the entrypoint rebuilds `.claude.json`'s project map on every start.
     The environment-private user map covers the same need without a second
     overlay subtree in one file.
9. **Open question 1: container project-scope writes without the overlay.**
   - Chosen: yes, but only on `volume-v1` workspaces. There `/workspace` is
     persistent and behaves like a worktree file.
   - Legacy layers stay read-only because a rebuild would lose the edit.
10. **Open question 2: overlay in rebuild recovery copies.**
    - Chosen: excluded.
    - Why: the overlay is backend data keyed by environment id, not container
      storage. A rebuild or a restored recovery copy gets it reapplied at its
      next boot, so copying it would only duplicate credentials.
11. **Cursor capability.**
    - Chosen: bump `staged-inputs` to 2 rather than add a new capability. The
      backend skips staging Cursor for images below 2, so input status stays
      truthful.
12. **Container `runtimeSignIn`.**
    - Chosen: unsupported for every container target, with a reason.
    - Why: no callback path from a browser to a container has been proven.
      Remote backends are not detected on the backend side; the editor shows
      where the connection is made from instead.
13. **Defaults refresh scope.**
    - Chosen: only the server map is refreshed, in both the container file and
      the staged input. Claude's staged file is not rewritten because it is
      already re-staged before every start.
    - Cons: other non-MCP settings changed on the host still need a rebuild.
14. **Resolutions do not schedule runtime apply.**
    - Chosen: import, reapply, conflict resolution, reset and refresh do not
      create an apply operation. Sessions adopt the file the way they adopt
      any external change: Claude at the next message, Cursor and Pi at the
      next turn, Codex, OpenCode and Grok at their next process start.
    - Cons: Codex does not reload immediately after a resolution.

15. **Recovering an unreadable record** (from review finding 2).
    - Chosen: reset rewrites the server map to the backend user's current
      servers, then deletes the record.
    - Why: a corrupt record cannot supply a trusted baseline, and the backend
      user's file is the only verified source.
    - Pros: the source becomes writable again.
    - Cons: the environment's changes are lost, which is unavoidable since
      they cannot be read.
    - Rejected: leaving the environment blocked until it is deleted.
16. **Ordering a boot's writes** (from review finding 3 and my hardening).
    - Chosen: persist the rebase, then write the container, then stamp
      success. Each step is safe to stop after.
    - Rejected: a single record write either before the container write
      (which could misreport divergence) or after it (which could lose the
      new baseline).

## Open questions

None left; both earlier questions are answered in decisions 9 and 10.

## Related

- [0039-mcp-management.md](0039-mcp-management.md) for the editor, apply paths and
  provider rules.
- [0021-container-rebuild-state-preservation.md](../containers-and-environments/0021-container-rebuild-state-preservation.md)
  for state layout and staged inputs, and
  [0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md)
  for the allowlist and staged-input credentials.
- [0058-legacy-migration-root-symlink.md](../containers-and-environments/0058-legacy-migration-root-symlink.md)
  for the migration refusal seen while qualifying this file.
- [`container-lifecycle.md`](../../architecture/container-lifecycle.md)
  ("Provider state", the provider-state inventory).
- [`mcp-management.md`](../../architecture/mcp-management.md) ("Containers").

## Replaces

- `docs/improvements/mcp/plan/13-environment-delivery.md`
- `docs/improvements/mcp/plan/00-index.md` (the container recreation release
  gate)
- `docs/improvements/mcp/plan/14-validation-and-rollout.md` (container and
  remote-browser evidence)
- `docs/improvements/mcp.md` ("Environment and persistence findings")
