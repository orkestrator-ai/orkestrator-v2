# Rich transcript review fixes

Status: Implementation and regression coverage complete; validation evidence below.

All 20 findings from the structured review were addressed. Historical publications
keep their immutable verified bytes. Static HTML now uses renderer identity
`html-static-preview:v2`, so an unpublished v1 receipt needs a new preview.

## Changes and coverage

| Finding | Result and regression coverage |
| --- | --- |
| Inline file-reference backtracking | Removed the overlapping host-label alternative. Pathological repeated labels and shell-command near-matches are bounded in the owning unit tests. |
| Gateway origins at startup | Inferred ancestors are checked individually; unsupported wildcard/underscore hosts are excluded with content-free warnings. Explicit CSP configuration stays strict. Runtime tests cover construction and later gateway-origin updates. |
| Protected-row overscan | Recover the viewport independently of Virtuoso's expanded render range. Protected rows use measured intersections at clipped edges; normal scrolling keeps its event-only path. The stand-in reports expanded ranges, with first/last-row tests and a real browser selection test at both viewport sizes. |
| Split worker UTF-8 | Stdout uses a streaming decoder. A real fake-worker child splits CJK output inside a code point; framing tests also cover malformed JSON and the output byte limit. |
| Shutdown and service lifetime | Shutdown marks active previews interrupted without charging repairs. Reopening preserves that result. Closed stores cannot reopen, and failed requests cannot restore idempotency records after conversation deletion. |
| Publication retries | Each settled read schedules the next bounded delay. Stable unresolved calls recover through empty/failed reads; unmount fences late cache writes without relying on an epoch reset. |
| Chart CSV formulas | Native chart downloads and published chart CSV representations use spreadsheet-safe text cells; typed numbers remain numbers. Tests cover all formula leaders, hostile SVG labels, and large axes. |
| Mermaid queue capacity | Capacity rejection retries with bounded backoff, fenced to source/scope and cancelled on disposal. A scheduler that refuses once then succeeds recovers automatically. |
| Desktop readiness | A separate readiness deadline tears down a frame that never announces ready and reports unresponsive. The focused desktop test verifies termination and cleanup. |
| Ambiguous OpenCode dispatch | Its artifact grant survives until reconciliation/turn settlement; rejected dispatch still revokes it. Dispatch tests distinguish both outcomes. |
| Quarantined preview slots | After the initial retry burst, one slow timer per slot continues positive exit verification. Recovery tests exhaust the burst before allowing reaping to succeed. Capacity is never released on an unreachable Docker daemon. |
| Static staged assets | Validate/copy assets and embed offline data URLs before preview. Expansion is checked before allocating beyond the 16 MiB prepared-document budget; authored source keeps its 256 KiB limit. PDF printing reads exactly the stored verified effective document. A real Chromium service test verifies red image pixels in both capture and PDF thumbnail after publication. |
| Media reset races | A reset generation rejects superseded reads before returning/caching bytes, including deferred detail writes. Cleanup removes only its own inflight request. Backend A cannot erase backend B's replacement request. |
| Live host revocation | The store registers global, environment and conversation reset handlers, independent of mounted rows. Active/pending targets and previews are cleared; late opens release their capabilities without attaching. |
| Capabilities recovery | A subscriber-owned shared timer retries initial failure with capped delays and generation fencing. The mounted-hook regression recovers without remount or external reset. |
| Markdown image changes | Source, container and transcript scope key the image lifecycle. Success, failure and pending-source replacements load the new image and ignore the old result. |
| Publication remount | First-painted standalone placement remains stable for the mounted conversation, even after a call-row overlay arrives. Only bounded identifiers are retained. A DOM-node regression and the live Codex test assert that the painted card stays connected. A later mount may use the now-known call anchor. |
| Nested publication calls | One depth-bounded visitor handles tool, agent and task groups for anchors, argument fallback and unresolved calls. Each grouping is tested through both placement paths. |
| Ledger read failure | Store-open errors propagate as `storage_unavailable`. Renderer tests preserve protected content on rejection and revoke only after a successful complete empty ledger. |
| Streaming code latency | Completed line nodes stay stable for selection; each line contains its layout. Open fences defer highlighting until closure. Existing selection/focus, exact find/copy, stale-reply and resource-release tests pass. The browser benchmark compares the final implementation with `67a6cc31` at 4× CPU throttle. |

Additional coverage exercises the real DOMPurify SVG policy in Chromium rather
than Happy DOM, SVG export sizing/object-URL cleanup, highlighter worker abort,
timeout, crash, consecutive-failure cutoff, reset and missing resume state, and
HTML string literals through preparation/script serialization. The injected
Claude artifact tools are tested through the real can-use-tool callback under
a deny-approvals policy.

## Validation

- Static checks: `mise run check`, through `test:logged`, passed.
- Focused regression owners passed, including real preview/PDF pixel checks.
- Full component/public browser suite passed. The final streaming/overscan and
  SVG-policy browser owners passed again (18 cases, desktop and narrow).
- Isolated browser suite passed: 29 passed, 37 explicitly opt-in cases skipped.
  Its disposable profile was stopped and reset automatically.
