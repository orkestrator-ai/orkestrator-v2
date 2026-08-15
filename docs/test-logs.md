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
