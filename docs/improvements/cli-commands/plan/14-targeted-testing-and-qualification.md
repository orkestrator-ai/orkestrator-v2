# 14 — Build targeted scenarios and qualify the real stack

Status: Planned; build the harness incrementally with the owning steps.
Depends on: Steps 06–12 for complete core qualification; step 13 for exec cases.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

A developer can select a precise CLI scenario, isolated backend/profile, and
optional provider/environment type. The runner prepares known state, drives the
public CLI, asserts authoritative results, collects bounded failure evidence,
and cleans up its own resources. Browser/live-provider tests remain separate
claims from deterministic command tests.

## Owners and starting points

- [Testing guide](../../../development/testing-guide.md) and
  [agent-testing guide](../../../development/agent-testing.md).
- [Profile lifecycle](../../../../apps/desktop/scripts/dev/lifecycle.ts),
  [fixture seeder](../../../../apps/desktop/scripts/dev/fixture.ts), and
  [isolated browser runner](../../../../apps/desktop/scripts/dev/isolated-browser.ts).
- [CLI tests](../../../../packages/cli/tests/cli.test.ts).
- [Provider test support](../../../../apps/backend/src/core/agent-provider-test-support.ts).
- [Browser gateway scenarios](../../../../e2e/agent-testing/browser-gateway.spec.ts)
  and [artifact sanitizer](../../../../e2e/agent-testing/artifact-sanitizer.ts).

## Harness work

1. Reuse profile resolution, disposable data/worktree roots, fixture repository
   plus local bare origin, readiness, ownership labels, and cleanup. A pure
   backend CLI suite should not start Electron/Vite merely to acquire a gateway;
   reuse/extract the existing lifecycle primitives without building a second
   profile manager. Browser qualification still starts the real UI stack.
2. Create a thin scenario driver around the packaged CLI: argv input, bounded
   stdin, parsed JSON, expected exit, and deadline. Capture receipts/created IDs
   immediately in a private run manifest. Do not use shell interpolation or
   duplicate backend business rules inside the driver.
3. Support explicit scenario, provider, and environment-type selection in the
   repository task runner. Add named mise tasks when implemented and document
   exact commands in the testing guide. Credential-free cases run by default
   in the selected CLI suite; live agents and Docker remain opt-in.
4. Reuse existing provider doubles/bridge fixtures to control ack, progress,
   question, rejection, interruption, and finish. Use barriers/deferred promises
   for races. A fake backend used only to test parsing cannot count as proving
   gateway/backend/provider integration.
5. Collect bounded metadata: selected connection/profile, action/run IDs,
   revisions, timings, child exit status, scenario stage, and safe failure code.
   Keep explicit transcripts/output in private, sanitized failure artifacts
   under existing count/byte/retention limits. Never print bearer tokens or
   provider recordings containing unsanitized content.
6. Always run `finally` cleanup for resources recorded by the scenario. Confirm
   owned workers/bridges/containers/worktrees are stopped/removed before deleting
   their data directories. Preserve primary and cleanup errors separately.
   Avoid broad process kills or deleting all environments by name prefix.
7. Integrate capacity admission and watchdogs through the existing repository
   runner. Record queue wait separately from execution. Cleanup must still run
   after timeout/signal; no double admission for cooperative nested test commands.

## Required scenario matrix

| Scenario | Layer and explicit assertion |
| --- | --- |
| Read-only client | Packaged CLI → real gateway; correct instance identity, no extra service/renderer, pure JSON |
| Local lifecycle | Real Git fixture; register/create/start/ready/edit/stop/delete; expected base/path and no residual owned resources |
| Settings concurrency | CLI plus independent UI/backend writer; conflict, preserved unrelated fields, inheritance/application timing |
| Retry and retention | Controlled external boundary plus real storage; one submission, same-key/different-payload conflict, deleted-resource replay, expired namespace refusal |
| Setup failure | Real backend fixture; failed readiness, recoverable created environment, zero initial-prompt submissions |
| Lost prompt acknowledgement | Real dispatch path with controlled provider; unknown → reconciliation, exactly one provider submission, parked-session blocking |
| Client exit | Launch, terminate CLI, run a second environment, reconnect; first request progresses and retains its terminal result |
| Fast/multiple turns | Completion before ack, independent sessions, consecutive requests; waiting matches only the selected run |
| Backend/bridge restart | Restart without graceful flush; outcome is reconciled or explicit interrupted/unknown, never automatic redispatch |
| Pending interaction | Unmounted UI, rehydrate, exact answer; conflicting/stale/dead-generation answers cannot approve or target a replacement |
| Control race | Stop before provider handle, late ack, new turn starts; expected-target checks and unaffected sibling session |
| Actual inactive UI | Open A, switch to B while A works/asks a question, return and reload; correct transcript/status/prompt/controls |
| Wrong profile/owner | Stale explicit profile and foreign Docker decoy; no fallback or mutation outside the selected fixture |
| Transcript recovery | Bounded pages, expired cursor, explicit unavailable state; no full transcript reads for routine waits |
| Optional following | Replay race, gap/reset, slow consumer, auth expiry; authoritative snapshot recovery and bounded buffers |
| Optional exec | Real child exit/signal/output limits, disconnect/restart/cancel; no orphaned process tree |

## Live qualification

For each advertised provider, run a small bounded scenario through the actual
CLI/backend/bridge path using explicit provider/model settings and credentials
available to the isolated profile. Use a fresh fixture/environment, a fixed
base, and a deterministic file/test assertion after the turn. Record completion,
follow-up, supported control behavior, and missing capabilities independently.
Model wording is not the assertion.

Run local and container qualification separately. Do not claim Docker/live
coverage from a scripted adapter, or UI rehydration from API polling alone.
If required tooling is unavailable, leave the capability/evidence gate pending
and state what remains unqualified. No automatic production fallback.

## Measurement and suite placement

Keep domain edge cases beside their backend/protocol owners; use a small number
of packaged scenarios to prove the complete path. Do not duplicate every unit
assertion through a slow subprocess or migrate all browser tests to CLI setup.
Retain direct tests of project/environment dialogs and browser authentication.

Measure scenario startup, time to useful failure evidence, total duration,
cleanup failures, flakes, and live-token cost on a recorded revision/profile.
Compare equivalent scenarios and cold/warm conditions before claiming speedup.
The default test suite already excludes separate browser/agent suites; this
work does not automatically shorten `mise run test`.

## Acceptance and handoff

- [ ] Milestone B has a credential-free packaged local-worktree scenario.
- [ ] Milestone C covers submission, completion, recovery, controls, and transcripts.
- [ ] Real UI switch-away/reload and pending-interaction paths are qualified.
- [ ] Live provider/container results are recorded separately with limitations.
- [ ] Cleanup and bounded evidence survive scenario failures and interruption.
- [ ] Exact runnable tasks and suite scope are documented when implemented.

Keep an evidence table in this step with revision, scenario, command, result,
artifact, and limitation as qualification occurs. There are no execution
results yet; this planning task must not populate passing rows.
