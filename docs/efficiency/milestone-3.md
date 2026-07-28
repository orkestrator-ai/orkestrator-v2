# Milestone 3 — Repeated payload and polling reduction

Status: Not started

Depends on: Milestone 2

Unblocks: Milestone 4

## Outcome

Eliminate repeated complete messages, terminal buffers, environment internals,
and unchanged polling responses before introducing new synchronization and
terminal transports.

## Scope

Primary areas:

- `bridges/codex-bridge`
- `apps/backend/src/core/commands.ts`
- `apps/backend/src/core/tmux.ts`
- `apps/backend/src/core/models.ts`
- Codex and terminal web stores/hooks
- build, resource-sync, file-panel, environment-list, and diff-viewer clients

## Implementation checklist

### Codex message patches

- [ ] Add a Codex `message.patched` event compatible with the proven Claude
      patch model.
- [ ] Send one complete `message.updated` when a message appears or its ID
      changes.
- [ ] Compare normalized parts with the last published version.
- [ ] Send changed part indexes and authoritative `partCount`.
- [ ] Increment and validate a per-message revision.
- [ ] Reconcile from `/session/:id/messages` on a missing, duplicate, or
      out-of-order base revision.
- [ ] Flush pending patches before ordered status, approval, interaction,
      error, and idle events.
- [ ] Preserve completed large tool-part identities so they are sent once.
- [ ] Keep rendering, diffing, and delivery off the app-server stdout loop.
- [ ] Keep the complete-message path as a compatibility and recovery fallback.

### Terminal payload and snapshots

- [ ] Add a plain UTF-8 terminal payload form.
- [ ] Retain base64 client decoding for one compatibility release.
- [ ] Add `sinceRevision` to terminal snapshot commands.
- [ ] Return only retained missing chunks when possible.
- [ ] Return an explicit full snapshot on revision expiry or generation change.
- [ ] Preserve output ordering across snapshot hydration and live subscription.
- [ ] Measure client decoding CPU before and after removing base64 from the
      normal path.

### tmux capture

- [ ] Replace changed full-pane repaints with line- or region-level diffs.
- [ ] Keep full repaint on first attach, force, desync, and generation change.
- [ ] Ensure cursor movement, ANSI attributes, wrapped lines, alternate screen,
      resize, and clear-screen behavior remain correct.
- [ ] Reduce hidden Claude tmux capture traffic without losing status or
      authoritative recovery.

### Environment wire projection

- [ ] Define an explicit client-facing environment type.
- [ ] Stop returning raw stored records from `get_environments`.
- [ ] Exclude initial prompt attachments from environment lists.
- [ ] Exclude duplicated per-environment model catalogs.
- [ ] Exclude backend activity observations and renderer lease bookkeeping.
- [ ] Exclude launch-only prompt fields after they are no longer needed.
- [ ] Store attachment base64 once and reconstruct `previewUrl` client-side.
- [ ] Return a narrow activity-update result instead of a complete environment.
- [ ] Confirm no affected client was implicitly relying on removed fields.

### Conditional refreshes and response shapes

- [ ] Add `projectId` to environment announcements.
- [ ] Refresh only the affected project's environment list.
- [ ] Add cheap revision checks to build transcript polling.
- [ ] Add conditional resource-sync commands that can return unchanged without
      a full snapshot.
- [ ] Gate files-panel tree and change-list refreshes on revisions/digests.
- [ ] Add incremental build message retrieval where live patches are
      insufficient.
- [ ] Cache or revision-key the base-branch side of diff viewing.
- [ ] Review redundant path-derived fields in file-tree and Git-change payloads.
- [ ] Retain the broad inactive-environment sweep until Milestone 4 proves its
      replacement.

## Required tests

- [ ] Codex initial full message followed by patches.
- [ ] Codex patch duplicate, gap, out-of-order, and reconciliation cases.
- [ ] Pending patch ordering before approval, interaction, error, and idle.
- [ ] A completed large tool part is not resent in later patches.
- [ ] The app-server read loop does not await publish consumers.
- [ ] Terminal delta snapshot hit, expiry, and generation mismatch.
- [ ] Terminal snapshot/live-event ordering.
- [ ] tmux diff correctness for ANSI, wrap, resize, clear, and desync.
- [ ] Environment projection excludes every internal or large field.
- [ ] Activity renewal returns only the narrow result.
- [ ] Environment announcement refreshes one project.
- [ ] Unchanged polling resources transfer no full payload.

## Manual verification

- [ ] Run a long Codex turn with reasoning, tools, a large diff, and approval.
- [ ] Disconnect mid-turn and verify one authoritative reconciliation.
- [ ] Flood a terminal, disconnect briefly, and verify delta recovery.
- [ ] Force terminal snapshot expiry and verify exact full recovery.
- [ ] Exercise a tmux full-screen program, resize, alternate screen, and scroll.
- [ ] Create an environment with image attachments and inspect list payloads.
- [ ] Leave build, files, and resource-sync polling stable and confirm bytes
      stop transferring.
- [ ] Complete the inactive-environment path.

## Commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun test bridges/codex-bridge --parallel
bun test tests --parallel
bun run test
```

## Exit criteria

- [ ] Codex streaming sends changed parts instead of complete growing messages.
- [ ] Patch gaps reconcile exactly without breaking approvals or ordering.
- [ ] Terminal reconnect cost is proportional to the retained gap.
- [ ] tmux no longer repaints the full pane for ordinary small changes.
- [ ] Environment lists contain no attachments or backend lease internals.
- [ ] Stable polling does not transfer unchanged complete snapshots.
- [ ] Base64 and complete-message compatibility paths remain available.
- [ ] Focused tests, typechecks, and the full suite pass.

## Evidence and decisions

Record:

- bytes for representative 256 KiB and 1 MiB Codex turns before/after;
- terminal delta/full snapshot byte comparison;
- tmux repaint rate and bytes;
- environment list size with representative attachments and environment count;
- stable polling request and byte rate;
- compatibility-removal target release;
- test command results.

No evidence recorded yet.
