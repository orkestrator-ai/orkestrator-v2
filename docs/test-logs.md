# Test log size and retention

Test output captured with `tee` is the authoritative validation record, but a
single assertion failure can produce a surprisingly large file. This document
records an observed failure mode and the safeguards to apply without weakening
the complete-log requirement in
[`development/agent-testing.md`](development/agent-testing.md).

## Observed Bun and Happy DOM failure amplification

On 2026-08-15, validation at commit
`db9c458d1547efe323625d72496d44124cff1480` failed in the parameterized
`AgentNativeTab` context-window test. The assertion passed the result of
`screen.queryByRole(...)` directly to Bun's `toBeNull()` matcher:

```ts
expect(screen.queryByRole("button", { name: /Context window/ })).toBeNull();
```

The query returned a live Happy DOM `HTMLButtonElement`. Bun 1.3.14 rendered
that received value as part of the failure. Traversing the element reached the
Happy DOM document and window, React's fiber tree, component props and state,
event listeners, styles, and caches. Cycles did not make the traversal
infinite, but the reachable graph was large and contained many repeated views
of related state.

Five agent-platform cases failed. The full-suite log reached 1,348,424,954
bytes, and the isolated owning-file log reached 2,049,795,275 bytes. The
isolated run took 928.40 seconds for 54 tests, with most of that time spent
formatting and writing the five failure objects. These sizes describe the text
serialization, not the retained size of one DOM element and not application
payload generated in production.

The triggering behavior and the output amplification are separate problems:

- `NativeComposeBar` rendered the context wheel for `undefined` usage because
  its condition rejected `null` only, while the test expected no wheel until
  bounded usage arrived.
- Once the assertion received that unexpected element, Bun's generic object
  formatter produced the enormous diagnostic representation.
- `tee` did not create the amplification. It faithfully persisted everything
  the test runner wrote to stdout and stderr.

This is operationally significant even though it is test-only. It can consume
gigabytes of local or CI disk, monopolize a worker for minutes, exceed CI log or
artifact limits, hide useful diagnostics behind truncation, and in a more
constrained environment cause disk exhaustion.

## Preventing enormous DOM assertion output

Fix the underlying behavior or stale expectation first. Also make absence
assertions fail without handing a live DOM node to Bun's generic formatter. An
explicit guard is the most reliable form with the current test stack:

```ts
const contextButton = screen.queryByRole("button", { name: /Context window/ });
if (contextButton !== null) {
  throw new Error("Expected the context-window control to be absent");
}
```

A primitive assertion also bounds the received value, although it gives a less
descriptive failure:

```ts
expect(screen.queryByRole("button", { name: /Context window/ }) === null).toBe(true);
```

If `@testing-library/jest-dom` is adopted, its DOM-specific
`not.toBeInTheDocument()` matcher is the idiomatic alternative. Verify its
failure rendering under Bun before applying it broadly; the important property
is that a failed matcher must not ask Bun to print the raw Happy DOM object.

Bun's documented quiet/AI mode and dots reporter reduce successful-test noise,
but still preserve detailed failures. They therefore do not address this
failure-object expansion. A runner-level object-depth or output-byte cap would
be useful upstream, but repository assertions should remain safe without
depending on one.

Do not solve this by truncating the `tee` output or discarding the tail. The
saved log must continue to contain the command's complete output and final
summary. Bound the diagnostic at its source instead.

## How validation log files are created

The documented validation pattern redirects both output streams through
`tee`:

```bash
set -o pipefail
bun run test 2>&1 | tee /tmp/orkestrator-full-tests.log
```

Without `-a`, `tee` creates the named file or truncates an existing file, then
writes every byte it receives to both the terminal and that file. `pipefail`
preserves the test command's failure status; it does not change file retention.
Neither Bun, `tee`, nor the repository removes the file when the command exits.

Use a unique, descriptive path for each run so concurrent or subsequent runs do
not overwrite evidence. When local user separation matters, create logs with a
restrictive umask because ordinary `/tmp` files otherwise inherit the shell's
default permissions:

```bash
test_log="$(mktemp /tmp/orkestrator-full-tests.XXXXXX)"
chmod 600 "$test_log"
set -o pipefail
bun run test 2>&1 | tee "$test_log"
```

Do not include credentials, tokens, prompts, terminal contents, file contents,
or attachment data in test names or emitted diagnostics. A recursive DOM dump
can expose more rendered state than the failing control alone, so treat an
unexpectedly large UI-test log as potentially sensitive until inspected with
bounded reads.

