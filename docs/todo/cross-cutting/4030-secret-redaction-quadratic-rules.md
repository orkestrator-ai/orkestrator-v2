# Two secret-redaction rules are quadratic on one long line

## Task analysis

Analysed 2026-11-03 against `main` at `b88623136`.

### Tasks

1. **Make the URL-userinfo rule linear**: stop the scheme rule in `redactSecrets` retrying from every character of a long run. Status: open.
2. **Make the `key=value` rule linear**: stop the credential-assignment rule backtracking over long `word-word-word` runs. Status: open.
3. **Pin the cost with a test**: a 64 KiB pathological line redacts in bounded time. Status: open (depends on 1 and 2).

### 1. Make the URL-userinfo rule linear

**Problem.** `redactSecrets` (`packages/protocol/src/secret-redaction.ts`)
takes about 0.6–0.9 s on one 64 KiB line made only of `[a-z0-9+.-]`
characters, such as a run of `x` or of `a.`. Every redaction caller runs on
the event loop: the local bridge stdout relay (`createBridgeOutputForwarder`,
which redacts chunks of up to 64 KiB with no newline), container log tails
(`boundDiagnosticTail`, since security finding I7), and the bridges that
redact provider diagnostics. A bridge or a container log that prints one
such line stalls the backend for that long each time.

**Context.** Found while fixing the tail-redaction half of I7
(`docs/reports/2-26-10-27-security.md`). `boundDiagnosticTail` cuts its input
to `DIAGNOSTIC_TAIL_MAX_BYTES` (64 KiB) before redacting, so its worst case is
bounded at roughly that cost, but the cost itself was left alone, because the
I7 ticket kept the change inside `container-log-bounds.ts`.

**Investigation.** Measured with Bun 1.4.4 on beelink, 64 KiB of `x`:
`/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi` takes 936 ms. The
pattern has no anchor, so the engine starts at every character, consumes
the rest of the run with `[a-z0-9+.-]*`, fails to find `://` and backtracks:
O(n²). Adding the lookbehind `(?<![a-z0-9+.-])` before the group, so a match
may start only at the beginning of a run, took 0.1 ms on the same input and
matches the same URLs, because a scheme cannot start mid-run anyway.

**Decisions.**

- **How to make it linear?**
  - **Lookbehind at the start of the scheme (recommended).**
    - Pros: one-token change; the same matches for real URLs; measured
      linear.
    - Cons: lookbehind needs a modern engine (every runtime here has one).
  - **Pre-filter on `://` and run the rule only on lines that contain it.**
    - Pros: skips almost every log line.
    - Cons: a line with `://` and a long run still pays the quadratic cost.

### 2. Make the `key=value` rule linear

**Problem.** The credential-assignment rule
(`\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|…|authorization))("?\s*[:=]\s*)…`)
takes about 1 s on 64 KiB of `a-a-a-…`.

**Context.** The leading `(?:[A-Za-z0-9]+[_-])*` is there on purpose: it lets
`OPENAI_API_KEY` match, because `\b` does not fire between `_` and `API`. The
comment above the rule explains why.

**Investigation.** `\b` matches before every `a` in `a-a-a-…`, and from each
start the repeated group walks to the end of the run before failing: O(n²).
On 64 KiB of `x` it takes 0.2 ms, so only `[_-]`-separated runs are
affected. With the lookbehind proposed below, the same `a-a-a-…` input took
1.3 ms, and `OPENAI_API_KEY=abcdefgh1234` still became
`OPENAI_API_KEY=[redacted]`.

**Decisions.**

- **How to make it linear?**
  - **Anchor the start to the beginning of an identifier run (recommended).**
    Add `(?<![A-Za-z0-9_-])` before the group, so a match starts only where
    the identifier starts.
    - Pros: keeps the `OPENAI_API_KEY` behaviour; small change.
    - Cons: needs the existing redaction tests and the auth canaries to
      confirm that nothing stops matching.
  - **Match the key name separately (find `[:=]`, then look back at the
    identifier).**
    - Pros: linear by construction.
    - Cons: a rewrite of the rule's logic; a larger review surface.

### 3. Pin the cost with a test

**Problem.** Nothing stops a later rule from being quadratic again.

**Context.** Timing tests are flake-prone under parallel load.

**Investigation.** The pathological inputs above take about 1 s now. Each
rule, fixed on its own, took 1.3 ms or less on them; the whole
`redactSecrets` pass with both fixes has not been measured.

**Decisions.**

- **How to test it?**
  - **A generous ceiling (recommended).** Redact 64 KiB of each pathological
    input and require under 250 ms.
    - Pros: catches a return to quadratic cost; the gap leaves room for a
      loaded CI host.
    - Cons: still a timing test.
  - **No test; review only.**
    - Pros: no flake risk.
    - Cons: the regression is invisible until a bridge stalls the backend.

## Related

- `docs/reports/2-26-10-27-security.md`, finding I7.
- `apps/backend/src/core/container-log-bounds.ts` (`boundDiagnosticTail`).
- `apps/backend/src/core/bridge-output-redaction.ts`.