- Credentialed live Codex rich-transcript owner passed: 1 passed, no skips.
  It covers repair/publication, live execution, reload, find reveal and 390px
  layout, including the new card attachment assertion. Profile
  `review-rich-fixes` was stopped and reset.
- Electron aggregate: 19 passed, 1 skipped, 3 startup-title failures. Both owning
  files passed unchanged alone: artifact host (5.9 s) and Electron main (24.3 s).
  Recorded in [0470](../tests/flaky-tests/electron-and-desktop/0470-electron-launch-title-timeout-under-load.md).
- A full-suite run reproduced the existing same-millisecond agent-mail ordering
  failure; the unchanged owner passed alone. Recorded in
  [0504](../tests/flaky-tests/coordinator-and-multi-review/0504-agent-mail-conversation-same-millisecond-order.md).

Final aggregate (`review-all-complete`, 486.6 s): 8,483 web tests passed
(10 skips); backend had 9,531 passes, 41 skips, and only the unchanged agent-mail
ordering failure above. All other package tasks, root/agent-support tests,
bridges and protocol lockfile verification passed. The mail owner passed again
alone. Compressed evidence: `orkestrator-test-run.c7h361/review-all-complete.log.gz`
under the host temporary directory.

Docker fixture validation (`review-docker-fixtures`, 187.9 s): 2 passed,
1 opt-in case skipped, 4 failed. Foreign-owner rejection and Chromium launch
for both container users passed. The deletion case was blocked by Git rejecting
`/orkestrator-agent-test-origin.git` as dubiously owned. The initial signed-out,
all-platform profile also displayed a Claude sign-in modal in settings/rebuild
cases. A fresh Codex-only profile reproduced the fixture Git-ownership failure
before browser tests could start. No production Git trust setting was changed.
Evidence: `orkestrator-test-run.O4mKFg/review-docker-fixtures.log.gz` under the host
temporary directory and `output/agent-testing/review-rich-docker/browser/`.
The failed profile was reset, removing its exact-owner container, volumes and
network. The focused quarantine/recovery and preview worker tests passed.

## Throttled performance gate

`review-final-perf` passed in 703.7 seconds. Three interleaved, order-alternated
runs per checkout, with 20 expansion/history/remount cycles each, compared this
implementation with `67a6cc31` using Chrome 155.0.8059.85 and 4× CDP CPU throttle.

| Metric | Baseline | Change | Difference |
| --- | ---: | ---: | ---: |
| Composer median | 12.70 ms | 13.00 ms | +2.4% |
| Composer p95 | 20.20 ms | 19.91 ms | −1.4% |
| Scroll frame median | 16.70 ms | 16.70 ms | 0% |
| Scroll frame p95 | 16.80 ms | 16.80 ms | 0% |

All timing gates are within 10%. Every run converged within cache, queue, worker
and view-state limits; no unexpected backend commands occurred. Report:
`output/benchmarks/rich-transcripts/2026-10-20T14-43-04-959Z.json`.
The disposable baseline checkout was removed after the benchmark. All test
profiles created for this review were stopped and reset. No iOS or standalone CLI scenario suite was selected: those flows
were not changed; ordinary CLI/package tests are in the aggregate suite.

## Follow-up: validation failures fixed

The three failures left in the validation above were fixed afterwards.

| Failure | Fix and evidence |
| --- | --- |
| Agent-mail same-millisecond order ([0504](../tests/flaky-tests/coordinator-and-multi-review/0504-agent-mail-conversation-same-millisecond-order.md)) | Message ids carry a per-process sequence after a monotonic millisecond prefix, so ties sort in send order. A frozen-clock regression fails on the old id and passes now; the five agent-mail owners pass (109 tests). Resolved. |
| Electron startup title ([0470](../tests/flaky-tests/electron-and-desktop/0470-electron-launch-title-timeout-under-load.md)) | The first title after launch waits for Vite to serve the renderer entry. The three failing owners used the 5-second default; they now use the 60 seconds the service-preview and annotation specs already gave this wait. `test:agent:electron` passed (117.1 s), at low host load only. Resolved; reopen on a loaded recurrence. |
| Docker fixture Git ownership | Git reads `safe.directory` only from global or system config, so `GIT_CONFIG_*` environment cannot fix it. The backend now sets `ORKESTRATOR_AGENT_TEST_GIT_REMOTE` only when it mounts the agent-test origin, and `workspace-setup.sh` then trusts only the fixed `/orkestrator-agent-test-origin.git` path. Production containers get no trust entry. In the real image, a root-owned mount cloned by `node` fails without the trust and clones with it. Unit coverage is in `commands-process-coverage.test.ts` and `workspace-setup-preserve.test.ts`. |

Docker fixture rerun: `rtfix-docker` profile started with the documented
`--fixture --fixture-environments local,container` command (the all-platform
default), image rebuilt with `docker:build:dev`. `test:agent:docker`: 6 passed,
1 opt-in case skipped (live Claude approval), 0 failed. That includes the
deletion case and the settings and rebuild cases where the earlier run hit the
Claude sign-in modal; the modal did not recur. The profile was stopped and reset.
`mise run check` passed.
