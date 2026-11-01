# Docker confirmation startup probe count changes in the aggregate

- **ID:** 2398
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `App Docker availability > delays the confirming startup probe without extending the loading overlay`
- **File:** `apps/web/src/App.test.tsx:2624`
- **Original command:** `mise run test:logged -- --name review-repair-default -- mise run test`
- **Workers:** workspace/root/bridges/protocol reservations 5/1/2/1; two web workers, beside browser and Electron validation on a shared macOS host.
- **Failure:** expected one Docker-availability call, received three (443.47 ms).
- **Owning-file rerun:** `mise run test:logged -- --name app-startup-owner -- bun test --cwd apps/web ./src/App.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 11.2 s.
- **Evidence:** `orkestrator-test-run.BSqVX9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` below the host temporary directory, compressed at aggregate finalization. Final workspace totals were not yet available when the owner was rerun.
- **Assessment:** intermittent startup-probe count failure; the cause remains unknown. No implementation, assertion, timeout or skip changed. The related availability-poll case [0082](0082-app-docker-availability-polls-every-60-seconds-a.md) concerns a different assertion.
