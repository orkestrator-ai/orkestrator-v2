# Sidebar bulk delete counted a CPU read as a write

- **ID:** 10003
- **Status:** resolved
- **Date observed:** 2026-11-19
- **Base:** `5e9835d0a6981a8d2c217d8941e2e065abbe3008`.
- **Reviewed commit:** `8b97a1130c7b862bbbeed76750ae061dca4d2470`.
- **Test:** `bulk actions > Delete confirms by machine, reaches each owner, and clears the selection` in `apps/web/src/components/sidebar/HierarchicalSidebar.cross-machine-selection.test.tsx`.
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`. The aggregate ran the web package with two isolated Bun workers and reported 15,595 passed, 10 skipped and three failed.
- **Failure:** At 876.58 ms, a `get_system_usage` request from the new tile appeared in the expected-empty list of writes before deletion confirmation.
- **Isolated rerun:** The aggregate runner reran the owning file with one worker. All 23 tests passed in 6.7 s.
- **Fix:** The helper uses the shared routing classifier to count only writes. The test now sends a CPU read while the confirmation dialog is open and still requires an empty mutation list before confirmation.
- **Evidence:** Preparation’s workspace and isolated logs are in the host temporary directory under `orkestrator-test-run.MY1DI8`.
