# Codex command catalogue stale/ready race

- **ID:** 0791
- **Status:** open
- **Observed:** 2026-10-24, selected-machine settings validation
- **Test:** `a cold app-server child > two pre-plugin answers stay stale until late plugins are observed and confirmed`
- **File:** `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts:273`

The unchanged bridge owner failed in `mise run test:logged -- --name
settings-repository-tests -- mise run test`. The aggregate reserved two workers
for bridges; Codex reported 2356 pass, 40 skip and 1 fail across 88 files
(54.31 seconds). The failing case took 99.29 ms and expected `grown.status` to
be `stale`, but received `ready`.

The complete unchanged owner then passed alone:

```sh
mise run test:logged -- --name settings-codex-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Exit status was 0, logged duration 1.3 seconds. No assertion, timeout, skip or
bridge implementation changed. The settings implementation does not edit bridge
code. A background catalogue refresh settling between the polling condition and
the final `commands.list()` is a hypothesis; the observed status difference does
not establish the cause.

Original evidence: host temporary directory
`orkestrator-test-run.GSCek7/bridges.log.gz`, with the outer run under `orkestrator-test-run.iCAyRT`.

## Annotation qualification validation, 2026-10-25

The unchanged owner failed again during `annotation-suite` (`mise run test`),
this time in `a cold app-server child > its first answer is stale until a
settling re-read confirms the plugin skills`. Its exact-call-count settling
wait at line 212 timed out after 2,067.66 ms. Codex reported 2356 pass, 40 skip
and 1 fail across 88 files (72.69 seconds). The shared host capacity queue was
also delaying this run's workspace group; that does not establish the cause of
the test failure.

The entire owner passed alone, with no source or timeout changes:

```sh
mise run test:logged -- --name annotation-codex-catalogue-check -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Exit status was 0; logged duration was 1.3 seconds. The annotation fixes do not
change any bridge implementation. Aggregate evidence is in the host temporary
directory `orkestrator-test-run.N5VXK9/bridges.log.gz`; the enclosing log is
`orkestrator-test-run.gSVRr6/annotation-suite.log.gz`.

## Per-machine accounts validation, 2026-10-25

Failed again in the `todo-0722-per-machine-accounts` branch's
`mise run test` aggregate (the branch changes no bridge code), and once in
three solo runs of the unchanged owner
(`bun test src/commands/codex-command-catalogue.test.ts --preload
../../tests/setup-node.ts` from `bridges/codex-bridge`, Bun 1.4.2): it does
not need aggregate load. The sibling case at line 284 fails the same way;
see [0800](0800-codex-command-catalogue-armed-delay-race.md).

## Triage 2026-10-25

