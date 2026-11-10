# Mixed-version node-mail sent before the portal saw the leaf's project

- **ID:** 9934
- **Status:** resolved
- **Date observed:** 2026-11-10

Scenario: `node-mail` (`scripts/mixed-version/scenarios/node-mail.ts`) of the
mixed-version qualification, topology `current-command` (this checkout as
command node, the published release as its leaf).

## Observation

| Run | Event | Head | Release | Result |
| --- | --- | --- | --- | --- |
| 42827537552 | `schedule` on `main` | `887cdfb5c` | `latest-stable` (2.36.1) | node-mail failed before its first check; every other node-mail run passed |

Original command (from `.github/workflows/mixed-version-qualification.yml`):

```sh
mise run qualify:mixed-versions -- --old-version latest-stable --report "$RUNNER_TEMP/mixed-version-report.json"
```

Failure: the scenario's first `send_coordinator_node_mail` answered
`HTTP 500 <leaf> has no copy of this project. Ask the user to copy it there
first (request_project_on_node).` The same run's `old-command` topology and
the `floor` job's node-mail passed.

Local reruns of the same scenario against 2.36.1 at `53340356c` passed three
times out of three (`--scenarios node-mail,ticket-sync`, both topologies).

## Resolution (2026-11-10)

- **Root cause:** a race in the scenario's setup, not in mail. The scenario
  creates the leaf's project and worker (`fixtures.worker(leaf)`) and sends at
  once. `send_coordinator_node_mail` checks for the leaf's copy in the command
  node's portal summaries (`coordinatorNodeTarget`,
  `apps/backend/src/core/commands-registry-coordinator-nodes.ts`), which the
  read model fills from the leaf's resource events and a 60-second reconcile
  (`node-read-model.ts`). On the slower CI runner the send came before the
  read model had re-read the leaf's projects.
- **Fix:** `PairFixtures.pairedOn(command, leaf)`
  (`scripts/mixed-version/fixtures.ts`) waits until the command node's
  `get_node_summaries` lists the leaf's copy of the fixture repository, and
  the node-mail scenario calls it before its first send. Nothing about the
  checks, their timeouts or retries changed.
- **Reproduced:** no — it did not fail locally before the fix (3 of 3
  passed); the cause is read from the error text and the code path above.
- **Stress:** `mise run qualify:mixed-versions -- --old-version latest-stable --topology both --scenarios node-mail,ticket-sync`
  passed after the fix (node-mail 8/8 checks current-command, 6/6
  old-command).
