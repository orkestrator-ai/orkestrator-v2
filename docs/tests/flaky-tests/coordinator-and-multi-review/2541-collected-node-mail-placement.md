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

## Incoming leaf mail variant (2026-11-04)

Preparation at 837e20cfc recorded the same race in `CO-05/UP-02 coordinator
mail to and from a leaf agent > delivers as ordinary incoming mail and routes
the agent's answer to that command node's outbox`: expected `pending-inject`,
received `injected` (107.81 ms). Evidence: review-validation-1adce015's
`validation-04.stdout.txt`, lines 2661–2672. The branch changes this owner,
so the failure was repaired rather than excused as an existing flake.
The incoming recipient now stays busy during the strict admission assertions,
just as the collected-mail recipient does above. The complete owner and both
subork owners pass through logged command `subork-backend-exact` with two
workers. The owner also passes five isolated repetitions through `repair-node-stress`
(5.0 s). The default suite rerun is reported in this stage's fix result.
