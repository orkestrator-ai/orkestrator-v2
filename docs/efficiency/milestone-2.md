# Milestone 2 — Dynamic body, event-stream, and proxy compression

Status: Implementation complete; real-device rollout evidence pending

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

- [x] Implement `negotiateEncoding`.
- [x] Implement `appendVary`.
- [x] Implement `isCompressibleContentType`.
- [x] Implement asynchronous `compressBody`.
- [x] Add a measured threshold, initially 1 KiB.
- [x] Exclude WOFF2, compressed images, and unknown octet streams.
- [x] Make header and validator behavior consistent across identity, gzip, and
      Brotli.

### Dynamic JSON and preview bodies

- [x] Prefer asynchronous Brotli quality 4, then gzip level 6.
- [x] Keep small responses identity.
- [x] Preserve `Cache-Control: no-store` for private state.
- [x] Recompress bounded HTML, CSS, and JavaScript after preview rewriting.
- [x] Keep `Accept-Encoding: identity` toward rewriteable preview targets.
- [x] Enforce encoded and decoded byte limits.
- [x] Avoid synchronous compression of large invoke responses.

### Identity event writer

- [x] Introduce `EventClientWriter` with `writableLength` defined as
      uncompressed bytes still owed.
- [x] Move existing event-client bookkeeping to the interface without changing
      behavior.
- [x] Keep soft-limit terminal desync notices unchanged.
- [x] Keep hard-limit disconnect behavior unchanged.
- [x] Confirm all existing identity-path tests pass before adding gzip.

### Compressed event writer

- [x] Implement gzip SSE with `Z_SYNC_FLUSH` configured on the stream.
- [x] Track pre-compression backlog in compressor write callbacks.
- [x] Do not use only `ServerResponse.writableLength` for safety limits.
- [x] Explicitly destroy the compressor on response close and forced drop.
- [x] Add a priming comment so the connected frame is immediately decodable.
- [x] Route drain and keepalive checks through the writer's true backlog.
- [x] Keep `Cache-Control: no-store, no-transform`.
- [x] Do not coalesce application frames for compression ratio.

### Proxied streams and bodies

- [x] Force identity upstream and compress only at the remote-facing gateway.
- [x] Use pipeline backpressure for a proxied client.
- [x] Use gzip sync-flush for proxied SSE.
- [x] Use threshold Brotli/gzip for eligible non-streaming proxy bodies.
- [x] Reserve one of eight proxy-buffer slots and declared source bytes against
      a shared 64 MiB budget before buffering; stream identity on saturation
      and hold each reservation until downstream finish/close or another
      success, failure, abort, or disconnect terminal path.
- [x] Leave `HEAD`, bodyless status, `206 Partial Content`, and
      `Content-Range` responses untransformed.
- [x] Remove stale `ETag`, `Content-MD5`, `Content-Digest`, `Repr-Digest`,
      legacy `Digest`, and `Accept-Ranges` fields whenever rewriting or
      compression changes representation bytes.
- [x] Do not double-encode already encoded upstream bodies.
- [x] Keep browser-preview rewriting as a separate decoded path.

### Rollout

- [x] Keep `off` as an immediate identity rollback.
- [x] Ship initially in `body` mode.
- [ ] Test low-volume compressed SSE through the real iOS shell.
- [ ] Promote the default to `on` only if iOS does not buffer events.
- [ ] If WebKit buffers SSE, retain `body` rather than adding padding or
      weakening latency.

## Required tests

- [x] Brotli/gzip negotiation and size threshold.
- [x] Control listener always identity.
- [x] `Vary` contains both `Origin` and `Accept-Encoding`.
- [x] Initial compressed SSE comment and connected frame decode immediately.
- [x] A real non-reading, incompressible stream is dropped at the hard limit.
- [x] Soft limit marks terminal desync and recovers the retained tmux frame.
- [x] Keepalive behavior matches identity.
- [x] No compressor survives response close or forced drop.
- [x] Proxy upstream sees identity.
- [x] Proxied SSE delivers a decodable frame before upstream ends.
- [x] Already encoded bodies are not double encoded.
- [x] Browser-preview rewriting and limits remain correct.
- [x] `off`, `body`, and `on` behave as documented.
- [x] Concurrent near-limit proxy responses remain within the eight-buffer and
      64 MiB source-byte budgets; excess responses stream identity and
      reservations return to zero after every terminal path.