## Retention and cleanup

On macOS, `/tmp` resolves to `/private/tmp`. It is an OS-managed temporary
location, but cleanup is eventual and is not a guarantee that a file disappears
when its test process, terminal, or agent finishes. Persistent CI runners have
the same concern unless their job lifecycle explicitly removes the files.

At the time of the incident, the two large files remained present and occupied
about 3.2 GiB together:

- `/tmp/orkestrator-full-tests-db9c458d.log`
- `/tmp/orkestrator-agent-native-tab-isolated-webcwd-db9c458d.log`

Logs live outside the repository and are not included in Git commits, but they
continue to consume disk until the OS or a user removes them. After a result has
been summarized and no further diagnosis needs the full record, remove only the
exact known log paths. Avoid broad `/tmp` globs or recursive cleanup because
other workspaces and agents may own similarly named files.

## Follow-up options

1. Correct the context-usage render condition or test contract that triggered
   the recorded failure.
2. Replace raw negative DOM assertions in failure-prone tests with bounded
   guards or verified DOM-specific matchers.
3. Consider a shared test helper for absence assertions so future failures
   cannot serialize live DOM graphs.
4. Add a validation-log lifecycle helper that creates mode-`0600`, uniquely
   named files, reports their size, and removes exact paths only after an
   explicit retention decision.
5. Report a minimal React plus Happy DOM reproduction to Bun and track whether
   a future formatter adds depth, property-count, or byte limits for received
   assertion values.
## Broader host measurements

`AGENTS.md` requires every test, typecheck, build, and smoke run to capture
complete stdout and stderr to a file, because tool and terminal buffers
truncate and must never be treated as the authoritative record. That
requirement is sound and this document does not argue against it.

What this document records is the measured cost of the current *form* of that
capture — unbounded verbatim stdout, one file per run, never pruned — and which
parts of those files are actually read when diagnosing a failure.

The following broader findings are from 2026-08-15 on a macOS development
machine with several agent sessions running suites concurrently against the
same clone. Nothing here has been implemented; the options in the last section
are proposals.

## Where the files live

| Location | What writes it | Observed size |
| --- | --- | --- |
| `/tmp/orkestrator-*.log` | The `tee` files `AGENTS.md` asks agents to write | **23 GB** total across all sessions |
| `/private/tmp/claude-501/<project-slug>/<session-id>/tasks/<task-id>.output` | Claude Code's own capture of each backgrounded command | **2.1 GB**, dominated by one 1.3 GB file |

A backgrounded `cmd 2>&1 | tee run.log` stores every byte **twice** — once in
`run.log` and once in the harness's `.output` file for that task.

Largest individual files observed: 1.9 GB, 1.9 GB, 1.8 GB (single test-file
runs), and several 1.3 GB full-suite runs.

## They are not cleaned up automatically

- `/tmp` is a symlink to `/private/tmp`.
- This machine has no `/etc/defaults/periodic.conf` and no `/etc/periodic.conf`
  override, so the BSD `daily_clean_tmps` job is not configured at all.
- Confirmed by observation: logs written on 2026-08-13 were still present on
  2026-08-15, on a host with an uptime of 2 days 19 hours.

In practice `/private/tmp` is cleared only by a reboot. Disk pressure was not
yet critical when measured (1.0 TiB free of 1.8 TiB, 44% used), but the 23 GB
is entirely dead weight and it grows with every run.

## What is inside a 1.29 GB full-suite log

Measured over `/tmp/orkestrator-fixes2-full-tests.log` (15,844,644 lines,
7,160 `(pass)` lines, 12 `(fail)` lines):

| Content | Size | Share |
| --- | --- | --- |
| React / happy-dom object dumps — `react-stack-top-frame`, React DEV stack traces, and `"N": [Getter],` repeated 191,090 times in the first 300 MB alone | 686.7 MB | 53.4% |
| Testing Library DOM dumps — rendered markup, `className=`, `aria-label=` | 301.7 MB | 23.5% |
| Application console output — `[TerminalContainer]`, `[session-manager]`, SDK `PATH` dumps | 296.1 MB | 23.0% |
| **`(pass)` / `(fail)` verdict lines** | **0.96 MB** | **0.07%** |

Reproduce with a single pass over any large log:

