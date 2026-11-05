# CodexHostRules spec reads a startup log line as the fixture's origin

## Task analysis

Analysed 2026-11-05 against `main` at `1a66d95c3`. Found while checking E16's recorded browser failures; not part of E16's report.

### Tasks

1. **Make `e2e/CodexHostRules.spec.ts` find the fixture's origin**: it fails on both viewports. Status: open.

### 1. Make `e2e/CodexHostRules.spec.ts` find the fixture's origin

**Problem.** `managed-network card remembers a host, auto-answers and asks after removal` fails every time on desktop and mobile Chromium, waiting for "Approve network access".

**Context.** `beforeAll` spawns `e2e/fixtures/codex-host-rules-host.ts` and takes the first line of its stdout as the origin. The fixture builds a real `StorageService`, whose ledger set-up logs at info level (`ledger.moved`, `apps/backend/src/core/change-tracking/ledger-schema.ts`, added by `e8959f0fd`, #1810) before the fixture prints its URL. The first line is therefore `[storage] ledger.moved rows=0 durationMs=0`.

**Investigation.** Observed on 2026-11-05 on the E16 branch, whose diff does not touch that file, the spec or the fixture: running the fixture alone printed the storage line and then the URL. With a temporary edit that skipped lines not starting with `http://`, both viewports passed in 3.5 seconds; the edit was reverted. It was not run on `main`.

**Decisions.**

- **Where to fix it?**
  - **Have the spec take the first line that starts with `http://` (recommended).**
    - Pros: one line; the spec stops depending on what a real `StorageService` logs.
    - Cons: the fixture's stdout stays mixed.
  - **Configure the fixture's logger to stderr or silence before creating storage.**
    - Pros: the fixture's stdout means one thing.
    - Cons: every such fixture needs the same set-up, and a later stdout line would break it again.

## Related

- [6301](6301-log-controls-live-evidence.md)
