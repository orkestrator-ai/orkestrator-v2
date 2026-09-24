# 05 — Safe saving and export

Status: Planned.  
Dependencies: [02](02-operation-contracts-and-durability.md),
[03](03-client-controller-and-reconciliation.md).  
Findings: R3.

## Outcome

Save exports an explicitly identified committed revision to a chosen repository
path. It cannot silently replace a different canvas's file. An interrupted
export leaves either the old complete file or the new complete file, with a
recoverable receipt. Workspace autosave, repository export, and download have
distinct states.

## Owners

`commands-registry-design.ts`, `design-service.ts`, `design-tools.ts`,
`DesignCanvasTab.tsx`, and the client controller. Inspect/reuse confinement in
`path-safety.ts` and `shell.ts`; container writing is currently registered in
`commands-registry-terminal.ts`. Prefer a dedicated shared safe-export helper
over silently changing every generic file writer's semantics.

## Save contract and metadata

- [ ] Add a backend-only export association: canvas ID, environment/repository
  identity, relative path, last exported canvas revision, file digest, timestamp,
  and last export operation token. No absolute host path in portable files.
- [ ] Define Save Preview/Save As validation that returns target existence,
  parsed canvas identity when readable, a bounded target fingerprint, and
  whether an explicit replacement choice is needed.
- [ ] Default new filenames to a sanitized human name plus a short canvas-ID
  suffix. Repeated default names and names sanitizing to the same string must
  generate distinct initial suggestions.
- [ ] Start with the existing repository-root filename restriction. Add nested
  directories only with equivalent local/container confinement tests; do not
  accidentally relax path safety merely to support a file picker.
- [ ] Treat an existing unreadable/non-design file as a collision, not as an
  empty target. Return a specific bounded error without echoing file contents.
- [ ] Do not treat a matching canvas ID as permission to overwrite unobserved
  external edits. Require the previously read fingerprint for repeat saves.
- [ ] Save captures one immutable canvas revision at dispatch. Subsequent edits
  can continue; success reports precisely that captured revision and may already
  be marked “newer workspace changes.”

## Destination write protocol

1. Authorize the environment and validate the relative path.
2. Resolve the confined target and obtain expected destination state.
3. Create a unique same-directory temporary file with restrictive permissions.
4. Write bounded v1 JSON, sync, and verify expected destination state again.
5. Publish with an atomic filesystem primitive and sync the directory where
   supported. Clean only this operation's temporary file on failure.
6. Persist the export receipt/association and announce the exported revision.

- [ ] Serialize Orkestrator exports targeting the same destination across
  canvases. “Destination absent” must use atomic no-clobber creation, not a
  check-then-overwriting-rename race.
- [ ] For replacing existing files, document the guarantee against external
  writers. A preflight fingerprint alone is not atomic compare-and-swap on
  arbitrary filesystem contents. Use a platform-supported conditional strategy
  or preserve the overwritten version recoverably and detect/report collisions.
  If an exact precondition cannot be enforced, default to a new path rather
  than claiming lossless conditional overwrite.
- [ ] The container operation executes inside the confined workspace using an
  owned helper and streamed input; do not embed JSON/base64 in a shell command
  or truncate the final file before successful completion.
- [ ] Retain existing symlink protections for every ancestor and target.
  Renaming a temporary file must not reintroduce a path traversal race.
- [ ] Bound temporary bytes, subprocess lifetime, stderr, and cleanup. A container
  stopping mid-export produces an actionable uncertain/failed outcome.

## Cross-store recovery

Repository output and backend private state cannot be one atomic transaction.
Treat export as its own recoverable operation:

- [ ] Persist intended path, exact revision, and output digest before writing.
- [ ] On lost response/restart, inspect the confined destination. Matching exact
  bytes prove that revision was exported, even if the association update was lost.
- [ ] A different file, missing container, or unavailable repository yields a
  specific unknown/conflict state. Never overwrite again to “check” whether the
  first attempt succeeded.
- [ ] Out-of-order exports cannot regress the remembered latest export state or
  silently replace a newer revision with an older pending save.
- [ ] Do not restore a deleted canvas merely because its export receipt settles.

## UI work

- [ ] Rename/relabel controls so workspace persistence and repository export are
  clear. Show “Saved in workspace” and “Exported revision N to path” separately.
- [ ] Add Save As with chosen filename, validation, collision explanation, and
  explicit replacement/new-name choices when necessary.
- [ ] Track save busy separately from editing; retain edit controls if safe and
  report that an export is a snapshot of an earlier revision.
- [ ] If local edits are pending, offer to wait for their outcomes before export
  or export the currently committed revision explicitly. Unknown work cannot
  be silently included or called saved.
- [ ] Download fetches a committed snapshot and identifies its revision. Revoke
  object URLs on completion/cleanup and avoid accumulating large blobs.
- [ ] Remember a safe export association across reload, but validate repository
  identity and file state again after environment/worktree replacement.

## Verification

- [ ] Two default names and two sanitizer-colliding names do not overwrite.
- [ ] Cross-canvas simultaneous saves to the same absent path have one winner
  and one collision; no partly mixed JSON.
- [ ] User/agent modifies an existing destination between preview and commit:
  recoverable collision behavior matches the documented filesystem guarantee.
- [ ] Inject interruption before write, during write, after rename, and before
  association commit for both local and container paths.
- [ ] Save revision N while N+1 commits: exact N file and outdated-export state.
- [ ] Repeat execution after lost response: no unintended second overwrite.
- [ ] Stop/restart container, remove worktree, and delete canvas during export.
- [ ] Attempt traversal/symlink swaps and over-limit output: reject without
  writing outside the authorized repository.

Review slices: save metadata/preview; local atomic writer; container parity;
receipt recovery; UI Save As and revision status. Do not announce container
parity until the real isolated-container failure cases have run.
