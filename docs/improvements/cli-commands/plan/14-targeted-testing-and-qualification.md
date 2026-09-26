# 14 — Build targeted scenarios and qualify the real stack

Status: Verified — local, container, live-provider and browser qualification
recorded below; Pi, Cursor and Grok remain unqualified and are not advertised
as completion-capable.
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

- [x] Milestone B has a credential-free packaged local-worktree scenario.
- [x] Milestone C covers submission, completion, recovery, controls, and transcripts.
- [x] Real UI switch-away/reload and pending-interaction paths are qualified
  (Claude; other providers' question cards not browser-checked).
- [x] Live provider/container results are recorded separately with limitations.
- [x] Cleanup and bounded evidence survive scenario failures and interruption.
- [x] Exact runnable tasks and suite scope are documented when implemented.

Keep an evidence table in this step with revision, scenario, command, result,
artifact, and limitation as qualification occurs.

## Implementation record

- Harness: [`packages/cli/scenarios/harness.ts`](../../../../packages/cli/scenarios/harness.ts)
  starts each scenario's backend through the packaged launcher
  (`serve --runtime-flavor agent-test`, disposable data/worktree roots, control
  MCP disabled), drives the packaged client with argv only, records IDs and
  exit codes in a private manifest, and runs owned cleanup in `finally`.
  Fixture origins sit at `<root>/fixtures/origin.git`, the remote the
  agent-test runtime mounts into containers.
- Cases: [`packages/cli/scenarios/cases.ts`](../../../../packages/cli/scenarios/cases.ts);
  runner: [`packages/cli/scripts/run-scenarios.ts`](../../../../packages/cli/scripts/run-scenarios.ts);
  task: `mise run test:cli:scenarios` (`--scenario`, `--provider`,
  `--environment-type container --docker-image TAG`, `--keep-on-failure`).
  Container runs refuse the shared `latest` tag.
- Browser: [`e2e/agent-testing/cli-ui.spec.ts`](../../../../e2e/agent-testing/cli-ui.spec.ts)
  in `mise run test:agent:browser:isolated`.
- Domain edge cases stay beside their owners: `apps/backend/src/core/public-api/*.test.ts`,
  `packages/protocol/src/public-api.test.ts`, `packages/cli/tests/client-*.test.ts`.

Scenario-matrix coverage, by layer:

| Scenario | Where it is proved |
| --- | --- |
| Read-only client | `read-only` scenario; `cli-client.test.ts` (no backend initialised for help/version/errors) |
| Local lifecycle | `local-lifecycle` scenario (base commit, worktree path, rename, fork, stop, delete, no worktrees left) |
| Settings concurrency | `public-api-projects.test.ts` (stale revision, unrelated fields preserved, launch intent kept) + `local-lifecycle` stale revision; browser check of CLI-set value in `cli-ui.spec.ts` |
| Retry and retention | `retry-and-retention` scenario; `public-api-projects.test.ts`/`public-api-recovery.test.ts` (one execution, conflict, deleted-resource replay, retired namespace, corrupt store) |
| Setup failure | `setup-failure` scenario; `public-api-launch.test.ts` (setup then exactly one initial prompt) |
| Lost prompt acknowledgement | `public-api-sessions.test.ts` (unknown dispatch parks, blocks other prompts, retries under the same key; discard stays unknown) |
| Client exit | `client-exit` scenario (CLI killed mid-start; a second environment runs; the first settles) |
| Fast/multiple turns | `public-api-sessions.test.ts` (own-request evidence only, independent sessions, consecutive runs) |
| Backend/bridge restart | `public-api-recovery.test.ts`, `public-api-exec.test.ts` (dead-generation start interrupted, create settled from state, exec worker reconciled not re-run) |
| Pending interaction | `public-api-sessions.test.ts` with a controlled provider (exact answer; stale/malformed never approves; answered question stops reporting input); live Claude in `cli-ui.spec.ts` (question rehydrates in an inactive, reloaded renderer; UI answer completes the CLI run; replayed answer refused) |
| Control race | `public-api-sessions.test.ts` (stop refuses idle/mismatched run; steering refused where unsupported) |
| Actual inactive UI | `cli-ui.spec.ts`: CLI changes reach an open and a reloaded renderer; live Claude turn works and asks while another environment is shown, then the page reloads and the answer is given in the UI |
| Wrong profile/owner | `wrong-profile` scenario; `client-connections.test.ts` (stale descriptor, no fallback). Foreign Docker decoy: existing `browser-gateway.spec.ts` Docker fixture, not re-run here |
| Transcript recovery | `public-api-launch.test.ts` (ordered bounded pages, older cursor); sessions test (routine reads never read transcripts) |
| Optional following | `client-waits.test.ts` (JSONL once per message, gaps flagged); following is snapshot polling, no SSE |
| Optional exec | `exec` scenario (local + container: exit passthrough, argv, cancel, delete-during-run drains) + `public-api-exec.test.ts` |

## Evidence

Revision: working tree on `a9337716` (uncommitted), 2026-09-26, Linux,
Bun 1.4.2 (mise), Docker 29.7.2, container image
`orkestrator-v2:dev-7e8f587df147` built by `mise run docker:build:dev`.
Artifacts are `output/cli-scenarios/<run>/manifest.json` (git-ignored; IDs,
stages, exit codes, no prompts or tokens).

| Scenario | Command | Result | Artifact | Limitation |
| --- | --- | --- | --- | --- |
| Credential-free matrix, local (7) | `mise run test:logged -- --name cli-scenarios -- mise run test:cli:scenarios` | PASS, 0 cleanup errors (final code) | `2026-09-26T14-38-39-590Z-299ecfcc` (also `…14-03-11-458Z-1ea21aef`) | — |
| Credential-free matrix, container (5) | `mise run test:cli:scenarios -- --environment-type container --docker-image orkestrator-v2:dev-7e8f587df147` | PASS, 0 cleanup errors, no containers left (final code) | `2026-09-26T14-39-05-029Z-17390c21` (also `…13-40-53-081Z-355f2b23`) | First attempt failed: fixture origin was not the mounted agent-test remote (`…13-39-28-673Z-d7396392`); fixed in the harness |
| Live Claude, local | `mise run test:cli:scenarios -- --provider claude --scenario live-session` | PASS 31.4s | `2026-09-26T14-08-37-063Z-f635e345` | — |
| Live Codex, local | `ORKESTRATOR_SCENARIO_MODEL=gpt-5.6-sol … --provider codex --scenario live-session` | PASS 45.1s | `2026-09-26T14-09-08-591Z-6661b728` | Default model is unsupported on this account; model pinned |
| Live OpenCode, local | `ORKESTRATOR_SCENARIO_MODEL=opencode-go/kimi-k2.6 … --provider opencode --scenario live-session` | PASS 44.3s, 44.2s, 40.0s (final code) | `2026-09-26T14-06-12-737Z-49f501dd`, `…14-06-57-214Z-0f68b051`, `…14-39-25-070Z-e30022d9` | Earlier run `…14-03-41-753Z-243947fe` reported success before the turn ran; fixed (see below) |
| Live Claude, container | `… --environment-type container --docker-image … --provider claude --scenario live-session` | PASS 90.2s | `2026-09-26T13-41-25-666Z-031cda41` | Restricted network (default allowlist) |
| Live Codex, container | `CODEX_HOME=$HOME/.codex … --environment-type container … --provider codex` | PASS 35.5s | `2026-09-26T14-02-29-974Z-d911f76f` | Needs `--network full` and the explicit `CODEX_HOME` credential opt-in; without them the run stayed running to its deadline / failed 401, both reported truthfully |
| Live OpenCode, container | `… --environment-type container … --provider opencode` | PASS 51.1s | `2026-09-26T14-07-41-569Z-6dd6fd84` | Needs `--network full`; under the restricted allowlist the turn failed and was (before the fix) reported as success |
| Isolated browser suite incl. CLI → UI | `mise run test:agent:browser:isolated` | PASS: 7 passed, 5 skipped (Docker/live gated), twice on the final code | `output/agent-testing/qa-browser-d9b84c3a-4ea/`, `…qa-browser-c33df0f0-4a0/` | Two existing `browser-gateway` tests are intermittent on this host with or without these changes (an on-disk checkout of `a9337716` failed them in 2 of 3 runs): the first page load can hit a restarting Vite (502 on `/@vite/client`), and the review-validation queue test raced the worker (fixed below). `cli-ui.spec.ts` passed in every run once written correctly |
| Live question through the UI | `mise run dev:test --profile qa-cli-live --fixture --credential-source claude --agent-platforms claude`, then `ORKESTRATOR_AGENT_TEST_PROFILE=qa-cli-live ORKESTRATOR_AGENT_TEST_LIVE_CLI=1 mise run test:agent:browser -- e2e/agent-testing/cli-ui.spec.ts` | PASS: 2 passed (question test 21.5s) | `output/agent-testing/qa-cli-live/browser/results.json` | Claude only; profile stopped and reset afterwards |
| Pi, Cursor, Grok live | not run | — | — | The published package lacks their bridges; completion stays `unsupported` |

Defects found by qualification and fixed:

- OpenCode's lifecycle reads idle after a failed turn and, just after a prompt
  is accepted, before any answer exists. Both were settled as `completed`.
  `turnTerminalError` (OpenCode) now reads the request's last assistant
  message: an error or abort fails the run; no finished answer keeps it
  pending. Tests: `opencode-provider-dispatch.test.ts`,
  `native-agent-service-turn-outcome.test.ts`. This also corrects web
  annotation dispatch outcomes, which read the same records.
- After a question was answered (in the UI or CLI), `run wait` could still
  exit 6 for up to ten seconds: the pending-interaction read was cached and
  `answering` counted as needing input. Resolution now clears the cache and
  only `pending` interactions count; a fresh empty read reports the run as
  running. Test: `public-api-sessions.test.ts` (fails without the fix).
- Found while qualifying (not a CLI defect): the review-validation worker
  persisted `queued` before its first scheduler poll, so a status read could
  see a queue with no reason for up to one heartbeat (500 ms). It now
  publishes the queued state together with its reason
  (`review-validation-worker.ts`).
- The scenario fixture origin now uses the agent-test container mount.