```bash
LOG=/tmp/some-run.log
awk '
  { b = length($0) + 1; total += b }
  /^[[:space:]]*<|className=|aria-label=|data-slot=|\[Function:|\[Symbol\(/ { dom += b; next }
  /\[[A-Za-z][A-Za-z0-9 _-]*\]/ { console_pfx += b; next }
  /\((pass|fail|skip)\)/ { verdict += b; next }
  { other += b }
  END {
    printf "total          : %10.1f MB\n", total/1048576
    printf "DOM dumps      : %10.1f MB  (%.1f%%)\n", dom/1048576, dom*100/total
    printf "app console    : %10.1f MB  (%.1f%%)\n", console_pfx/1048576, console_pfx*100/total
    printf "pass/fail lines: %10.2f MB  (%.2f%%)\n", verdict/1048576, verdict*100/total
    printf "everything else: %10.1f MB  (%.1f%%)\n", other/1048576, other*100/total
  }' "$LOG"
```

## Size tracks the failure mode, not the failure count

This is the part that makes the growth unpredictable:

- A run with **1** failing test (`ActionBar`, a missing-element assertion)
  produced a **3.4 MB** log.
- A run with **5** failing tests (`AgentNativeTab`, React render errors inside a
  `test.each` across five agent platforms) produced a **1.3 GB** log.

A single failure mode that throws inside `render` and prints React error objects
per case generates essentially the entire file. Green runs are small; one bad
red run is four hundred times larger than another red run.

## Which parts are actually read

During the review that produced these measurements, the following were read
from the logs:

- group summary lines and per-package pass/fail/skip counts,
- the `(fail)` lines,
- roughly forty lines of context around one failure,
- the full text of a `tsc` typecheck error (this one genuinely needed the file —
  the tool buffer had truncated it).

That is under 1 MB of a 1.3 GB file: about 7,200 useful lines out of 15.8
million. The remaining 99.9% has never been read by anyone.

This does not mean the capture is worthless. It means the *retention unit* is
wrong: what gets read is a summary plus a bounded window around each failure,
and that is what needs to survive.

## Options

Ranked by measured effect. None are implemented.

1. **Cap Testing Library DOM output.** `tests/setup.ts` currently calls no
   `configure()`, so the default `DEBUG_PRINT_LIMIT` of 7,000 characters applies
   to every failed query. Setting `DEBUG_PRINT_LIMIT` (for example 2,000), or
   overriding `getElementError` to omit the DOM entirely, removes most of the
   302 MB DOM share. One line in the shared setup — but note that `tests/setup.ts`
   is global to every suite, and this repository's guidance is explicit about how
   easily changes there leak across tests, so it needs its own verification pass.
2. **Bound React 19 DEV error-object logging.** This is the 687 MB bulk. A
   `console.error` filter in `tests/setup.ts` would remove it, but those stacks
   are occasionally the only diagnostic for a render-time failure. Prefer
   truncation over silencing.
3. **Compress the archive.** Measured at **12×** with `gzip -1` (a 200 MB slice
   compressed to 16.2 MB); the content is highly repetitive so a higher level
   would do better. Either compress after the run, or write both streams at once:

   ```bash
   set -o pipefail
   bun run test 2>&1 | tee >(gzip -1 > /tmp/run.log.gz) | grep -E '\(fail\)|Failing groups|error:'
   ```

   Read it later with `zgrep` / `zcat | tail`. This alone would take the current
   23 GB to roughly 2 GB with no loss of information.
4. **Stop double-writing in background tasks.** Redirect instead of `tee`
   (`cmd > run.log 2>&1`) when the command is backgrounded, since the harness is
   already capturing the same stream to its own `.output` file. Halves the cost.
5. **Two-tier retention, delete on green.** Always keep a few-KB summary
   (`grep -E '\(fail\)|Failing groups|[0-9]+ (pass|fail|skip)'`); keep the full
   log only while the run is red, and delete it once the result has been reported.
   Nothing prunes these files today, so retention has to be an explicit step.

Options 3, 4, and 5 are process changes and need no code. Option 1 is the only
one-line code change with a large effect.

## Interaction with the flake workflow

`docs/flaky-tests.md` requires the original command, worker configuration,
failure text, suite counts, and the isolated rerun result to be recorded for
every credible flake. All of that comes from the summary tier, not from the
object dumps. Compressing or pruning the full log does not weaken the flake
registry, provided the summary is captured before the full log is discarded.
