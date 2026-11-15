// A hang watchdog, not an assertion.
//
// Bun's own default budget is five seconds per test and hook. Most of this
// suite's tests finish in milliseconds when they run alone, but the aggregate
// runs many workers on a shared host, and a test that is merely starved of CPU
// (a real subprocess, a Radix focus hand-off, a SQLite fixture) can spend the
// whole five seconds queued rather than working. The flake registry holds well
// over a hundred such cases: each passes alone and fails only when the host is
// slow, which says nothing about the code under test.
//
// So the default is generous enough that a slow host never fails a test that
// is making progress, while a test that is genuinely stuck still fails (after
// a minute, not five seconds). It is only a floor against hangs: what a test
// asserts must still be decided by an explicit signal (an event, a promise, a
// controlled timer) and never by how long the host took. A file that needs a
// different budget sets its own with `setDefaultTimeout`, or a test with the
// third argument of `test`; both take precedence over this.
//
// Two limits of a preload, both observed on Bun 1.4.4:
// - It overrides `bun test --timeout`, which a preload cannot see reliably.
//   Set a different budget in the file instead.
// - Bun resets the default for each file it loads into the same process, so
//   the preload's value reaches only the first file of a non-isolated run
//   (`bun test a.test.ts b.test.ts`, or any `--rerun-each`). Every suite
//   script runs `--parallel`, which isolates files; add `--isolate` to an ad
//   hoc multi-file or `--rerun-each` run to keep the floor for every file.
import { setDefaultTimeout } from "bun:test";

export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
