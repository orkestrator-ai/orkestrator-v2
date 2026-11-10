# Egress repair aggregate: unchanged process and scan owners

- **ID:** 6150
- **Status:** open
- **Date observed:** 2026-11-05

Original command: `mise run test:logged -- --name review-default-tests -- mise run test`.
The first aggregate was interrupted by a pipeline pause before complete totals;
its root group finished with 3,667 pass and one unrelated registry collision.
The workspace reserved six worker slots, with two workers per package; root and
bridges reserved one and two respectively. The second run reproduced the store
scan timeout. These owners are unchanged by the egress branch.

| Test | File | Aggregate observation | Isolated owner |
| --- | --- | --- | --- |
| `APP_VERSION > resolves a absent environment value on import` | apps/backend/src/core/constants.test.ts | 5,000.76 ms timeout, first run | passed, 0.5 s |
| `APP_VERSION > resolves a empty environment value on import` | apps/backend/src/core/constants.test.ts | 5,002.53 ms timeout, first run | same complete owner pass |
| `APP_VERSION > resolves a whitespace environment value on import` | apps/backend/src/core/constants.test.ts | 5,001.32 ms timeout, first run | same complete owner pass |
| `PreviewRelaySupervisor (local relay process) > uploads are delivered in order under credit flow control` | apps/backend/src/preview-relay-supervisor.test.ts | 5,006.13 ms timeout, first run | passed, 1.4 s |
| `StorageService store writers > no backend class outside the scan calls the store write primitives` | apps/backend/src/core/storage-writer-guards.test.ts | 7,508.21 ms timeout, second run | passed, 1.4 s |

Complete-owner commands (each exited 0):

- `mise run test:logged -- --name constants-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/constants.test.ts --parallel=1 --only-failures`
- `mise run test:logged -- --name preview-relay-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-relay-supervisor.test.ts --parallel=1 --only-failures`
- `mise run test:logged -- --name storage-writer-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/storage-writer-guards.test.ts --parallel=1 --only-failures`

Original workspace evidence is in `orkestrator-test-run.20KKVR` (first run) and
`orkestrator-test-run.LAWw4i` (second run), under the host temporary directory.
The final repair result retains complete aggregate outcomes and artifact paths.
Contention is a hypothesis based on the timeout/pass difference, not a measured
cause. No owner was skipped or relaxed.

The deterministic missing `node_modules/leaf/package.json` installer failure and
duplicate registry ID 5105 were reproduced alone and are not flakes. The
measurement-cap owner also timed out alone; its existing case is 5360 and this
run does not prove that timeout environmental.

## Completed aggregate result

The second aggregate exited 1 after 738.9 s. Its workspace reported backend
15,599 pass, 134 skip, four failures and one error; web 12,655 pass, 10 skip
and two failures; protocol 4,777 pass, two skip and one failure. Other workspace
packages passed. Root reported 3,667 pass and one failure (the unchanged ID 5105
collision); bridges and the protocol lockfile passed. The complete outer artifact
is `orkestrator-test-run.d9kd3g/review-default-tests.log.gz`; inner compressed group
artifacts are in `orkestrator-test-run.LAWw4i`, both under the host temporary
directory. These failures remain separate from the passing targeted egress work.


## Completion Notes validation — 2026-11-10

Observed on `open-notes-tab-0bdba344d18c-r1` at `49bc718245`, base
`c6de4733c5beb87a578f82a8548725305e1ff254`. The exact command was
`mise run test:logged -- --name review-default-tests -- mise run test`.
The workspace group reserved six slots after a 1,016.6 s lease wait; backend
used two isolated workers, alongside root, bridges and component-browser tests.

`StorageService store writers > no backend class outside the scan calls the store write primitives`
(`apps/backend/src/core/storage-writer-guards.test.ts`) exceeded its 5,000 ms
budget at 7,810.10 ms. Backend totals: 17,688 passed, 151 skipped, one failed;
17,840 tests across 1,211 files in 442.84 s. The workspace's other failure was
the protocol process-group assertion tracked in case 9840. Root, bridges and
protocol-lockfile groups passed; the aggregate exited 1 after 1,657.6 s including
its admission wait.

The unchanged complete owner passed with
`mise run test:logged -- --name storage-writer-owner-r3 -- bun test --cwd apps/backend ./src/core/storage-writer-guards.test.ts --parallel=1 --only-failures`
(exit 0, 0.8 s). Passing raw output was deleted; no isolated test count is claimed.
`mise run flaky:recurrence -- 6150 --base c6de4733c5beb87a578f82a8548725305e1ff254`
reports the existing case open. The branch changes storage layout code scanned
by this guard; the isolated pass does not prove a cause or environmental
exemption. No scan, test, timeout or assertion was changed, and validation remains red.

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KZbVC6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and outer log `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.QmChPr/review-default-tests.log.gz`.

## Store-writer scan repair — 2026-11-10

Applied on `open-notes-tab-0bdba344d18c-r1` after `3151aff54`. This covers only the
store-writer row; the constants and preview-relay rows stay open.

Measured on this macOS host (18 cores, load average 19–30), Bun 1.4.4, with a
throwaway timed copy of the test, deleted afterwards:

