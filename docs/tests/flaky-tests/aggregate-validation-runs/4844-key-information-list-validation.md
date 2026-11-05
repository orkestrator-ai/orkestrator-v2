# Key information list repair validation

- **ID:** 4844
- **Status:** open
- **Observed:** 2026-11-05 at `76e0fef73`

`mise run test:logged -- --name address-default -- mise run test` waited
about 1,258 s for host capacity (workspace six slots, root one, bridges two).
The outer runner stopped at 1,800 s before workspace completion. Bridges
and the protocol lockfile passed. Root: 3,592 passed, five failed, one error
across 182 files, 422.94 s executing. The five failures exceeded 5,000 ms:

| Owner and exact test | Aggregate duration | Complete owner rerun |
| --- | --- | --- |
| `tests/unit/module-import-cycles.test.ts`: backend and bridge module import cycles > the backend and bridge module graphs are acyclic | 6,617.18 ms | Passed, 6.9 s |
| `tests/unit/dark-mode-theme.test.ts`: forced dark mode theming > no component draws its own focus ring instead of the shared hairline | 6,852.78 ms | Passed, 5.2 s |
| `tests/unit/mcp-fixture-cleanup.test.ts`: MCP fixture cleanup contract > every test importing createFixture from MCP test-support awaits or returns cleanup | 6,754.58 ms | Failed twice: 7,793.35 ms and 7,599.60 ms; 2 pass, 1 fail each |
| `tests/unit/raw-console.test.ts`: raw console > no linted source holds a raw console site | 12,740.20 ms | Failed twice: 8,613.93 ms and 14,197.72 ms; 31 pass, 1 fail each |
| `tests/unit/codex-app-server-protocol.test.ts`: generator binary resolution > a nonexistent CODEX_PROTOCOL_BINARY fails instead of falling back | 5,002.89 ms, then expected exit 1, received 143 | Passed, 8.2 s; recurrence in case 1180 |

Each complete owner rerun used:

```sh
mise run test:logged -- --name address-<owner> -- bun test ./tests/unit/<owner>.test.ts --parallel=1 --only-failures
```

Owners were `module-import-cycles`, `dark-mode-theme`, `mcp-fixture-cleanup`,
`raw-console`, and `codex-app-server-protocol`. Final scan rerun labels were
`address-mcp-cleanup-final` and `address-raw-console-final`. Only the three
passing owner reruns establish flakes in this observation. The scan timeouts
and incomplete aggregate remain unresolved; no environmental exemption is claimed.
Scheduling contention is a hypothesis. No assertions, deadlines or skips changed.

Evidence below shares `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`:

- `orkestrator-test-run.bQqjCL/address-default.log.gz` (aggregate outer timeout).
- `orkestrator-test-run.cRDXEd/root-and-agent-support-tests.log` (root failures and totals).
- `orkestrator-test-run.cRDXEd/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (unfinished workspace).
- `orkestrator-test-run.8aEsCv/address-mcp-fixture-cleanup.log.gz`.
- `orkestrator-test-run.nHQqpR/address-raw-console.log.gz`.
- `orkestrator-test-run.NMfJIY/address-mcp-cleanup-final.log.gz`.
- `orkestrator-test-run.qnUMCA/address-raw-console-final.log.gz`.

Passing owner logs were removed by the logged runner. The original preparation
artifacts remain unchanged. The unrelated-area browser failures from preparation
remain undetermined, not excused: GitHub setup polling (mobile) and Settings
Debug spacing (desktop and mobile); no branch changes reach those features.
