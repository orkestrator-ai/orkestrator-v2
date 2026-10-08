# Cursor image-draft chips disappear during mobile checks in the full browser suite

- **ID:** 0186
- **Status:** open
- **Date observed:** 2026-10-08
- **Tests:** `a saved image draft survives reload and the autosave after it (assigned cursor tab)` and `a saved image draft survives reload and the autosave after it (pre-session picker with cursor selected, attachment only)`
- **File:** `e2e/agent-testing/native-draft-attachments.spec.ts:104`
- **Original command:** `mise run test:logged -- --name agent-browser -- mise run test:agent:browser:isolated`
- **Worker configuration:** One Playwright worker against a disposable fixture profile; the repository aggregate was also running.
- **Failure:** The `Remove draft-image.png` chip was absent at the narrow-viewport visibility/in-viewport assertions (lines 347–348), after the 5000 ms assertion deadline.
- **Suite counts:** Full browser run: 17 passed, 4 failed, 10 skipped (31 total). The other failures concerned file-tree test navigation (subsequently fixed) and design export (also fails alone).
- **Isolated rerun:** All six cases in the owning file passed in 137.0 seconds, exit 0:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-file-tree-708a-review \
ORKESTRATOR_AGENT_TEST_RUN_ID=qa-file-tree-drafts-rerun \
  mise run test:logged -- --name drafts-rerun -- \
  mise run test:agent:browser -- e2e/agent-testing/native-draft-attachments.spec.ts
```

The rerun used a separate credential-free fixture profile provisioned with Codex,
matching the one-shot profile's agent selection. It ran no model turns.

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.3MDFmC/agent-browser.log.gz`.

Both failures occurred after switching to the mobile layout. The isolated pass
establishes intermittent behavior, but does not identify whether a delayed mount,
a draft-state update or another interaction caused the chip to disappear. No
assertion, timeout or skip was changed.
