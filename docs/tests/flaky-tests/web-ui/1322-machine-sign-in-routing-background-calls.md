# Settings sign-in routing receives background node calls

- **ID:** 1322
- **Status:** open
- **Date observed:** 2026-10-30
- **Test:** `Settings sign-in controls deliver command node to their backend calls`
- **File:** `apps/web/src/components/settings/machine-sign-in-routing.test.tsx:102`
- **Original command:** `mise run test`
- **Failure:** the exact workspace command-call assertion received `get_node_status` and `get_node_summaries` before the expected `open_in_browser` call. Web reported 10,840 passed, ten skipped and one failed; backend reported zero failures, and the root, bridges and protocol groups passed. Desktop's bridge startup timeout is tracked separately in case 1202.
- **Owning file rerun:** `mise run test:logged -- --name machine-sign-in-owner -- bun test --cwd apps/web ./src/components/settings/machine-sign-in-routing.test.tsx --parallel=1 --only-failures` passed unchanged in 1.3 s.
- **Cause:** unconfirmed; background node polling may share the command mock. No settings behavior, test assertion, timeout or skip changed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.7r8HZm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
