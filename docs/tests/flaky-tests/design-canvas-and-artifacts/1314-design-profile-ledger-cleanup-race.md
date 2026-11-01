# Design startup profile removal precedes ledger cleanup

- **ID:** 1314
- **Status:** open
- **Test:** `design service startup > removes the recorded profile of a backend that was killed`
- **File:** `apps/backend/src/core/design/browser-profiles.test.ts:348`

During external-preview review validation on 2026-10-29, preparation and the
required `mise run test` rerun both observed the orphan profile disappearing
while its JSON ledger entry was still present. The latter failed after
168.22 ms. All preview tests passed; this owner was unchanged.

The complete owner passed alone (exit 0, 0.7 s):

```sh
mise run test:logged -- --name design-profiles-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

The test waits for profile deletion, then immediately reads the ledger. A
possible explanation is that asynchronous ledger removal has not finished;
this remains an inference, not a confirmed cause. No implementation, assertion,
timeout or skip changed.

Aggregate evidence: `orkestrator-test-run.cmmuTa/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory. Preparation evidence is
`validation-04.stdout.txt` under `.orkestrator/review-artifacts/review-validation-a810480a-55a2-484a-b530-7dd5cb9588b2/`.

## Development source-hint coverage retry — 2026-10-30

The second exact `mise run test` run repeated this ledger-entry assertion
(191.91 ms). The root, bridges and protocol groups passed. Web and desktop
passed on this retry, including the owners that had failed in the previous
run. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.DbNX2x/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed alone (exit 0, 1.3 s logged):

```sh
mise run test:logged -- --name design-profile-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

No design implementation, assertion, deadline or skip changed. The full-suite
retry remains non-green solely because of this known cleanup race.

## Pipeline validation-history review, 2026-10-30

Preparation's `mise run test` repeated the remaining-ledger assertion at
265.62 ms; backend totals were 11,266 passed, 87 skipped and two failed.
Evidence: `.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/validation-04.stdout.txt`. The unchanged complete owner passed
with exit 0 in 1.8 s:

```sh
mise run test:logged -- --name recorded-backend-profiles -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Passing output was removed by the logged runner; its summary remains in
`orkestrator-test-run.D8MNsY` below the host temporary directory. The cause
remains unconfirmed; no owner implementation, assertion or timeout changed.

The required exact aggregate rerun (`mise run test:logged -- --name
repaired-unit-suite -- mise run test`) repeated the same assertion at 266.79 ms.
The complete owner had passed alone earlier in this repair turn; no source in
this owner changed. Evidence: `orkestrator-test-run.jn7K1f/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory.

## Occurrence 2026-10-30

`mise run test` on the todo 0742 structured-tickets branch (a Kanban storage
fix; nothing in `design/` changed) failed this test after 140.80 ms with the
same symptom: the profile was gone and `48963-48966-0123abcd.json` was still in
the ledger. The owner then passed alone three times in a row (27 pass each,
`bun --cwd=apps/backend test ./src/core/design/browser-profiles.test.ts`).
Aggregate evidence: `orkestrator-test-run.bzzSIG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory.

## Leaf-check readiness review — 2026-10-30

The exact final `mise run test` rerun repeated the same ledger assertion at
line 348 after 300.67 ms. It ran the backend with four file workers (six slots
reserved for the workspace group); backend totals were 11,323 passed,
87 skipped and this one failure. All other test groups and packages passed.
The complete unchanged owner passed alone with one worker (exit 0, 0.9 s):

```sh
mise run test:logged -- --name pr-review-browser-profiles-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Evidence:
`orkestrator-test-run.mtfML9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. No design cleanup implementation,
assertion, timeout or skip changed. Asynchronous ledger removal remains a
hypothesis. Other outcomes are in
[1254](../aggregate-validation-runs/1254-merge-readiness-review-validation.md).

## Docker Settings probe repair — 2026-10-31

