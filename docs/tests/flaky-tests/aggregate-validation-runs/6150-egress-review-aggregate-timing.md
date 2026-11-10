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
