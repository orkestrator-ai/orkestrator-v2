# Test diagnostics, logs, and retention

The test infrastructure bounds diagnostics at their source and owns the log
lifecycle. Use the repository runners instead of adding an unbounded `tee` file
for every command.

## Why this exists

On 2026-08-15 a failed Bun assertion received a live Happy DOM element:

```ts
expect(screen.queryByRole("button", { name: /Context window/ })).toBeNull();
```

Bun formatted the reachable document, window, React fiber tree, props, event
listeners, styles, and caches. Five failures created a 1.35 GB aggregate log;
an isolated file run produced 2.05 GB and spent more than fifteen minutes mostly
serializing diagnostics. A broader `/private/tmp` audit later found 1,584
`orkestrator-*.log` files occupying 28.06 GiB.

The assertion bug and the amplification were separate problems. Tests still
need useful failure evidence, but no matcher, console call, process buffer, or
retained artifact is allowed to grow without a byte or count bound.

## Standard commands

The aggregate runner streams each group to a private file and retains only a
bounded tail in memory:

```bash
bun run test       # complete non-iOS suite
bun run test:all   # complete suite, including iOS when Xcode is available
```

Use the logged wrapper for a focused test, typecheck, build, smoke test, or
Playwright suite:

```bash
bun run test:logged -- --name web-typecheck -- bun run --cwd apps/web typecheck

bun run test:logged -- --name terminal-container -- \
  bun --cwd=apps/web test 'src/components/terminal/TerminalContainer*.test.tsx' \
  --parallel=2 --only-failures

bun run test:logged -- --name agent-browser -- \
  bun run test:agent:browser
```

The wrapper preserves the child exit status. Do not wrap these commands in a
second `tee`: that duplicates every byte in the terminal harness and another
file without adding evidence.

## Diagnostic bounds

`tests/setup.ts` installs the shared browser-test diagnostics, while
`tests/setup-node.ts` installs the DOM-free console bounds for backend,
desktop-script, CLI, and protocol workers:

- Testing Library DOM snapshots are capped at 2,000 bytes.
- Routine `console.log`, `console.info`, and `console.debug` output is suppressed.
  Set `ORKESTRATOR_TEST_VERBOSE_CONSOLE=1` for bounded local investigation.
- Console warnings/errors, strings, collections, objects, and DOM nodes are
  summarized with explicit byte, item, key, and depth limits.
- DOM nodes are rendered as a short tag/role/label/text summary rather than a
  traversable Happy DOM object.
- `ORKESTRATOR_TEST_RAW_CONSOLE=1` is an emergency local escape hatch. Do not
  use it in aggregate or CI runs.

Node-only package scripts preload `tests/setup-node.ts` directly. This avoids
loading Happy DOM and React into backend, desktop-script, CLI, and protocol
workers that do not need a browser. Bridge discovery still runs from the root
configuration because it spans multiple packages.

Negative DOM assertions must reduce the received value to a primitive:

```ts
expect(screen.queryByRole("button", { name: /Context window/ }) === null).toBe(true);
```

Do not pass a live DOM result from `queryBy*`, `querySelector`, `closest`, or a
similar DOM-producing query directly to `toBeNull()`. The
`test-diagnostic-bounds` canary scans the repository AST for these patterns and
runs intentionally failing browser and Node-only fixtures to prove emitted
diagnostics remain bounded. `scripts/rewrite-bounded-dom-assertions.ts` is the
codemod for new legacy occurrences.

## Runner limits and artifacts

Each command group has these defaults:

| Resource | Limit / policy |
| --- | --- |
| Persisted output per group | 64 MiB; the child is terminated if exceeded |
| In-memory/console failure tail | 256 KiB |
| File permissions | log `0600`, directory `0700` |
| Passing run | raw group logs deleted; small `summary.json` retained |
| Failing run | raw group logs streamed through gzip level 1, then deleted |
| Completed-run retention | 7 days |

Artifacts live in uniquely created `orkestrator-test-run.*` directories below
the platform temporary directory (`$TMPDIR`, which is not necessarily `/tmp`).
Cleanup accepts only directories with the exact prefix and a valid versioned
sentinel; it never uses a broad glob. Completed runs expire from the
`summary.json` timestamp, while interrupted runs without a summary expire from
the sentinel creation timestamp. Recent active or interrupted runs remain
available for diagnosis.

The aggregate runner prints the failure artifact directory. The focused runner
does the same on failure. Inspect compressed evidence with bounded reads, for
example:

```bash
ORK_TEST_ARTIFACT_DIR=/path/printed/by/the/runner
gzip -cd "$ORK_TEST_ARTIFACT_DIR/root-and-agent-support-tests.log.gz" \
  | tail -n 200
```

`ORKESTRATOR_TEST_MAX_OUTPUT_BYTES` can lower the per-group safety limit for a
specialized environment. `ORKESTRATOR_TEST_LOG_DIR` may direct a run to an
explicit private directory, but callers then own that directory and must not
point multiple concurrent runs at it.

## Parallel scheduling

`scripts/test-all.ts` runs independent workspace, root, bridge, and protocol
groups concurrently. It caps aggregate Bun workers at 12, reserves two bridge
workers, limits Turbo to two active package tests, and gives remaining capacity
to the root long pole. On the 18-core reference host, six root workers completed
in 81.7 seconds versus 137.9 seconds at four workers. Package scripts use
`--only-failures` so successful assertion lines are not serialized.

iOS uses a shared simulator and runs alone. It is opt-in through `bun run
test:all`, keeping ordinary cross-platform validation independent of Xcode.

## Other bounded test artifacts

- Development Vite/Electron logs rotate at 4 MiB with one previous segment.
  Writes are serialized; rotation never reads the existing log into memory.
- Agent-testing artifact sanitization rejects and removes any regular file over
  16 MiB, or files beyond an artifact tree's 5,000-file / 256-MiB budget. Safe
  sibling evidence is still sanitized and retained. Trace archives are checked
  again after extraction; an unsafe trace is removed without deleting unrelated
  run artifacts.
- Routine renderer and Claude session-manager trace logging goes through debug
  gates and is absent from normal test output.

## Existing legacy logs

The runner does not claim or delete old manually named `/tmp/orkestrator-*.log`
files, because similarly named files can belong to another workspace or agent.
After recording any needed failure summary, remove only exact paths whose
ownership you have verified. Treat unexpectedly large UI logs as potentially
sensitive: recursive DOM diagnostics can contain rendered application state.

Flaky-test records still need the original command, worker configuration,
failure text, suite counts, and isolated rerun result. Those fit in the summary
and bounded failure artifact; multi-gigabyte object graphs are not useful
evidence.
