# Egress probe listener startup in the default aggregate

- **ID:** 5961
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `probe listeners serve only the fixed response, even from a directory containing files`
- **File:** `tests/unit/egress-gateway-qualification.test.ts:23`
- **Original command:** `mise run test:logged -- --name address-default-suite -- mise run test`, following commit `22506b26d`.
- **Worker configuration:** default concurrent aggregate; root group granted one worker, workspace five slots, bridges two slots, protocol lockfile one slot. Root output reports Bun 1.4.4 with `1x PARALLEL`.
- **Failure:** expected two ports, received zero after polling for the Python listener's ports file; test duration 2,266.70 ms.
- **Suite counts:** root and agent-support tests: 3,640 passed, 1 failed, 22,249 assertions across 3,641 tests in 185 files; 212.12 s execution time. Other aggregate groups had not all finished when this case was recorded.
- **Evidence:** root log in `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.yGrqlX/`, lines 197–211. The aggregate runner retains compressed failure output there when it finishes.
- **Isolated rerun:** `mise run test:logged -- --name address-egress-owner -- bun test tests/unit/egress-gateway-qualification.test.ts --parallel=1 --only-failures` passed the whole owning file, exit 0, in 7.2 s. Passing output was deleted by the runner.
- **Scope:** the test, `firewall-test-support.ts`, `scripts/egress-probe-server.py`, and `scripts/qualify-egress-gateway.sh` are unchanged in this native-tab selector branch.
- **Hypothesis:** the listener did not publish its ports within the polling window during the aggregate. The unchanged file passes alone; the child process's startup delay or failure cause was not established. Keep the assertions and investigate on recurrence.