- [x] Proxy `HEAD`, `1xx`, `204`, `304`, `206`, and `Content-Range` responses
      preserve bodyless/range semantics without gateway compression.
- [x] Rewritten or compressed responses do not retain upstream validators,
      content digests, or range support for different representation bytes.
- [x] Exact threshold and maximum-size boundaries, non-beneficial output,
      codec failure, and admission fallback are covered.
- [x] Dynamic response rejection, compressor error, proxy abort, `no-transform`,
      malformed length, and preview chunk/post-rewrite limits are covered.

## Manual verification

- [ ] Inspect `/invoke`, gateway SSE, bridge SSE, static, and preview headers
      from another tailnet device.
- [ ] Compare bytes and latency against the Milestone 0 baseline.
- [ ] Test a quiet event stream, a terminal flood, and a long agent turn.
- [ ] Test through raw tailnet HTTP and Tailscale Serve.
- [ ] Test iOS foreground, background, screen lock, and foreground recovery.
- [ ] Complete the inactive-environment path.

Automated tests and simulator runs do not complete these manual items. Each box
remains unchecked until results are captured from the named tailnet transport or
physical-device workflow.

## Commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun test tests/unit/electron/gateway.test.ts --parallel
bun test tests/unit/docs/remote-gateway-docs.test.ts --parallel
bun run test
```

## Exit criteria

- [x] Eligible remote bodies negotiate compression.
- [x] The control listener stays identity.
- [x] Compressed SSE preserves first-frame latency and all flow-control limits.
- [x] Preview and proxy responses compress without double encoding.
- [x] The identity rollback is tested.
- [ ] Real iOS evidence supports either `on` or a documented `body` default.
- [x] Before/after bytes, CPU time, and event-loop lag are recorded.
- [x] Focused tests, typechecks, and the full suite pass.

## Evidence and decisions

Record:

- encoding and threshold choices with measurements;
- body and event-stream transfer reduction;
- compression CPU time and event-loop lag;
- slow-reader memory behavior;
- real iOS SSE result and selected default;
- rollback verification;
- test command results.

Implementation evidence recorded on 2026-07-30:

- Selected a 1 KiB body threshold, asynchronous Brotli quality 4, asynchronous
  gzip level 6, an eight-job dynamic-compression admission limit, and bounded
  source/output/chunk buffers. Saturation and codec failures fall back to
  identity.
- A synthetic, non-secret JSON size sample measured 1,185 identity bytes,
  102 Brotli bytes, and 153 gzip bytes. A 4,765-byte sample measured 213 Brotli
  bytes and 374 gzip bytes. These local samples justify avoiding codec work
  below the 1 KiB threshold; they are not production traffic measurements.
- A synthetic 100-frame sync-flushed SSE sample measured 9,780 uncompressed
  bytes and 1,579 gzip bytes (83.9% reduction).
- Local asynchronous codec samples took 0.098–2.054 ms for 593–78,773-byte
  generated JSON bodies. A deliberately saturated sample of 256 parallel
  1,179,648-byte jobs completed in 12.683 ms and observed 17.056 ms maximum
  timer lag. This is a stress indicator, not a device or tailnet benchmark.
- Automated slow-reader coverage uses a real paused HTTP response and
  incompressible random payloads; the writer is dropped at the existing hard
  uncompressed-backlog limit and its compressor is destroyed.
- Rollback is covered for `off`; `body` is the shipped default. `on` is
  implemented and tested but is not the default pending real iPhone and iPad
  `WKWebView` evidence.
- Proxy body admission reserves one of eight buffer slots and the declared
  source size against a 64 MiB aggregate budget before collection. Saturated
  responses stream identity, and automated success/error/abort/disconnect tests
  verify that reservations are returned.
- Automated validation covers bodyless and ranged proxy semantics, transformed
  metadata removal, exact compression boundaries, fallbacks, error paths, and
  preview limits. These results are implementation evidence only and do not
  replace the unchecked tailnet and physical-device manual evidence above.
- Validation passed: backend and web typechecks, focused gateway and
  remote-gateway documentation tests, all four repository test groups, the
  Codex protocol lockfile check, and the iOS simulator suite. The full test
  command completed successfully.

Still required before promoting `on`: real-device low-volume SSE latency,
foreground/background/screen-lock recovery, raw tailnet and Tailscale Serve
header/transfer measurements, and the inactive-environment manual path.
