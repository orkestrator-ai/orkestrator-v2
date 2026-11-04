# Collected node mail admission races the automatic drain

- **ID:** 2541
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test:** `UP-02/CO-05 collected leaf mail reaches the coordinator on the command node > an item for a known conversation lands in that coordinator's mailbox, then is acknowledged`
- **Owning file:** `apps/backend/src/core/nodes/node-coordination.test.ts`

## Observation

Preparation at 4ad22cf86 ran `mise run test`. The backend workspace test
expected `pending-inject` and received `injected` after 67.30 ms.
Evidence: `.orkestrator/review-artifacts/review-validation-4a35050f-626e-49c8-9cb6-ead0ac5d7024/validation-04.stdout.txt`, lines 3045–3060.
The recorded aggregate exited 1 with incomplete totals. Its worker allocation
is not recorded in that package. The unchanged complete owner then passed
with the subork owner, using two workers (1.4 s):
`NODE_ENV=test mise run test:logged -- --name subork-backend -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts ./src/core/native-agent-suborks.test.ts ./src/core/nodes/node-coordination.test.ts --parallel=2 --only-failures`.

## Root cause and repair

The recipient starts idle, so automatic injection can advance placement before
the admission assertion. Keep it busy with `world.startTurn(main)` before
collecting. The original strict pending-placement assertion remains; other
cases cover injection. The repaired owners plus storage-build-pipelines passed
with two workers in 1.9 s. The default aggregate rerun is recorded separately
in this stage's fix result. Related admission race: case 1780.

The repaired complete owner also passed `--rerun-each=5 --parallel=2`
(4.4 s), via logged command `node-placement-stress`.
