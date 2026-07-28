# Milestone 2 — Dynamic body, event-stream, and proxy compression

Status: Not started

Depends on: Milestones 0 and 1

Unblocks: Milestone 3

## Outcome

Compress eligible dynamic responses and remote streams while preserving
latency, flow control, exact terminal recovery, and a tested identity fallback.

## Scope

Primary files:

- `apps/backend/src/gateway.ts`
- gateway compression helpers
- `tests/unit/electron/gateway.test.ts`
- `docs/remote-gateway.md`

## Implementation checklist

### Shared compression primitives

- [ ] Implement `negotiateEncoding`.
- [ ] Implement `appendVary`.
- [ ] Implement `isCompressibleContentType`.
- [ ] Implement asynchronous `compressBody`.
- [ ] Add a measured threshold, initially 1 KiB.
- [ ] Exclude WOFF2, compressed images, and unknown octet streams.
- [ ] Make header and validator behavior consistent across identity, gzip, and
      Brotli.

### Dynamic JSON and preview bodies

- [ ] Prefer asynchronous Brotli quality 4, then gzip level 6.
- [ ] Keep small responses identity.
- [ ] Preserve `Cache-Control: no-store` for private state.
- [ ] Recompress bounded HTML, CSS, and JavaScript after preview rewriting.
- [ ] Keep `Accept-Encoding: identity` toward rewriteable preview targets.
- [ ] Enforce encoded and decoded byte limits.
- [ ] Avoid synchronous compression of large invoke responses.

### Identity event writer

- [ ] Introduce `EventClientWriter` with `writableLength` defined as
      uncompressed bytes still owed.
- [ ] Move existing event-client bookkeeping to the interface without changing
      behavior.
- [ ] Keep soft-limit terminal desync notices unchanged.
- [ ] Keep hard-limit disconnect behavior unchanged.
- [ ] Confirm all existing identity-path tests pass before adding gzip.

### Compressed event writer

- [ ] Implement gzip SSE with `Z_SYNC_FLUSH` configured on the stream.
- [ ] Track pre-compression backlog in compressor write callbacks.
- [ ] Do not use only `ServerResponse.writableLength` for safety limits.
- [ ] Explicitly destroy the compressor on response close and forced drop.
- [ ] Add a priming comment so the connected frame is immediately decodable.
- [ ] Route drain and keepalive checks through the writer's true backlog.
- [ ] Keep `Cache-Control: no-store, no-transform`.
- [ ] Do not coalesce application frames for compression ratio.

### Proxied streams and bodies

- [ ] Force identity upstream and compress only at the remote-facing gateway.
- [ ] Use pipeline backpressure for a proxied client.
- [ ] Use gzip sync-flush for proxied SSE.
- [ ] Use threshold Brotli/gzip for eligible non-streaming proxy bodies.
- [ ] Do not double-encode already encoded upstream bodies.
- [ ] Keep browser-preview rewriting as a separate decoded path.

### Rollout

- [ ] Keep `off` as an immediate identity rollback.
- [ ] Ship initially in `body` mode.
- [ ] Test low-volume compressed SSE through the real iOS shell.
- [ ] Promote the default to `on` only if iOS does not buffer events.
- [ ] If WebKit buffers SSE, retain `body` rather than adding padding or
      weakening latency.

## Required tests

- [ ] Brotli/gzip negotiation and size threshold.
- [ ] Control listener always identity.
- [ ] `Vary` contains both `Origin` and `Accept-Encoding`.
- [ ] Initial compressed SSE comment and connected frame decode immediately.
- [ ] A real non-reading, incompressible stream is dropped at the hard limit.
- [ ] Soft limit marks terminal desync and recovers the retained tmux frame.
- [ ] Keepalive behavior matches identity.
- [ ] No compressor survives response close or forced drop.
- [ ] Proxy upstream sees identity.
- [ ] Proxied SSE delivers a decodable frame before upstream ends.
- [ ] Already encoded bodies are not double encoded.
- [ ] Browser-preview rewriting and limits remain correct.
- [ ] `off`, `body`, and `on` behave as documented.

## Manual verification

- [ ] Inspect `/invoke`, gateway SSE, bridge SSE, static, and preview headers
      from another tailnet device.
- [ ] Compare bytes and latency against the Milestone 0 baseline.
- [ ] Test a quiet event stream, a terminal flood, and a long agent turn.
- [ ] Test through raw tailnet HTTP and Tailscale Serve.
- [ ] Test iOS foreground, background, screen lock, and foreground recovery.
- [ ] Complete the inactive-environment path.

## Commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun test tests/unit/electron/gateway.test.ts --parallel
bun test tests/unit/docs/remote-gateway-docs.test.ts --parallel
bun run test
```

## Exit criteria

- [ ] Eligible remote bodies negotiate compression.
- [ ] The control listener stays identity.
- [ ] Compressed SSE preserves first-frame latency and all flow-control limits.
- [ ] Preview and proxy responses compress without double encoding.
- [ ] The identity rollback is tested.
- [ ] Real iOS evidence supports either `on` or a documented `body` default.
- [ ] Before/after bytes, CPU time, and event-loop lag are recorded.
- [ ] Focused tests, typechecks, and the full suite pass.

## Evidence and decisions

Record:

- encoding and threshold choices with measurements;
- body and event-stream transfer reduction;
- compression CPU time and event-loop lag;
- slow-reader memory behavior;
- real iOS SSE result and selected default;
- rollback verification;
- test command results.

No evidence recorded yet.