After provisioning the missing pinned Codex binary, `NODE_ENV=test mise run test`
failed the unchanged startup test at line 505 after 77.53 ms: profile deletion
was observable while `2964482-2964484-0123abcd.json` remained in the ledger.
The aggregate reserved six workspace worker slots (four backend file workers);
the root, bridge and protocol groups passed, and the captured web summary had
zero failures. Total duration was 719.7 s, including 453.3 s waiting for host
capacity. Evidence: `/tmp/docker-fix-full-test.log` and
`/tmp/orkestrator-test-run.kjM79q/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed alone on the Docker Settings branch (0.4 s)
and on detached `origin/main` at `931e554171e86e1d640425b1839fc30d39a25970`
(0.3 s), using independently installed dependencies:

```sh
NODE_ENV=test mise run test:logged -- --name docker-validation-backend-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1
```

Thirty further owner repeats on that main checkout passed in 2.8 s:

```sh
NODE_ENV=test mise run test:logged -- --name docker-main-ledger-repro -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --rerun-each=30
```

Logs: `/tmp/docker-fix-backend-owner.log`,
`/tmp/docker-fix-main-backend-owner.log`, and
`/tmp/docker-fix-main-ledger-repro.log`. This confirms aggregate-versus-isolated
variance, not target-branch reproduction of the failure. No cleanup code,
assertion, timeout or skip changed; asynchronous ledger removal remains a
hypothesis.

The complete `NODE_ENV=test mise run test` subsequently passed on detached main
in 278.8 s and on the unchanged Docker Settings code in 168.3 s (12.0 s queued).
The final branch run passed all four groups; logs are retained separately in
`.orkestrator/review-artifacts/docker-probe-fix-e2ff8181c/docker-fix-final-full-test.log`
and `docker-fix-main-full-test.log` in that directory. The intermittent ledger
failure remains open; a passing retry does not establish a cleanup fix.

## Resolve tab reuse review — 2026-10-31

The final exact `mise run test` rerun against the committed Resolve repairs
(`527d6edab`) repeated this assertion at `browser-profiles.test.ts:505` after
224.54 ms: the profile was gone, but one JSON ledger entry remained. Backend
totals were 11,712 passed and this one failure. Every other package and the
root, bridge and protocol groups passed. The new Resolve command, queue,
retry and completion regressions passed in this aggregate run.

The complete unchanged owner passed alone with one worker (exit 0, 1.1 s):

```sh
mise run test:logged -- --name design-profile-owner -- bun test --cwd apps/backend src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Evidence below the host temporary directory:
`orkestrator-test-run.V7Etln/review-default-final.log.gz` and
`orkestrator-test-run.8wPYnM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The run spent about 1,116 seconds waiting for host admission and finished in
1,529.4 seconds. No design cleanup source, assertion, timeout or skip changed;
the root cause of this existing intermittent case remains unestablished.
Browser validation limits for the same repair are recorded in
[0382](../web-ui/0382-component-browser-parallel-load.md).

## Hidden flow graph review — 2026-10-31

The required exact `mise run test` rerun repeated this assertion after 261.25 ms.
The profile had been removed but its JSON ledger entry remained at line 505.
The web package passed all 10,876 tests; the backend had two failures,
including the other timing case recorded in this review.

Both complete unchanged owners then passed with one file worker
(exit 0, 2.4 s):

```sh
mise run test:logged -- --name recorded-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone-ready.test.ts ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.Od2gTp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. No implementation, assertion, timeout or
skip in either owner changed. This repeats the existing intermittent symptom;
no new cause was established.

## Settings layout branch, 2026-10-31

The first `mise run test` on this renderer-only branch (nothing in `design/`
changed) failed this test after 70.36 ms with the same symptom: the profile was
gone and `59426-59429-0123abcd.json` was still in the ledger. The complete
owner then passed alone twice (0.4 s and 0.9 s logged), and the next full run did
not repeat the failure. Aggregate evidence:
`orkestrator-test-run.eT8TET/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory.

## Failed-turn restart validation observation

On 2026-10-31, while validating [0940](../../../todo/cross-cutting/0940-failed-turn-reads-as-completed.md)
task 3, `mise run test` failed this case in 100.81 ms: the JSON ledger entry was
still present at line 505 after the profile had gone. The backend reported
11,713 passed, 103 skipped and this one failure across 804 files (109.36 s), on a
host running other workers (the whole run took 1,002 s against 521 s earlier the
same day). The same test passed in that earlier run. The complete unchanged owner
then passed alone three times out of three (37 passed):

```sh
mise exec -- bun test src/core/design/browser-profiles.test.ts
```

run from `apps/backend`. No design code, assertion, timeout or skip changed.
Asynchronous ledger removal remains a hypothesis.

## Codex saved-rules review observation (2026-11-01)

Preparation at `a534624935abc5da6e1ef787fb42300830cd20eb` ran `mise run test`
and repeated the stale-ledger assertion (172.62 ms) while validating the Codex
saved-rules ticket. The original evidence is retained in
`.orkestrator/review-artifacts/review-validation-c412558e-d8d4-4963-9650-c35bc996a110/validation-04.stdout.txt`.
The unchanged complete owner passed with one worker on the fix branch (0.8 s)
and in a detached `origin/main` worktree at `0bd214ee4` (0.3 s), with separately
installed dependencies:

```sh
mise run test:logged -- --name branch-browser-profile -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

No cleanup implementation, assertion, timeout, or skip changed. This isolated
pass confirms the existing intermittent observation; it does not establish a new
root cause or resolve the flake.


## Held-history reconciliation review — 2026-11-01

Preparation's `mise run test` repeated the remaining-ledger assertion after
326.35 ms with two backend workers. The backend group reported 12,523 passed,
107 skipped and one failed (469.38 s). The unchanged complete owner passed
alone with `mise run test:logged -- --name prior-design-failure -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures`
(exit zero, 2.0 s). Preparation evidence is
`.orkestrator/review-artifacts/review-validation-b8f98852-001a-4729-aa23-7e07f56c9ac5/validation-04.stdout.txt`.
No design implementation, assertion, timeout or skip changed.

## Notification-bar review — 2026-11-01

The notification-bar review on 2026-11-01 repeated the ledger assertion; the unchanged owner passed alone on the branch (1.2 s) and detached origin/main (1.0 s). Preparation used `mise run test`; its captured output does not name the granted worker count. Evidence: `.orkestrator/review-artifacts/review-validation-eb40d1d2-656b-44f0-9a8f-1c2970a9e415/validation-04.stdout.txt`.

Reruns: `mise run test:logged -- --name fix-design-profiles -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures` and the same owner command with `--name baseline-design-profiles` in detached main at `b965aea44`, with independently installed dependencies. The ledger still held `1841-1846-0123abcd.json` at line 505 in preparation; this remains an intermittent cleanup observation, not a confirmed root cause.
