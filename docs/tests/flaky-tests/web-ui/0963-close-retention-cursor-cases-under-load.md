# Cursor close-retention cases fail under browser-suite load

- **ID:** 0963
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Owning file:** `e2e/CloseRetention.spec.ts`.
- **Change under test:** todo 0035 on branch
  `todo-0035-mobile-layout-gaps-49509c5f9933` (head `87a6751fd`). It touches
  the ActionBar, the projects drawer, fullscreen settings and their specs,
  not Cursor transcripts, steering or close retention.
- **Aggregate failure:** `mise run test:logged -- --name browser -- mise run test:browser`
  (754 passed, 102 skipped, 4 failed in 11.6 minutes, host load average about
  40 on 18 cores). In `desktop-chromium`, `steering a Cursor turn whose steer
  history is full is refused, the turn carries on and the draft survives`
  (line 693) failed at line 719: `expect(filled.error).toBeUndefined()`
  received `"The Cursor session has no running turn to steer"`. The other
  failures were [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md)
  and the known native branch picker in `e2e/AgentLaunchDialog.spec.ts`
  ([0825](../aggregate-validation-runs/0825-dependency-upgrades-0032-validation.md)).
- **Owning-file rerun:** `mise run test:logged -- --name browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/owners-0035`
  passed the steering case in both projects, but failed a different case:
  21 passed, 1 failed (2.8 minutes). The failure was `a Cursor transcript shed
  from persistence comes back truncated after a bridge restart, on the same
  conversation` (line 801, `desktop-chromium`) at line 823:
  `expect(page.getByText("Answer to: <first turn>")).toHaveCount(0)` received 1.
- **Targeted rerun:** `mise run test:logged -- --name close-retention-801 -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts:801 --workers=1 --repeat-each=3 --output output/playwright/owners-0035b`
  passed six of six (both projects, 26.1 s).
- **Evidence:** the browser log in `orkestrator-test-run.sKTHlZ/` and the
  owner log in `orkestrator-test-run.9Cr6B8/`, below the host temporary
  directory. Traces are under
  `output/playwright/test-results/CloseRetention-steering-a--97b0b-*` and
  `output/playwright/owners-0035/CloseRetention-a-Cursor-tr-50c8e-*`.
- **Hypothesis:** both cases race the fixture's Cursor turn lifecycle. The
  steer arrives after the turn has ended, and the truncated transcript is
  read before the shed is applied. Load seems to widen both races. Not
  confirmed. No assertion, timeout or skip changed.

## Recurrence during search review fixes, 2026-10-27

