# Git fsmonitor follow-ups (0735) review validation

- **ID:** 1322
- **Status:** resolved
- **Date observed:** 2026-10-30
- **Branch:** `todo-0735-git-fsmonitor-follow-ups-9b3c131c7412`
- **Preparation head:** `6d34731589e2d1442e4e03eeaefe9821890dd3a7`

Preparation's `mise run test` failed in seven unchanged owners. Format, lint
and full typechecking passed. The review fixes extend checkout confirmation
fallback and add caller-level timeout regressions; none of the owners below
was modified, and no assertion, timeout or skip was loosened.

Preparation evidence is in
`.orkestrator/review-artifacts/review-validation-d410c6c9-66cb-4271-a736-c27884e20289/validation-04.stdout.txt`.
Complete owner reruns used the repository's logged runner and `--parallel=1`:

| Owner | Preparation failure | Focused rerun |
| --- | --- | --- |
| `apps/backend/src/core/storage-writer-guards.test.ts` | Raw-writer scan exceeded 5 s (reported 10,026.54 ms). | Passed with the other two backend owners in 14.4 s. Existing [1309](../backend-services-and-tooling/1309-storage-writer-guard-raw-scan-timeout.md). |
| `apps/backend/src/core/multi-review-graph-evaluation.test.ts` | An unnamed test exceeded 5 s. | Passed in the same backend run. |
| `apps/backend/src/core/commands-registry-coordinator.test.ts` | Concurrent build starts rejected with `Associated build pipeline was not found`. | Passed in the same backend run. Recurrence of [1307](1307-temp-directory-cleanup-0247-review-validation.md). |
| `apps/web/src/App.test.tsx` | Failed while retaining a healthy Docker snapshot after an outage-confirmation request failed. | Complete unchanged owner passed separately in 11.8 s. |
| `apps/web/src/lib/chat/rich-markdown/incremental-parse.test.tsx` | Long streamed answer parse exceeded 5 s. | Passed in the 22.9 s web-owner run. Recurrence of [1307](1307-temp-directory-cleanup-0247-review-validation.md). |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | Maximal-list filtering saw an extra projection read. | Passed in the same web run. Existing [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | Over-limit root-change approval exceeded 5 s. | Still timed out (6,230.70 ms); this occurrence is not classified as flaky. Existing isolated failure in [1285](1285-stale-local-preview-worker-validation.md). Evidence: `/tmp/orkestrator-test-run.9HDXqo/`. |

The logged commands were:

```sh
mise run test:logged -- --name fsmonitor-preparation-backend-owners -- bun test --cwd apps/backend ./src/core/storage-writer-guards.test.ts ./src/core/multi-review-graph-evaluation.test.ts ./src/core/commands-registry-coordinator.test.ts --parallel=1 --only-failures
mise run test:logged -- --name fsmonitor-preparation-web-owners -- bun test --cwd apps/web ./src/App.docker-availability.test.tsx ./src/lib/chat/rich-markdown/incremental-parse.test.tsx ./src/components/native-agent/AgentNativeTab.commands.test.tsx ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name fsmonitor-preparation-app-owner -- bun test --cwd apps/web ./src/App.test.tsx --parallel=1 --only-failures
```

The first web command named a nonexistent App split file; it ran the other
three complete owners (71 passed, one failed). The corrected App command ran
the complete real owner and passed.

Changed-area validation passed: all 67 tests across the four caller owners,
backend source/test typechecking, focused lint and repository formatting.
The exact preparation command was then rerun through the logged wrapper:

```sh
mise run test:logged -- --name fsmonitor-preparation-full-rerun -- mise run test
```

It passed (exit 0, 913.1 s), including workspace, root/agent-support, bridges
and the Codex protocol lockfile check. The run waited 574.1 s for the
host-wide aggregate lease before executing. The earlier root-change approval
owner timeout remains evidence of the existing issue; its unchanged test
passed in this final default-suite run. No browser or live-agent suite was
required for these backend Git changes.

Merge reconciliation (2026-10-31): renumbered from 1316 to 1322 because main
already assigned 1316 to the container start poll validation report. The original
evidence and resolved status are unchanged.
