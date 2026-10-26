# Environment and disk cleanup (0023) validation: aggregate failures under load

- **ID:** 1010
- **Status:** open
- **Date observed:** 2026-10-26
- **Change under test:** commit `d0de935d` on
  `todo-0023-environment-disk-cleanup-7f4af662efb4` (parent main `93018933`):
  test temp-directory cleanup in five test files, a `disk:report` ledger row,
  and the macOS Keychain step of `removeProfile`. None of the failing owners
  below, or the code they test, changed.
- **Host:** omarchy-hp, Arch/Omarchy Linux x86_64, 12 CPUs, 30 GB RAM, shared
  with other workers. The same host had restarted Claude twice that morning
  under another worker's test service.
- **Original command:** `TMPDIR=/tmp/ork0023-full-tmp mise run test:logged -- --name full-test -- mise run test`
  (a private `TMPDIR`, to find leaked test directories), default reservations.
- **Aggregate result:** exit 1 after 973.5 s of test groups. Backend: 11,718
  passed, 142 skipped, 5 failed across 11,865 tests in 703 files (867.63 s).
  Web: one file's worker was killed (SIGKILL). Root and agent-support: 3,472
  passed, 2 failed. Bridges, desktop, protocol, toolchain, CLI and web-public
  passed.
- **Evidence:** `/tmp/ork0023-full-tmp/orkestrator-test-run.CCTMJZ/` on
  omarchy-hp (workspace and root `.log.gz`, `summary.json`).

| Owning file | Failing test | Aggregate failure | Complete unchanged owner alone |
| --- | --- | --- | --- |
| `apps/backend/src/core/commands-project-creation.test.ts` | `create_project_from_scratch > serializes two requests for the same canonical path` | `A project already uses this local path` (161.86 ms). | Passed (7.4 s). |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `raw StorageDatabase writers outside StorageService > name the store they write` | Five-second timeout (5,549.65 ms). | Passed (4.9 s). |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | `executable document policy in chromium > through the shell, every self-navigation, popup, form and redirect reaches the sink zero times` | Chromium frame load (4,304.25 ms). Recurrence of [0672](../design-canvas-and-artifacts/0000-index.md). | Passed (50.4 s). |
| `apps/backend/src/core/transcript-artifacts/preview-interactive.test.ts` | `interactive preview in Chromium > resource escape > the sink detects requests from a deliberately unrestricted page` | `setting frame content, waiting until "load"` (3,496.04 ms). Recurrence of [0672](../design-canvas-and-artifacts/0000-index.md). | Passed (32.5 s). |
| `apps/backend/src/core/opencode-coordinator-research-live.test.ts` | `OpenCode coordinator research servers > registers a research server and allows exactly its tools` | 40-second deadline (40,005.77 ms). Recurrence of [0785](../coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md). | Failed twice, then passed (2.3 s); see 0785. |
| `apps/web/src/components/projects/CoordinatorPanel.test.tsx` | whole file | `worker crashed: SIGKILL`. | Passed (3.8 s). |
| `tests/unit/release/release-desktop.test.ts` | `release checkout guards > rejects a mismatching remote annotated tag despite a matching local tag` | The git fixture command exited non-zero with empty stderr (73.38 ms). | Passed (1.4 s). |
| `tests/unit/flaky-tests-index.test.ts` | `environments-and-containers index lists every case file …` | Not a flake: `main` at `93018933` had two cases numbered 0887, one without its metadata lines. `main` has since renumbered it [0953](../environments-and-containers/0953-container-rebuild-dialog-after-reload.md); passes after rebasing. | Passed. |

Rerun commands (one isolated Bun worker each; the backend ones ran without
the Node preload except the OpenCode case, which needs it):

```sh
mise run test:logged -- --name rerun-commands-project-creation -- bun test --cwd=apps/backend ./src/core/commands-project-creation.test.ts --parallel=1
mise run test:logged -- --name rerun-storage-writer-guards -- bun test --cwd=apps/backend ./src/core/storage-writer-guards.test.ts --parallel=1
mise run test:logged -- --name rerun-content-server.engines -- bun test --cwd=apps/backend ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1
mise run test:logged -- --name rerun-preview-interactive -- bun test --cwd=apps/backend ./src/core/transcript-artifacts/preview-interactive.test.ts --parallel=1
mise run test:logged -- --name rerun-coordinator-panel -- bun test --cwd apps/web ./src/components/projects/CoordinatorPanel.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name rerun-release-desktop -- bun test ./tests/unit/release/release-desktop.test.ts --parallel=1 --only-failures
```

- **Assessment:** load-induced timeouts and a worker kill on a shared host,
  plus one deterministic register defect inherited from `main` (since fixed
  on `main`). No
  implementation, assertion, deadline or skip changed for the flakes.
