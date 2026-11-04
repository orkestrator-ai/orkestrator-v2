# Repository icon spec's project grouping case timed out once under host load

- **ID:** 4310
- **Status:** open
- **Date observed:** 2026-11-04
- **Test:** `project grouping keeps the icon at the row's leading edge` (`mobile-chromium`)
- **File:** `e2e/RepositoryIconAlignment.spec.ts:157` at the time of the failure

The first run of the owning file on branch `align-repo-icons-1f0b22955656-r1`
failed this one case with a bare `Test timeout of 30000ms exceeded.`, naming no
pending action. The page snapshot in its error context showed the fixture fully
rendered with its sort control on `By project`, so the page had loaded. The host
load average was between 48 and 85 a few minutes later. The cause is
unconfirmed. Its trace was overwritten by the next run before anyone read it.

```sh
ORKESTRATOR_E2E_PORT=14871 mise run test:logged -- --name repo-icon-alignment -- bunx playwright test --config e2e/playwright.config.ts RepositoryIconAlignment
```

That run: 13 passed, 1 failed, 40.7 s in total. The case passed in every later
run of the owning file: the same command with `--repeat-each=5` (70 of 70), once
more straight after clearing `node_modules/.vite` (14 of 14, 13.3 s), so a cold
Vite dependency cache alone does not reproduce it, then `--repeat-each=3` and
`--repeat-each=10` (140 of 140) after the changes below.

The `--repeat-each=3` run had one failure in a different case, `the activity ring
moves neither the icon nor its label, and stays centred` (41 of 42). That one is
not a flake and has a known cause, now fixed: the fixture wrote the activity
store directly, and the store's first read could land afterwards and clear it.
The fixture now serves the state from its fake backend.

At the time, a file-wide `beforeEach` opened the repository grouping page before
this case navigated to its own URL, so it and its machine grouping sibling were
the only cases with two navigations in their 30 s budget. That navigation was
removed afterwards because it served no purpose. There is no evidence that it
caused the timeout, so this case stays open until the timeout is seen again or
explained. No assertion, timeout or retry was changed for it.
