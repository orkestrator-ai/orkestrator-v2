# Milestone 3 — Repeated payload and polling reduction

Status: Implemented; manual verification pending

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

- [x] Add a Codex `message.patched` event compatible with the proven Claude
      patch model.
- [x] Send one complete `message.updated` when a message appears or its ID
      changes.
- [x] Compare normalized parts with the last published version.
- [x] Send changed part indexes and authoritative `partCount`.
- [x] Increment and validate a per-message revision.
- [x] Reconcile from `/session/:id/messages` on a missing, duplicate, or
      out-of-order base revision.
- [x] Flush pending patches before ordered status, approval, interaction,
      error, and idle events.
- [x] Preserve completed large tool-part identities so they are sent once.
- [x] Keep rendering, diffing, and delivery off the app-server stdout loop.
- [x] Keep the complete-message path as a compatibility and recovery fallback.

### Terminal payload and snapshots

- [x] Add a plain UTF-8 terminal payload form.
- [x] Retain base64 client decoding for one compatibility release.
- [x] Add `sinceRevision` to terminal snapshot commands.
- [x] Return only retained missing chunks when possible.
- [x] Return an explicit full snapshot on revision expiry or generation change.
- [x] Preserve output ordering across snapshot hydration and live subscription.
- [ ] Measure client decoding CPU before and after removing base64 from the
      normal path.

### tmux capture

- [x] Replace changed full-pane repaints with line- or region-level diffs.
- [x] Keep full repaint on first attach, force, desync, and generation change.
- [x] Ensure cursor movement, ANSI attributes, wrapped lines, alternate screen,
      resize, and clear-screen behavior remain correct.
- [x] Reduce hidden Claude tmux capture traffic without losing status or
      authoritative recovery.

### Environment wire projection

- [x] Define an explicit client-facing environment type.
- [x] Stop returning raw stored records from `get_environments`.
- [x] Exclude initial prompt attachments from environment lists.
- [x] Exclude duplicated per-environment model catalogs.
- [x] Exclude backend activity observations and renderer lease bookkeeping.
- [x] Exclude launch-only prompt fields after they are no longer needed.
- [x] Store attachment base64 once and reconstruct `previewUrl` client-side.
- [x] Return a narrow activity-update result instead of a complete environment.
- [x] Confirm no affected client was implicitly relying on removed fields.

### Conditional refreshes and response shapes

- [x] Add `projectId` to environment announcements.
- [x] Refresh only the affected project's environment list.
- [x] Add cheap revision checks to build transcript polling.
- [x] Add conditional resource-sync commands that can return unchanged without
      a full snapshot.
- [x] Gate files-panel tree and change-list refreshes on revisions/digests.
- [x] Add incremental build message retrieval where live patches are
      insufficient.
- [x] Cache or revision-key the base-branch side of diff viewing.
- [x] Review redundant path-derived fields in file-tree and Git-change payloads.
- [x] Retain the broad inactive-environment sweep until Milestone 4 proves its
      replacement.

## Required tests

- [x] Codex initial full message followed by patches.
- [x] Codex patch duplicate, gap, out-of-order, and reconciliation cases.
- [x] Pending patch ordering before approval, interaction, error, and idle.
- [x] A completed large tool part is not resent in later patches.
- [x] The app-server read loop does not await publish consumers.
- [x] Terminal delta snapshot hit, expiry, and generation mismatch.
- [x] Terminal snapshot/live-event ordering.
- [x] tmux diff correctness for ANSI, wrap, resize, clear, and desync.
- [x] Environment projection excludes every internal or large field.
- [x] Activity renewal returns only the narrow result.
- [x] Environment announcement refreshes one project.
- [x] Unchanged polling resources transfer no full payload.

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

- [x] Codex streaming sends changed parts instead of complete growing messages.
- [x] Patch gaps reconcile exactly without breaking approvals or ordering.
- [x] Terminal reconnect cost is proportional to the retained gap.
- [x] tmux no longer repaints the full pane for ordinary small changes.
- [x] Environment lists contain no attachments or backend lease internals.
- [x] Stable polling does not transfer unchanged complete snapshots.
- [x] Base64 and complete-message compatibility paths remain available.
- [x] Focused tests, typechecks, and the full suite pass.

## Evidence and decisions

Record:

- bytes for representative 256 KiB and 1 MiB Codex turns before/after;
- terminal delta/full snapshot byte comparison;
- tmux repaint rate and bytes;
- environment list size with representative attachments and environment count;
- stable polling request and byte rate;
- compatibility-removal target release;
- test command results.

Implementation and automated verification completed on 2026-07-30.

- Representative ASCII terminal frames, including the JSON envelope:
  - 256 KiB: base64 `349,574` bytes; plain UTF-8 `262,183` bytes
    (`87,391` bytes / `25%` smaller).
  - 1 MiB: base64 `1,398,150` bytes; plain UTF-8 `1,048,615` bytes
    (`349,535` bytes / `25%` smaller).
- Representative 80x24 tmux capture:
  - full repaint: `1,973` bytes;
  - one changed-line patch: `91` bytes (`95.39%` smaller).
- Terminal delta retention is bounded to 1,024 chunks and 2 MiB of UTF-8
  bytes. Tests cover a delta hit, count-bound expiry, generation mismatch, and
  snapshot/live ordering.
- Codex tests cover the initial full frame, successor patches, duplicate/gap
  rejection, authoritative reconciliation, ordering before approval,
  interaction, warning, and idle, plus completed large-tool-part identity.
- Environment projection tests cover attachment bodies, model catalogs,
  activity observations, renderer leases, backend PIDs, rename prompts, and
  expired launch-only fields. Stored attachment previews are reconstructed
  client-side from the single durable base64 body.
- Conditional build, file-tree, and Git-change reads retain their legacy full
  response when no cursor/digest is supplied. Stable clients receive
  `unchanged` responses or bounded build-message tails.
- Base64 terminal decoding and complete Codex message/REST recovery remain for
  one compatibility release. A removal version has not been selected.
- Verification:
  - backend, web, desktop, Codex bridge, and protocol typechecks passed;
  - `bun run test` passed all workspace, root, bridge, and protocol groups;
  - the pinned Codex protocol artifacts matched;
  - iOS simulator: 40 tests, 0 failures.

No pre-change live-device baseline was captured in this workspace. The manual
disconnect, full-screen tmux, inactive-environment, constrained-link, and
real-device measurements above remain required before changing this milestone
to `Complete`.

Checklist reconciled against PR #237 and current main on 2026-07-31. The
terminal client decoding CPU comparison remains open because the recorded
before/after evidence measures wire bytes, not decode time. All manual
verification items remain open. Focused reconciliation runs on current main
passed 526 root tests (one live-container test skipped), 498 web tests, and 268
Codex bridge tests.