Desktop steering again failed at line 719 with `The Cursor session has no
running turn to steer`, both in the nine-worker component run and in the
complete one-worker owner rerun. No new isolated pass was established.
Commands, counts, and artifacts are recorded in
[1126](../aggregate-validation-runs/1126-cross-machine-search-validation-workspace-failures.md#review-fix-validation-2026-10-27).
Status remains open; no assertion, timeout, or skip changed.


## Uniform app shortcuts review — 2026-10-28

Preparation `mise run test:browser` had 912 passes, 105 skips and three
failures: the two established native branch suggestions and desktop Cursor
steering. The complete unchanged owners were then run sequentially with one
worker:

```sh
mise run test:logged -- --name recorded-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/CloseRetention.spec.ts --workers=1
```

Result: 21 passed, 20 skipped, three failed (144.9 seconds). Desktop steering
again missed `agent-runtime-steer-saturated` at line 724 after 30 seconds;
mobile steering passed. Both native branch suggestions still received `rel`
instead of `release/2.0`. This observation remains non-green in the complete
owner and is not a newly established flake. No assertions, deadlines or skips
changed. Evidence: host temporary directory
`orkestrator-test-run.E3EaSR/recorded-browser-owners.log.gz`.

## Pipeline validation-history review, 2026-10-30

The unchanged desktop steering case failed in the required full browser rerun
(`mise run test:logged -- --name repaired-browser-suite -- mise run test:browser`):
line 719 received `The Cursor session has no running turn to steer` instead of
no error. The suite reported 974 passed, 106 skipped and four failed (764.2 s).
The complete unchanged owner also failed, now waiting at line 724 for the
steer-saturated runtime card (30-second deadline): 19 passed, 20 skipped and
one failed in 136.3 s. No new isolated pass was established.

```sh
mise run test:logged -- --name recorded-close-retention -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts --workers=1
```

Evidence below the host temporary directory:
`orkestrator-test-run.CtuZX3/repaired-browser-suite.log.gz` and
`orkestrator-test-run.frrs8L/recorded-close-retention.log.gz`. No owner source,
assertion, timeout or skip changed. The fixture lifecycle race remains a
hypothesis; this turn does not establish its cause.

## Deterministic on main at 38d55ee14 — 2026-11-02

Seen while validating to-do 1202 task 3 (branch
`renderer-paths-optimization-845c78394eb7-r1`, head `19e1baf42`). All four
desktop Cursor cases failed in the loaded nine-worker `test:browser` run, in a
three-worker rerun of the failing owners, and in a one-worker run of only the
Cursor cases. The same one-worker command then failed identically on a fresh
detached checkout of `origin/main` at `38d55ee14`, so these failures do not come
from the branch:

```sh
ORKESTRATOR_E2E_PORT=<free port> mise run test:logged -- --name main-closeretention-cursor -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --project=desktop-chromium e2e/CloseRetention.spec.ts -g "Cursor"
```

Both checkouts: 2 passed, 4 failed in about 1.1 min, at the same lines:

- line 328 case, at line 339: `conversationsWith(...)` received the prompt
  followed by an `<orkestrator-system-instructions>` frame instead of the
  prompt alone.
- line 422 case, at line 442: `toMatchObject` received `undefined`.
- line 693 case, at line 724: `agent-runtime-steer-saturated` not found; the
  runtime panel shows the state `detached`.
- line 801 case, at line 831: the conversation list holds the framed prompts.

Hypothesis, not established: the Cursor bridge now appends the shared
system-instructions frame to every writable prompt
(`bridges/cursor-bridge/src/prompt.ts`, `cursorPromptText`), while this spec
still compares the fake engine's recorded prompts with the raw text, and its
`agent.prompts.includes(...)` lookups miss. On this evidence the cases are a
deterministic failure on `main`, not a load-only flake. Evidence below the
host temporary directory: `orkestrator-test-run.oUGFjC/branch-closeretention-cursor.log.gz`
(branch) and `orkestrator-test-run.2v8aZb/main-closeretention-cursor.log.gz`
(`origin/main`). No owner source, assertion, timeout or skip changed.

## Causes established and fixed, 2026-11-03

To-do 2921 task 3 (branch `close-retention-cases-4142aaf8cd0b-r1`, based on
`main` at `7b48c23fb`) reproduced all four desktop Cursor failures before
changing anything (`--project desktop-chromium --grep Cursor`: 2 passed, 4
failed). Two causes:

- **Lines 328, 422 and 801: the system-instructions frame.** The fake Cursor
  engine stored each prompt exactly as the bridge sent it, frame included.
  The fake engine now records the user's text with the frame stripped
  (`stripSystemInstructions`) as `prompt`, keeps the exact text as `sent` (what
  history replay returns, as the real vendor would), and replies to the
  stripped text. The line 328 case now also asserts that `sent` is the user's
  text followed by the frame, so the instructions are still proven to reach the
  SDK.
- **Line 693 (failing at line 724): the runtime-health cache, not the frame.**
  The fixture fills the steer history straight at the bridge, behind the
  backend's back. The backend caches each session's runtime health for
  `INTERACTIVE_RUNTIME_METADATA_TTL_MS` (30 s) from the session's first
  snapshot, so the saturated summary reaches the panel only after that entry
  expires and a later snapshot refreshes it. Until then the panel shows the
  cached `detached` state. With a temporary 75 s deadline the card appeared
  31.1 s after the panel opened. A 30 s deadline races the TTL and loses
  whenever the steps before it finish quickly, which is why it failed on idle
  hosts too. The deadline is now 60 s, with the reason in a comment.

After the change the four cases passed in the Cursor-only desktop run, and the
whole file passed apart from one desktop Pi case that passed when rerun alone
(recorded as [3600](3600-close-retention-pi-composer-missing-under-load.md)).
The line 719 mode recorded above (`The Cursor session has no running turn to
steer`) was not reproduced and its cause is not established, so this case
stays open.

## Recurrence of the line 719 mode, 2026-11-03

In the first rerun of the Cursor-only desktop command on head `08e817a45`
(beside Docker network churn, see
[2340](../aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md#2026-11-03-a-private-network-namespace-avoids-it)),
the steering case failed at line 729 (`expect(filled.error).toBeUndefined()`)
with `The Cursor session has no running turn to steer`; its trace held no
`ERR_NETWORK_CHANGED`. It passed in the next two runs in a private network
namespace (Cursor-only, then the whole file). Cause still not established;
status stays open.


## Remaining fixture causes reproduced and repaired — 2026-11-10

**Base and observed head.** Base
`c98b20e6f6332895320b84b8edfd1f3cc9542ba0`, observed head
`895a58dc220b5d610980f9ea52eae80b5d48685f`.
`mise run flaky:recurrence -- 0963 --base c98b20e6f6332895320b84b8edfd1f3cc9542ba0`
reported this case open before counting this recurrence.

**Original evidence.** The nine-worker
`mise run test:logged -- --name recorded-browser -- mise run test:browser`
failed the desktop saturation case at line 729: expected no `filled.error`,
received `The Cursor session has no running turn to steer`. Totals: 1,665
passed, 152 skipped, one failed, 1,288.6 s. Log:
`orkestrator-test-run.9ILxTG/recorded-browser.log.gz` under the host temporary
directory; trace/context under
`output/agent-testing/recorded-validation/cursor-steer-original/`.

The complete unchanged one-worker owner then passed the steering case but
failed the shed-transcript case at line 837: first-turn answer count expected
zero, received one for 5,000 ms. It reported 19 passed, 20 skipped, one failed
in 153.4 s. Log: `orkestrator-test-run.hmnmec/recorded-close-owner.log.gz`.

### Request recorded before bridge acceptance

**Reproduced: yes.** `recordingFetch` appends the outgoing prompt path before
calling `fetch`; the test treated that record as proof that the bridge had a
running SDK turn. A new fixture gate holds forwarding at precisely that
boundary. With the original assumption, the focused desktop case reproduced
the same no-running-turn error in 12.9 s, at local reproduction head
`c3aef03e3111c932a357e13be12cb87895dd98e5`:

```sh
ORKESTRATOR_E2E_PORT=<isolated-port> mise run test:logged -- --name cursor-steer-before -- bunx playwright test --config output/review-cursor-ready-worktree/e2e/playwright.config.ts output/review-cursor-ready-worktree/e2e/CloseRetention.spec.ts --grep 'steering a Cursor turn whose steer history' --project=desktop-chromium --workers=1 --output output/agent-testing/cursor-steer-before
```

The repaired case first proves that the recorded request has no accepted run
while forwarding is held. It releases the gate in `finally`, then polls the
bridge's authoritative running-turn status before the single saturation
mutation. Readiness is retried; the mutation is not. The fixture also releases
the gate on shutdown. Existing steering-capacity, draft, cancellation and
runtime-health assertions and deadlines remain intact.

### Shared budget did not guarantee the target transcript was shed

**Reproduced: yes.** After the acceptance repair, the complete owner still
failed only the shed-transcript case (19 passed, 20 skipped, one failed,
150.2 s), at local head `0bb5d80c7d5bda522bd93eacc38162f73764e00c`.
Evidence: `orkestrator-test-run.lZQDGr/cursor-ready-fixed-owner.log.gz` and
`output/agent-testing/cursor-ready-fixed-owner/`.

The production allocator correctly prioritizes newer-touched sessions. The
fixture's aggregate allowance included every session's newest message plus
96 bytes per session, so the newest target could borrow other sessions'
allowances and retain its entire transcript. A positive global shed count
proved that some session was shortened, not the target the test inspected.
This explains why the case passed alone and failed after other cases.

The fixture now applies the production budget pass separately to each
session, verifies that exactly its newest message remains, then writes the
combined stopped-bridge state. Truncation counts and flags still come from the
production serializer. Vendor conversation history and provider identity are
untouched, and the existing next-turn assertion still verifies continuation.

**Complete verification.** With both repairs, the complete one-worker owner
passed, exit 0, in 144.2 s at local head
`454ebd6da52670f608e9d65fcba2a3bb58dac4c7` (passing per-case counts were not
retained). E2E typechecking passed. The temporary checkout's code changes are
applied to the feature branch; local reproduction/diagnostic commits are not
part of its history. No timeout, retry or skip was increased.

```sh
ORKESTRATOR_E2E_PORT=<isolated-port> mise run test:logged -- --name cursor-fixtures-fixed-owner -- bunx playwright test --config output/review-cursor-ready-worktree/e2e/playwright.config.ts output/review-cursor-ready-worktree/e2e/CloseRetention.spec.ts --workers=1 --output output/agent-testing/cursor-fixtures-fixed-owner
```
