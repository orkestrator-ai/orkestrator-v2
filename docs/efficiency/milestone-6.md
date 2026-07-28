# Milestone 6 — Large payloads and optional connection brokerage

Status: Not started

Depends on: Milestone 5

Unblocks: completion of the efficiency plan

## Outcome

Remove base64 expansion from prompt attachments, bound any compressed request
handling, and use measured iOS evidence to decide whether bridge-stream
brokerage is warranted.

## Scope

Primary areas:

- gateway request parsing and upload routes
- prompt attachment persistence and cleanup
- web prompt composition and submission
- bridge subscription routing
- iOS connection telemetry
- security, request-limit, and recovery tests

## Implementation checklist

### Attachment upload

- [ ] Define an authenticated multipart or binary upload endpoint.
- [ ] Return a short-lived opaque attachment handle.
- [ ] Reference handles from prompt JSON.
- [ ] Validate MIME type and extension independently of client claims.
- [ ] Enforce encoded and decoded byte limits.
- [ ] Associate handles with the authenticated client/environment.
- [ ] Prevent cross-client or cross-environment handle use.
- [ ] Define expiry and cleanup on success, cancellation, timeout, and restart.
- [ ] Make prompt retries idempotent without duplicating stored attachments.
- [ ] Avoid logging attachment names or contents where they may be sensitive.
- [ ] Migrate existing inline-data prompts with a compatibility path.

### Large text request bodies

- [ ] Measure remaining large command bodies after prior milestones.
- [ ] Prefer revisioned small updates over whole-snapshot writes.
- [ ] Add request gzip only for measured text-heavy cases.
- [ ] Stream decompression with an encoded-byte limit.
- [ ] Enforce a decoded-byte limit during expansion.
- [ ] Reject unsupported or stacked encodings.
- [ ] Return clear errors for invalid or oversized compressed bodies.
- [ ] Ensure decompression cannot block the shared event loop.

### iOS connection decision

- [ ] Measure open and connecting streams by environment/provider.
- [ ] Measure time-to-open, reconnect frequency, stalls, and background recovery.
- [ ] Record negotiated HTTP/2 or HTTP/3 behavior through Tailscale Serve.
- [ ] Record device energy/network impact for multiple active environments.
- [ ] Define a reproducible threshold that would justify brokerage.
- [ ] Decide and record either `Implement` or `Defer`.

### Optional bridge brokerage

Complete this section only if the measured decision is `Implement`.

- [ ] Share one provider subscription per environment where practical.
- [ ] Namespace provider/session events through a gateway-managed stream or the
      established WebSocket.
- [ ] Preserve each bridge's cursor and authoritative hydration path.
- [ ] Preserve approval ownership, timeout, disconnect, and denial behavior.
- [ ] Bound queues independently by provider and client.
- [ ] Prevent one provider's backpressure from blocking other providers or the
      main gateway stream.
- [ ] Recreate subscriptions after gateway and bridge restarts.
- [ ] Keep direct bridge-stream fallback during rollout.

## Required tests

- [ ] Authenticated upload success.
- [ ] MIME mismatch, oversize, expired, foreign, replayed, and cancelled handle
      rejection.
- [ ] Cleanup after success, failure, expiry, and restart.
- [ ] Idempotent prompt retry.
- [ ] Encoded and decoded request-body limits.
- [ ] Invalid, truncated, and expansion-heavy gzip rejection.
- [ ] Event-loop responsiveness during a maximum accepted request.
- [ ] Existing inline attachment compatibility.

If brokerage is implemented:

- [ ] Provider/session routing isolation.
- [ ] Approval routing and deny-on-failure behavior.
- [ ] Independent backpressure.
- [ ] Cursor replay, expiry, and authoritative reconciliation.
- [ ] Gateway and bridge restart recovery.
- [ ] Direct-stream fallback.

## Manual verification

- [ ] Send representative PNG, JPEG, GIF, and WebP prompts.
- [ ] Retry, cancel, disconnect, and restart during upload and prompt dispatch.
- [ ] Inspect request payloads and confirm prompt JSON contains handles, not
      base64 bodies.
- [ ] Compare upload bytes and memory against the Milestone 0 baseline.
- [ ] Test iOS with multiple active Claude, Codex, OpenCode, and terminal
      sessions.
- [ ] Complete the inactive-environment path.
- [ ] If brokerage is implemented, verify pending approvals and interactions
      after background/foreground and restart.

## Commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun test tests --parallel
bun test bridges --parallel
bun run test
```

## Exit criteria

- [ ] New prompt images and files do not use base64 command JSON.
- [ ] Upload authorization, limits, expiry, cleanup, and retry are verified.
- [ ] Any request decompression is bounded in encoded and decoded units.
- [ ] The iOS connection decision is supported by recorded measurements.
- [ ] Brokerage is either implemented with independent safety bounds or
      explicitly deferred.
- [ ] Compatibility and rollback paths are documented.
- [ ] Focused tests, typechecks, security cases, and the full suite pass.
- [ ] Final before/after efficiency results are recorded.

## Evidence and decisions

Record:

- attachment transfer and peak-memory comparison;
- cleanup and expiry choices;
- commands eligible for request compression;
- iOS connection-count, stall, recovery, and energy measurements;
- brokerage `Implement`/`Defer` decision and threshold;
- final plan-wide before/after table;
- test command results.

No evidence recorded yet.
