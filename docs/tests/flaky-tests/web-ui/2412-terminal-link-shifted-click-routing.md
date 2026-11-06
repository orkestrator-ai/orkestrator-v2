# terminal link routing: shifted clicks fail in the aggregate suite

- **ID:** 2412
- **Status:** resolved
- **Tests:** `terminal plain URL addon link routing > routes shifted Control-clicks to an internal browser request`, `... routes shifted Command-clicks ...`, and the same two under `terminal OSC 8 constructor option link routing`
- **File:** `apps/web/src/lib/terminal-links.test.ts`

On 2026-11-02, during the shared-logger backend migration, all four failed in both of two
`mise run test` runs (11,227 web tests passed, 4 failed), each in under 1 ms, with
`expect(received).toEqual(expected)` showing no routed request. The branch changes nothing
under `apps/web`.

```sh
cd apps/web && bun test ./src/lib/terminal-links.test.ts --only-failures
```

Alone, on the branch and on clean `main`, the file passes: 21 pass, 0 fail. Whether the
aggregate fails on clean `main` was not run. `tests/unit/components/ClaudeTmuxInteractiveTerminal.test.tsx`
fails three related link-routing tests deterministically, alone, on clean `main` at 7b726a04a; it is a
separate failure rather than a flake, and may share a cause.

Hypothesis, not proven: state shared across the workspace run decides the routing.

## Main merge recurrence, 2026-11-02

Merging `origin/main` at `d7054dace` into backend logger branch `8f174e4db`
repeated all four failures in `mise run test:logged -- --name merge-default-tests -- mise run test`
(default scheduler: workspace five slots, root one, bridges two, protocol one).
Each assertion failed in under 1 ms with no routed request. The unchanged owner
passed through `test:logged` as `merge-rerun-terminal-links`, running
`bun test --cwd apps/web ./src/lib/terminal-links.test.ts --parallel=1 --only-failures`
(exit 0, 0.3 s). The separate Claude terminal owner still failed its three
documented deterministic assertions when rerun alone (23 pass, three fail).

Aggregate evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.0XP13L/`
(`workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`).

## Renderer-migration merge recurrence, 2026-11-02

The merge of `0ec784293` into `08038e814` repeated all four shifted-click
failures (1.87, 0.73, 1.42 and 0.66 ms) in
`mise run test:logged -- --name merge-default-tests -- mise run test`.
The web group reported 11,384 pass, 10 skip and 4 fail under the default
scheduler. The complete unchanged owner passed alone in 0.3 seconds through
`mise run test:logged -- --name merge-terminal-links-alone -- bun test --cwd apps/web ./src/lib/terminal-links.test.ts --parallel=1 --only-failures`.
The separate Claude terminal owner still failed its three assertions alone
(23 pass, 3 fail), so those remain deterministic failures.

Aggregate evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.6dWJ96/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Pipeline restart/delivery main merge recurrence, 2026-11-02

Merging `508995a94` into `8b44911fb` repeated the four shifted-click routing
failures (1.03, 0.60, 0.74 and 0.56 ms) in
`mise run test:logged -- --name remerge-default -- mise run test`.
The web group reported 11,400 pass, 10 skip and 4 fail under the default
aggregate scheduler. The complete unchanged owner passed alone, exit 0 in
0.2 seconds:
`mise run test:logged -- --name remerge-terminal-links-alone -- bun test --cwd apps/web ./src/lib/terminal-links.test.ts --parallel=1 --only-failures`.
The separate Claude terminal owner still failed its three assertions alone
(23 pass, 3 fail). No test, assertion or timeout was changed.

Aggregate evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.GuWhdd/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

### Resolution — 2026-11-06 (stale; fixed by #1614)

**Root cause.** This was never intermittent, and the reruns above used the wrong
file. The four failing tests (`terminal plain URL addon link routing > routes
shifted %s-clicks to an internal browser request` and the OSC 8 variants) live
in `apps/web/src/stores/terminalPortalStore.test.ts`, not in
`apps/web/src/lib/terminal-links.test.ts`, so every "passed alone" rerun ran a
different file. #1578 (5f14a41cd) limited preview-tab routing to loopback URLs,
while those tests still clicked `https://example.com/internal?q=1`, so they
failed deterministically. Commit 168d6fc0f (#1614, 2026-11-02 20:00 UTC), an
ancestor of this branch, switched them to `http://localhost:5173/internal?q=1`.
All four recurrences predate that commit.

**Verification.** `mise run test:logged -- --name web-2412-real-owner -- bun --cwd=apps/web test src/stores/terminalPortalStore.test.ts --rerun-each=5`
passed (exit 0). No code change was needed. The File column of the index now
names the real owner.