- **Disposition:** open. This case now also covers [0800](0800-codex-command-catalogue-armed-delay-race.md) (duplicate) and the third sibling seen in [0810](../aggregate-validation-runs/0810-cli-command-surface-validation.md).
- **Rerun today:** the complete owner alone, three times (`mise exec -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1`, Bun 1.4.4, load average 35 to 46): 30/30, 30/30, then this case failed (29/30, 51.53 ms). The fix d723429d5 (#1223, 2026-10-24) predates both 2026-10-25 failures, so it did not cure this.
- **Folded from 0800:** `an explicit refresh cannot replace the baseline for an already armed delay` (line 284) failed 2 of 8 solo runs on 2026-10-25 (72.51 ms and 115.88 ms, at lines 290 or 293), expected `stale`, received `ready`; Bun 1.4.2, no aggregate load.
- **Folded from 0810:** `its first answer is stale until a settling re-read confirms the plugin skills` (line 191) missed its own 2 s `waitFor` (2176.95 ms) in a loaded aggregate on 2026-10-25.
- **Likely cause:** `coldCatalogue` uses a real 20 ms `skillColdSettleMs` timer (line 187). Each case calls `commands.list()` after a `waitFor(state.calls.length === N)`. When the scheduler is slow, the next delayed read runs and settles before that `list()`, so it reports `ready`.
- **Next step:** drive the settle delay from an injected timer, or hold each fake `listSkills` answer until the test releases it, so the test decides when each delayed read lands.

## 2026-10-25 composer model admission validation

Recurred in `review-tests` (`mise run test:logged -- --name review-tests --
mise run test`) on `todo-0004-composer-model-params-803868a90fcb` with Bun
1.4.4. Both cold-child catalogue cases expected `stale` but received `ready`;
no command catalogue implementation or tests changed in this work.

The complete unchanged owner passed alone (exit 0, 2.1 seconds):

```sh
mise run test:logged -- --name bridge-catalogue-recheck -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Original aggregate evidence: `orkestrator-test-run.T3LqzB/bridges.log`
(compressed on aggregate completion). The original aggregate remains failed.
No skips, assertions or timeouts were changed.

## Leaf-node Control MCP parity validation, 2026-10-25

`mise run test:logged -- --name full-test -- mise run test` at `e8fa18152` plus
the leaf-node parity changes (no bridge code changed) failed `a cold app-server
child > two pre-plugin answers stay stale until late plugins are observed and
confirmed` at line 273: expected `stale`, received `ready` (43.47 ms). Codex
reported 2360 pass, 40 skip and 1 fail across 88 files (29.82 s). The complete
unchanged owner then passed alone (30 of 30) with
`bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1`.
Evidence: `orkestrator-test-run.A7erFE/bridges.log.gz`. The original aggregate
remains failed; nothing was changed.

## Interaction review fixes validation — 2026-10-25

The aggregate `mise run test` on `todo-0001-agent-interactions-db4f03351da7`
(`db35fb35f` plus the review fixes, Bun 1.4.4) repeated the first-answer
settling wait timeout at 2111 ms. The complete unchanged owner passed alone in
1.2 seconds:

```sh
mise run test:logged -- --name codex-catalogue-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Evidence: private `orkestrator-test-run.urvUKa/bridges.log` in the host temporary
directory (compressed on aggregate completion). No assertion, skip, deadline or
catalogue implementation was changed.

## OpenCode undo (0175) validation — 2026-10-26

The second aggregate `mise run test` on
`todo-0175-opencode-undo-3179a52c7d02` (`ea9f08ac9`, backend OpenCode code
only, no bridge code changed; the host's 18 worker slots were shared with
other worktrees) failed `a cold app-server child > its first answer is stale
until a settling re-read confirms the plugin skills` at line 216: expected 3
catalogue calls, received 4 (210.56 ms). Codex reported 2363 pass, 42 skip and
1 fail. The first aggregate on the same branch had passed the bridges group.
The complete unchanged owner then passed alone three times (30 of 30 each)
with `bun test ./src/commands/codex-command-catalogue.test.ts` from
`bridges/codex-bridge`. Evidence:
`orkestrator-test-run.rr9ak4/bridges.log.gz` in the host temporary directory.
No assertion, skip, deadline or catalogue implementation was changed.

## Codex resume-context review validation — 2026-10-26

`mise run test:logged -- --name repository-tests -- mise run test` repeated
the two-pre-plugin-answer failure at line 273 (56.47 ms): expected `stale`,
received `ready`. The bridges group reserved two workers; the Codex package
used one Bun worker and reported 2381 pass, 43 skip, 1 fail across 90 files.
This change edits only the history reader and its regressions, not the catalogue.

The complete unchanged catalogue owner passed alone, exit 0 in 1.5 seconds:

```sh
mise run test:logged -- --name codex-catalogue-isolated -- bun test ./bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: host temporary directory `orkestrator-test-run.unZQTH/bridges.log`
(compressed on aggregate completion); enclosing log
`orkestrator-test-run.2JILAH/repository-tests.log`. No catalogue assertion,
deadline or implementation changed; the original aggregate remains failed.

## Provider non-delivery proof validation, 2026-10-27

The first `mise run test` of the todo 0223 branch failed `a cold app-server
child > its first answer is stale until a settling re-read confirms the plugin
skills` again: the settling wait at line 212 timed out (2,104.24 ms). Codex
reported 2,458 pass, 46 skip and 1 fail across 98 files. The complete owner
passed alone (30 passed), and the second full run passed the Codex bridge. The
branch changes the Codex dispatch journal and prompt claim, not the command
catalogue. Evidence: [1147](../aggregate-validation-runs/1147-provider-non-delivery-proof-0223-validation.md).

## Main merge for pipeline step skipping — 2026-10-28

The duplicate armed-delay case tracked by [0800](0800-codex-command-catalogue-armed-delay-race.md)
recurred in `mise run test:logged -- --name merge-default-tests -- mise run test`:
`an explicit refresh cannot replace the baseline for an already armed delay`
failed at line 293 (110.73 ms). The complete unchanged owner passed alone
(exit 0, 1.4 s):

```sh
mise run test:logged -- --name merge-codex-catalogue-recheck -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.Xy7MuA/bridges.log.gz` below the host
temporary directory after completion. The merge changes no Codex bridge code,
assertions, timeouts, or skips; the original aggregate remains non-green.

## Project landing-tab review — 2026-10-28

Preparation's `mise run test` repeated `a cold app-server child > two pre-plugin
answers stay stale until late plugins are observed and confirmed` at line 273
(114.52 ms), using the default concurrent workspace/root/bridges/protocol groups.
The unchanged complete owner passed alone (exit 0, 1.6 s):

```sh
mise run test:logged -- --name prior-codex-failure -- bun --cwd=bridges/codex-bridge test ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Preparation evidence is `validation-05.stdout.txt` in
`.orkestrator/review-artifacts/review-validation-715de670-9258-47de-9a56-3b5d32afcae9/`.
No catalogue code, assertions, timeouts or skips changed.


## Markdown diagram review validation — 2026-10-29

Preparation's `mise run test` repeated the two-pre-plugin-answer failure at
`codex-command-catalogue.test.ts:273`: expected `stale`, received `ready`.
The complete unchanged owner passed alone (exit 0, 1.0 s):

```sh
mise run test:logged -- --name prior-codex-catalogue -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Preparation evidence: `.orkestrator/review-artifacts/review-validation-2524a0c5-d52e-4452-857a-af901c877175/validation-04.stdout.txt`.
No catalogue implementation, assertion, deadline or skip changed.

The exact `mise run test` rerun passed all four groups (exit 0, 148.3 s),
logged as `review-default-rerun`.

## Scheduling switch review — 2026-10-29

Preparation's `mise run test` repeated the two-pre-plugin-answer mismatch
at line 273 (124.55 ms): expected `stale`, received `ready`. The complete
unchanged owner passed alone (exit 0, 1.4 s):

```sh
mise run test:logged -- --name preparation-catalogue-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Preparation evidence: `validation-04.stdout.txt` in
`.orkestrator/review-artifacts/review-validation-ad2356ce-9b58-4c2c-9646-2ee2f31dec55/`.
No implementation, assertion, deadline or skip changed in this owner.


## External preview review fixes — 2026-10-29

The required `mise run test` rerun repeated the armed-delay assertion at
`codex-command-catalogue.test.ts:293` (50.71 ms): expected `stale`, received
`ready`. The complete unchanged owner passed alone (exit 0, 1.3 s):

```sh
mise run test:logged -- --name codex-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.cmmuTa/bridges.log.gz` in the host
temporary directory. No catalogue implementation, assertion, timeout or skip
changed. Preview regressions are independent of this timer race.

## Project icon review validation — 2026-10-29

Preparation's `mise run test` repeated the two-pre-plugin-answer mismatch
at line 273: expected `stale`, received `ready`. The complete unchanged
owner passed alone (exit 0, 1.1 s):

```sh
mise run test:logged -- --name preparation-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Preparation evidence: `validation-04.stdout.txt` in
`.orkestrator/review-artifacts/review-validation-801e01fe-bc32-4c2d-bbaa-76969f1dcae2/`.
The subsequent exact aggregate rerun's bridges group passed (40.8 s).
No catalogue implementation, assertion, deadline or skip changed.


## Transcript media snapshot review repair — 2026-10-29

Preparation at `63b8a00d7` failed the already-armed-delay case at line 293:
expected `stale`, received `ready`. The complete unchanged owner passed alone
(exit 0, 1.0 s):

```sh
mise run test:logged -- --name preparation-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Preparation evidence is `validation-04.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-d2902dab-3f13-48a3-aea0-29fb21e09960/`.
No catalogue implementation, assertion, deadline or skip changed.

The exact failed aggregate command was rerun after the media fixes and passed
(exit 0, 156.7 s):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```

## Pipeline validation-history review, 2026-10-30

Preparation's `mise run test` repeated the first-answer settling timeout at
2209.90 ms (Codex: 2,265 passed, 52 skipped and one failed). Evidence:
`.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/validation-04.stdout.txt`. The first complete isolated run instead
failed the two-pre-plugin-answer stale/ready assertion at 75.14 ms (29 passed,
one failed); a second unchanged run passed all 30 tests in 1.2 s:

```sh
mise run test:logged -- --name recorded-codex-catalogue -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

The failing isolated log is `orkestrator-test-run.jy1RfG/recorded-codex-catalogue.log.gz`
below the host temporary directory; the passing summary is in
`orkestrator-test-run.ngehxI`. This confirms intermittent behavior, without
establishing its cause. No bridge source, assertion or timeout changed.


## PR auto-merge review repair, 2026-10-31

Preparation's `mise run test` repeated the two-pre-plugin-answer stale/ready
mismatch at 102.04 ms (Codex: 2,265 passed, 52 skipped, one failed). The
recorded aggregate ran bridge tests in parallel; evidence is
`.orkestrator/review-artifacts/review-validation-038a8906-ba10-4822-a245-7c81a58b7a2c/validation-04.stdout.txt`.
The unchanged complete owner passed alone (30 tests, 1.0 s, exit 0):

```sh
mise run test:logged -- --name catalogue-isolated -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

No bridge implementation, assertion, or timeout changed. This confirms the
existing intermittence; the cause remains unproven.

## Resolve button tab reuse validation, 2026-10-31

`mise run test` failed the two-pre-plugin-answer stale/ready assertion
(`codex-command-catalogue.test.ts:273`, expected `stale`, received `ready`) at
97.17 ms. Codex reported 2,313 passed and one failed; the suite took 715.6 s, about
four times an earlier run on the same machine (182 s), so the host was under load.
The change under test edits no bridge file. Log:
`orkestrator-test-run.xfpUnw/bridges.log.gz` below the host temporary directory.
The owning file then passed five of five runs alone (30 passed each):

```sh
bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts
```

No bridge source, assertion or timeout changed.

## Project checkout review validation, 2026-10-31

`mise run test:logged -- --name review-default-rerun -- mise run test`
repeated the first-answer settling timeout at line 212 (2,046.68 ms). The
aggregate reserved two bridge worker slots; the Codex package ran with one
Bun worker and reported 2,265 passed, 53 skipped and one failed across 101
files (47.21 s). The bridge group completed in 116.0 s.

The complete unchanged owner passed (exit 0, 1.3 s):

```sh
mise run test:logged -- --name cold-command-catalogue -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.sdHQzL/bridges.log.gz` in the host temporary
directory; the enclosing run is `orkestrator-test-run.2RPkIW`. The checkout
fixes change no bridge source, assertion, deadline or skip. This is another
intermittent observation, not proof of a root cause or a passing aggregate.

## Notification-bar review — 2026-11-01

Notification-bar review on 2026-11-01 repeated the first-answer timeout; the unchanged owner passed alone on the branch (1.4 s); detached origin/main also showed an armed-delay stale/ready mismatch. Preparation used `mise run test`; its captured output does not name the granted worker count. Evidence: `.orkestrator/review-artifacts/review-validation-eb40d1d2-656b-44f0-9a8f-1c2970a9e415/validation-04.stdout.txt`.

Rerun: `mise run test:logged -- --name fix-codex-catalogue -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`. Detached main at `b965aea44` used the same command with `--name baseline-codex-catalogue` and independent dependencies: 29 passed, one failed at line 293 (expected stale, received ready; 75.25 ms). Artifact: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.WIkxwY/baseline-codex-catalogue.log.gz`. Preparation timed out after 2076.62 ms at line 212. No bridge code changed.

## Agent mail review validation — 2026-11-01

`mise run test:logged -- --name repair-root-tests -- mise run test` repeated
`a cold app-server child > an explicit refresh cannot replace the baseline for
an already armed delay`: expected `stale`, received `ready` at line 293
(97.92 ms). Codex reported 2,331 passed, 63 skipped and one failed across
2,395 tests in 105 files (67.76 s), using one Bun worker within the two-slot
bridge reservation. The bridge group took 153.6 s; the aggregate exited 1
in 907.5 s. Workspace/root/bridges/protocol reservations were 5/1/2/1 and
browser checks also ran on the host.

The complete unchanged owner rerun also failed:
`mise run test:logged -- --name repair-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures`.
It reported 29 passed, one failed (3.3 s), timing out on the first-answer
settling case at line 212 after 2048.96 ms. This observation is not a passing
isolated reproduction. No bridge implementation, assertion, deadline or skip
changed; the existing timing investigation remains open.

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8VTwNj/bridges.log.gz`
and `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.53Ejpu/repair-catalogue-owner.log.gz`.

## Safe error formatting second review — 2026-11-02

`mise run test:logged -- --name r5-round2-default-suite -- mise run test`
at `af887fd24a46c2a3eb12047f4732f8985ad7782f` failed in
`a cold app-server child > disposal cancels a pending settling re-read`:
line 426 expected one call but received two (103.45 ms). Codex bridge:
2,332 passed, 63 skipped, one failed, two parallel Bun workers.
The bridge group finished in 39.3 s after shared-scheduler admission.
Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.kkqsTX/bridges.log`
(compressed after aggregate completion).

The complete unchanged owner command
`mise run test:logged -- --name r5-round2-codex-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures`
first failed in the existing sibling case
`two pre-plugin answers stay stale until late plugins are observed and confirmed`
at line 273: expected stale, received ready (57.11 ms; 29 passed, one failed,
1.2 s). Artifact: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.POP8Pd/`.
An exact unchanged owner rerun then passed (1.1 s).

A new detached main checkout at `f80a181e6b92d7dbe48f30abb0c18eaf89651543`
installed its own dependencies with `mise exec -- bun install --frozen-lockfile`.
The complete owner with `--rerun-each=10` passed (10.6 s), using
`mise run test:logged -- --name r5-round2-main-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --rerun-each=10 --parallel=1 --only-failures`.
The disposal case alone also passed 100 repeats (4.5 s), using
`mise run test:logged -- --name r5-round2-main-catalogue-disposal -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --test-name-pattern 'disposal cancels a pending' --rerun-each=100 --parallel=1 --only-failures`.

No bridge implementation, assertion, wait, timeout or skip changed. The exact
aggregate failure was not reproduced on main; its independence from the
logging change remains unproven. This case stays open.

### Exact aggregate rerun outcome

`mise run test:logged -- --name r5-round2-default-suite -- mise run test`
finished with exit 1 (919.0 s, including about 663 s of admission wait).
Workspace, root and protocol groups passed. All five original backend assertion
failures passed in this run. The sole failing group was bridges: the Codex
catalogue disposal assertion recorded in case 0791. No root-cause fix to these
existing timing cases is claimed. Final status evidence is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.kkqsTX/summary.json`;
compressed group logs are in that same directory. The enclosing log is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.TLjndR/r5-round2-default-suite.log.gz`.
