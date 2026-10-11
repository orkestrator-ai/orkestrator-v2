# container firewall policy > firewall uses stored domains and tolerates a repeated GitHub bootstrap range

- **ID:** 0187
- **Status:** open
- **Date observed:** 2026-10-12
- **Owning file:** `tests/unit/firewall-policy.test.ts:269`
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name shell-fixtures -- bun test ./tests/unit/migrate-copy.test.ts ./tests/unit/firewall-policy.test.ts ./tests/unit/firewall-refresh.test.ts ./tests/unit/test-diagnostic-bounds.test.ts --parallel=1 --only-failures`
- **Worker configuration:** one isolated Bun worker; the repository suite and browser suite were also running on this host.
- **Failure:** `expect(result.exitCode).toBe(0)` received `null`, followed by Bun's five-second test timeout at 5003.69 ms and `killed 1 dangling process`.
- **Suite counts:** 48 total, 47 passed, 1 failed; 35.50 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.esofJy/shell-fixtures.log.gz`
- **Isolated rerun:** the same `PATH` prefix with `mise run test:logged -- --name firewall-policy-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed in 13.2 seconds.
- **Hypothesis:** this shell-fixture case exceeded its outer five-second budget while other validation commands were running. The owning file passed with the same GNU tool selection on its isolated rerun. Concurrent load is a possible contributor, but the root cause has not been established. The terminal-toolbar change does not modify the firewall or its fixtures.
