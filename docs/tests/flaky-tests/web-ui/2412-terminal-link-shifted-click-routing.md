# terminal link routing: shifted clicks fail in the aggregate suite

- **ID:** 2412
- **Status:** open
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