| Phase of `no backend class outside the scan calls the store write primitives` | Time |
| --- | --- |
| `analyzeStorageService()` (cached by the file's earlier tests in a normal run) | 168 ms |
| List 1,240 backend sources | 2 ms |
| Read 18.4 MB and filter by text (34 files match) | 57 ms |
| Parse and walk the matches | 20 ms |

The JUnit time for the test in the complete owner was 125 ms. Three runs of the
owner beside three concurrent `--parallel=6` backend storage runs kept every
test in the file under 0.22 s, so the 7,810 ms aggregate figure was not
reproduced. The test is synchronous, with nothing to await: it reads the whole
backend tree and parses what can match. In this file it was the first of three
tests that each read the whole tree again (`backendSourceFiles()` plus
`readFileSync`, then `backendSources()` twice), so it took the uncached read.

The branch's storage change scanned by this guard is 118 added lines in two files
(of about 2.8 MB of `storage*.ts` source), which does not account for a
62-fold slowdown.

Repair, without changing any assertion:

- `backendSources()` reads the tree once per test process and hands out copies;
  the primitive scan now uses it, so the file reads the backend tree once instead
  of three times, and `parse()` reuses the trees.
- The three whole-tree tests in `storage-writer-guards.test.ts` take
  `WHOLE_TREE_SCAN_TIMEOUT_MS` (30 s), documented beside the constant in
  `storage-writer-guards-test-support.ts` as synchronous whole-tree work with
  nothing to await, per AGENTS.md's budget rule.

Owners after the change:
`mise run test:logged -- --name storage-writer-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/storage-writer-guards.test.ts ./src/core/storage-writer-guards-raw.test.ts ./src/core/storage-writer-guards-analysis.test.ts --parallel=2 --only-failures`
passed (1.4 s). The raw-writer scan (case 1309) is not changed here.

## Completion Notes next preparation, 2026-11-10

Observed at `ebd2cfd7fc00face0995e438ea85fc25b40d1bf4`, branch base
`c6de4733c5beb87a578f82a8548725305e1ff254`. The store-writer scan did not recur.
`mise run flaky:recurrence -- 6150 --base c6de4733c5beb87a578f82a8548725305e1ff254`
reports this case open. This observation does not establish a shared cause for
the failures below or resolve the earlier rows.

Original command: `mise run test:logged -- --name review-default-tests -- mise run test`.
The backend runner used two parallel workers. Its retained complete inner log
reports 17,680 pass, 151 skip, nine fail and three errors across 1,211 files;
the outer review-package copy truncates that log. Desktop also failed its
startup test. The package's failure triage marks the six credential, readiness
and listener failures plus the evidence-output failure related through imports;
the three remaining failures are undetermined because test-file names were
missing from parsed records. These classifications alone do not establish cause.

| Test | Owner under `apps/` | Original observation | Whole owner rerun |
| --- | --- | --- | --- |
| `Electron backend command registry > GitHub credential helper > removes a token-bearing rewrite an older image or backend left behind` | backend/tests/commands-container-exec.test.ts | 5,011.93 ms timeout; child status null | passed, 3.3 s |
| `Electron backend command registry > GitHub credential helper > keeps working after setup clears credential.helper, on either order` | backend/tests/commands-container-exec.test.ts | 5,005.28 ms timeout; child status null | same owner |
| `Electron backend command registry > GitHub credential helper > takes a token out of an origin left by an earlier clone` | backend/tests/commands-container-exec.test.ts | 5,005.96 ms timeout; child status null | same owner |
| `bounded in-container boot wait > a pending shell probe is clipped to the remaining overall deadline` | backend/tests/container-readiness.test.ts | 2,102.05 ms against a 1,500 ms assertion | passed, 3.8 s |
| `bounded in-container boot wait > renews an expired shell wait window and accepts readiness in the next exec` | backend/tests/container-readiness.test.ts | container-exited error, 2,179.83 ms | same owner |
| `LoopbackListenerOwnership on this host > attributes a real :: listener and refuses another environment` | backend/src/core/preview-listener-ownership.test.ts | unattributed instead of this-environment, 1,161.74 ms | passed, 1.2 s |
| `real backend runner seals hashed evidence and refuses a moved head or replaced log` | backend/src/core/review-validation-service.test.ts | empty output instead of evidence, 2,547.90 ms | passed, 2.3 s |
| `goalWorkspaceFingerprint > changes with a new file, an edit and a commit, and not otherwise` | backend/src/core/native-agent-goal-check.test.ts | 5,000.98 ms timeout | passed, 0.9 s |
| `no backend file imports zod` | backend/src/core/no-zod.test.ts | 12,686.14 ms against a 5,000 ms deadline | passed, 0.3 s |
| `dev:test bridge builds > a successful start records bridges before launching the runtime and accepts backend readiness` | desktop/scripts/dev/bridge-builds.test.ts | 15,025.60 ms timeout | passed, 0.8 s |

Each unchanged whole owner was rerun separately with
`mise run test:logged -- --name <name> -- bun test --cwd apps/<package> ./<owner> --parallel=1 --only-failures`.
Names in table order (deduplicated by owner): `credential-owner`,
`readiness-owner`, `listener-owner`, `evidence-owner`, `fingerprint-owner`,
`no-zod-owner`, `recorded-desktop-owner`. All exited 0. Passing logs were deleted
by the logged runner; individual test counts were not retained. A preceding
six-file backend run (`recorded-backend-owners`, two workers) also passed in 6.3 s.

The exact original aggregate command then passed in 318.7 s (exit 0).
No failing owner, deadline or assertion was changed. This clears that recorded
command, but does not prove a product or harness repair for these intermittent
failures. Original evidence remains in
`.orkestrator/review-artifacts/review-validation-b17b55a3-a0c1-4c51-88c4-efbb8c66471b/validation-04.stderr.txt`
and the complete inner log at
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.iar2kT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
Related earlier observations: readiness case 0230, listener case 1410 and desktop
startup case 1202. An isolated pass is not an environmental exemption.
