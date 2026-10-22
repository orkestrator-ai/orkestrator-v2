# `opencode-client getSessionMessages > falls back to string conversion when circular tool payloads cannot be serialized` (`apps/web/src/lib/opencode-sessions.test.ts`)

- **ID:** 0031
- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:** `bun run test:logged -- --name web-pkg-final -- bun run --cwd apps/web test`
- **Worker configuration:** the `apps/web` package script ran its own Bun worker
  pool over 232 files while an unrelated `apps/backend` package run was executing
  concurrently on the same host, so both pools were competing for cores.
- **Failure:** the case was reported failed after 10,245.23 ms — the shape of a
  budget overrun rather than an assertion, and roughly 240x the duration of the
  isolated run below.
- **Suite counts:** 5,385 passed, 1 skipped, 1 failed; 16,695 `expect()` calls
  across 232 files in 43.17 s.
- **Isolated rerun:** `bun --cwd=apps/web test src/lib/opencode-sessions.test.ts --parallel=2`
  -> 54 passed, 0 failed. The target passed.
- **Attribution:** observed while changing setup-tab retirement in
  `apps/web/src/components/terminal/TerminalContainer.view.tsx` and the setup
  session snapshot in `apps/backend/src/core/commands-registry-environments.ts`.
  Neither file is imported by `opencode-sessions.ts` or its test, and the same
  file passed in the immediately preceding full-suite run of the same commit
  (`bun run test`, workspace group status 0). The two share only host capacity.
- **Hypothesis:** the case builds a deliberately circular tool payload and
  drives the serializer's failure path, so its cost is CPU-bound rather than
  I/O-bound and it degrades directly with host contention. A recurrence should
  record the case's duration under a quiet host before touching the budget; a
  genuine regression in the fallback would fail on the assertion rather than at
  a timeout.
