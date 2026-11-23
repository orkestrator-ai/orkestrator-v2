# DNS timeout after an egress-filter worker restart

- **ID:** 9833
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `M12 name checks at the egress gateway > SNI, Host and DNS are checked against the allowlist, edits apply in place, and a dead daemon fails closed`
- **File:** `apps/backend/tests/container-live-egress-filter.test.ts:668`

Image `orkestrator-review-egress:9ffb0fe96` identifies source commit
`9ffb0fe96c85388e942a3d0dff936053b024e0fa`. On Docker Desktop 29.9.2,
macOS arm64, the initial run failed after the worker was killed and the
listener-retention probes completed: expected `status: NOERROR` for
`registry.npmjs.org A`, received `;; no servers could be reached\nrc=0`.
The scenario took 15,056.18 ms. The file reported three passed, one skipped,
one failed and 86 assertions (34.8 s, one worker). It overlapped the default
aggregate and image smoke. Host contention or an upstream DNS failure are
possibilities, not established causes.

Original command:

```sh
RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-review-egress:9ffb0fe96 mise run test:logged -- --name egress-fixed-live -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-egress-filter.test.ts --parallel=1
```

After the other validation commands finished, the complete unchanged owning
file passed alone (exit 0, 33.7 s):

```sh
RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-review-egress:9ffb0fe96 mise run test:logged -- --name egress-fixed-live-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-egress-filter.test.ts --parallel=1
```

Passing output was deleted by the logged runner, so rerun counts are not inferred.
The original failure remains at
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LWtglc/egress-fixed-live.log.gz`.
No assertion, timeout or skip was changed to obtain the pass. The optional
older-image case was not enabled. Both runs used suite-owned resources and
completed their cleanup.

## Recurrence: Container live qualification on pull request #2541 (2026-11-23)

Run 45175338998, job "Live suites (linux-x64)", head `297c7b885` (merged
with `main` at `d14e326bd`), step "Live egress name checks (M12)". The case
failed at `container-live-egress-filter.test.ts:518`, the first `dig` after
the worker restart: it expected `status: REFUSED` and received
`;; no servers could be reached`. The other four M12 cases passed. The same
step passed on this pull request's previous run (45091972830, head
`f1dee962c`) and on the run for #2543 (45092486300). The branch's only
change under `docker/` adds the Antigravity CLI to `docker/Dockerfile`; it
does not touch the gateway or the egress filter. `mise run flaky:recurrence -- 9833`
reported the case open.
