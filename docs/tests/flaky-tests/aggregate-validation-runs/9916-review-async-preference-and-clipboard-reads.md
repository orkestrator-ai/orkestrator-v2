# Review assertions race asynchronous preference and clipboard completion

- **ID:** 9916
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Base commit:** `60c065c366e65ffc7d7cc1fb32e4c4517fc661ac`
- **Review head:** `bfdc17ffa9635c914a038b2ea387c0fd86dfa9fe`
- **Original command:** `mise run test:logged -- --name review-tests -- mise run test`
- **Workers:** repository default concurrent aggregate, Linux x86_64, Bun 1.4.4.
- **Evidence:** `/tmp/orkestrator-test-run.z2tD5X/` (workspace, root and bridge compressed logs).

## Observations

`GlobalSettings > copies the current web client URL`,
`tests/unit/components/GlobalSettings.test.tsx:737`, could not find the button
named `Web client URL copied` (189.54 ms). The root group reported
4,281 pass, one skip, one fail. Its unchanged complete owner passed in 9.7 s:
`mise run test:logged -- --name review-global-settings-test-env -- env -u NODE_ENV bun test ./tests/unit/components/GlobalSettings.test.tsx --parallel=1 --only-failures`.

`session lifecycle > persists no metadata for a session with neither plan mode nor a client key`,
`bridges/claude-bridge/src/services/session-manager-lifecycle.test.ts:281`,
expected undefined preferences but read a `turnInFlight` marker. Claude reported
1,897 pass, seven skip and one fail. Its unchanged complete owner passed in
0.6 s:
`mise run test:logged -- --name review-claude-lifecycle-isolated -- env -u NODE_ENV bun test --cwd bridges/claude-bridge ./src/services/session-manager-lifecycle.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.

Passing isolated counts were not retained. The native-tab failure from the
same run is recorded separately in [6561](../native-agents-and-transcripts/6561-native-tab-unrelated-field-render-count.md).

## Resolution (2026-11-10)

**Root cause:** the clipboard mock records its call before the component's
awaited handler updates React state; waiting for the call alone does not wait
for the copied button. Claude's best-effort preference writes similarly outlive
`sendPrompt`. Waiting for them exposed a second bug: clearing the last marker
wrote an empty preference object instead of removing the empty file.

**Fix:** await the copied button itself; settle queued preference writes before
asserting their result. Preference merges now remove an empty row under their
existing per-file lock, preserving concurrent real preferences, including false.
New preference tests cover last-marker cleanup and concurrent preference retention.

**Reproduced:** Claude's empty-file defect reproduced after adding the write
barrier (40 pass, one fail, received `{}`; `/tmp/orkestrator-test-run.2xGsxA/fix-claude-lifecycle.log.gz`).
The clipboard failure was observed in the aggregate; a controlled pre-fix
reproduction was not established, so its evidence is weaker.

**Verification:**
- `mise run test:logged -- --name fix-settings-copy -- env -u NODE_ENV bun test ./tests/unit/components/GlobalSettings.test.tsx --parallel=1 --only-failures` passed (10.5 s).
- `mise run test:logged -- --name fix-claude-preferences -- env -u NODE_ENV bun test --cwd bridges/claude-bridge ./src/services/session-manager-lifecycle.test.ts ./src/services/session-preferences.test.ts --preload ../../tests/setup-node.ts --parallel=2 --only-failures` passed (1.2 s).

No timeout was increased and no assertion was skipped.
