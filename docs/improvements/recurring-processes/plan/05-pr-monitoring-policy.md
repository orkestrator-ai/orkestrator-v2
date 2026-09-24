# 05 — Make PR monitoring lifecycle-aware and bounded

Status: Not started. Dependencies: 01, 02. Findings: F03, F04.

## Outcome

Keep fast confirmation after create/merge and ordinary open-PR freshness while
making retained terminal environments inexpensive. Spread startup work and limit
aggregate requests without losing task reconciliation or replacement discovery.

## Sources

`apps/backend/src/core/pr-monitor.ts`, `commands-pr-monitor.ts`,
`commands-registry-pr.ts`, `commands-servers.ts`,
`packages/protocol/src/pr-monitor.ts`, renderer monitor store/subscriber, and
`tests/unit/backend/pr-monitor-service.test.ts`. Existing terminal/replacement
and persistence-failure tests are essential behavior, not obsolete polling tests.

## Policy to implement

Keep user intent mode distinct from lifecycle observation policy. Model at least
open tracking, create pending, merge pending, terminal repair, terminal discovery,
paused and provisional one-shot discovery. This need not become a new public
enum for every internal state; expose only fields useful for freshness/UI.

Preserve open 20 s / create 5 s / merge 1 s initially. After terminal persistence
and required side effects settle, trial branch discovery every five minutes.
Immediate explicit refresh, a new pending intent, and agent-completion edges
reset the due time. A closed PR may reopen and a branch may acquire a new PR;
retained terminal entries still need a discovery mechanism.

## Implementation tasks

1. Enumerate every terminal obligation: environment persistence, linked task
   status/link/comment/metadata, merge-cleanup recovery and transition display.
   Identify which are already durable/idempotent and which are runtime-only.
   Before stopping fast repair, make remaining obligations reconstructible from
   storage; do not persist a boolean that claims all effects completed prematurely.
2. Separate failed detection from failed local side-effect repair. Where safe,
   retry a previously confirmed observation's idempotent local effects without
   another gh call. Revalidate identity/generation and reread durable state first
   so a newer PR or reopened state cannot receive an old terminal side effect.
3. Add a terminal discovery interval to internal scheduling policy, preserving
   public pending timeout behavior. Initial restoration should stagger ordinary
   and terminal checks. Explicit merge/create feedback must not inherit several
   minutes of background jitter.
4. Use bounded admission for detections, starting with two concurrent operations.
   Queue by environment with one pending check, fair ordering, and priority for
   user intent over quiet discovery. Cap starvation: a continuous stream of fast
   checks must not permanently hide another environment's PR state.
5. Define timeout/backoff and rate-limit handling at the existing gh boundary.
   Keep the current per-entry exponential backoff, add bounded jitter, and honor
   reliable retry timing when available. Share cooldown only across a proven
   compatible host/auth scope; absence of an observable credential identity is a
   reason to avoid unsafe deduplication, not to hash/log tokens.
6. Preserve separate check-rollup requests and their independent 60-second
   budget. A check permission failure must not suppress merge/close detection.
   Trial settled-check backoff later only if running/new checks can be detected
   promptly after a new head or explicit refresh.
7. Avoid switching to repository-wide API batching or webhooks in this step.
   Existing known-PR lookup and branch discovery already have distinct semantics.
   If baseline traffic warrants batching, design authentication, pagination,
   partial failure and replacement selection separately using current docs.
8. Fence late results after branch rename, environment stop/delete, target change,
   or concurrent explicit terminal reconciliation. Keep `lastSuccessfulCheckAt`
   distinct from an attempted/failed check if freshness is added to the wire.
9. Bound runtime reconciliation/notified-transition maps and preserve deduplication
   across retries. Coordinate subscriber recovery changes with step 11; state
   changes and optional toast delivery must not be conflated.

## Required tests

Retain tests for known-PR identity, branch discovery, replacement PRs, reopen,
not-found after terminal state, paused target, persistence failure, partial
comments/metadata failure, pending timeout, and old-target response fencing.

Add deterministic tests for terminal cadence; unfinished repair staying due;
repair after restart; new open PR discovered on a terminal branch; explicit wake
bypassing quiet delay; aggregate concurrency bound; fairness under merge bursts;
startup jitter; rate-limit cooldown; failed check rollup with successful state;
and simultaneous merge cleanup/environment deletion. Verify task comments are
not duplicated when timers, explicit commands and recovery converge.

## Acceptance and rollback

Quiet terminal environments perform about one discovery attempt per configured
period, not three per minute, after repair. Open/pending latency remains within
the baseline budget under the supported environment count. Adding clients does
not add monitoring loops. Rollback changes policy back to normal cadence while
retaining durable repair semantics and aggregate bounds; never restore two
monitor owners.
