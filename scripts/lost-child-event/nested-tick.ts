/**
 * The standalone reproduction of Bun's lost child event (to-do 6900, task 3):
 * an awaited `expect(promise).resolves` or `.rejects` in `bun test` drops the
 * completion of another child that is finishing at the same moment. Nothing
 * from this repository's runtime: `node:child_process` with `stdio: "pipe"`,
 * the strict probe (`probe.ts`) and `bun:test`.
 *
 *   LOST_CHILD_PROBE_OUT=/abs/out.jsonl \
 *     bun test ./scripts/lost-child-event/nested-tick.ts
 *
 * Each iteration spawns two `true` children, waits for the first to close,
 * then waits on a promise in the way `LOST_CHILD_NESTED_MODE` names:
 *
 * - `rejects` (default): `await expect(run(["false"])).rejects.toThrow()`.
 * - `resolves`: `await expect(run(["true"])).resolves.toBeUndefined()`.
 * - `sleep`: `await expect(Bun.sleep(1)).resolves.toBeUndefined()`, which
 *   spawns nothing.
 * - `plain`: `await run(["false"]).catch(...)`, the control: the same work
 *   without `expect`.
 *
 * `LOST_CHILD_NESTED_ITERATIONS` (default 300) and `LOST_CHILD_NESTED_OTHERS`
 * (children started beside the first, default 1; 0 is the second control)
 * vary the run. The probe prints a `LOST_CLOSE` record for each child whose
 * `close` never came and a `SUMMARY` at the end.
 *
 * Bun's `expect(...).resolves` and `.rejects` settle the promise by running
 * the event loop from inside the current callback (`waitForPromise`). The
 * nested tick overwrites the outer tick's list of ready polls, so the outer
 * dispatch skips the rest of its batch. A child's stdout and stderr readers
 * are one-shot polls, already disarmed by `epoll_wait`, so a skipped EOF is
 * never seen again: the kernel reports the socket at EOF (`IN|HUP`), Bun's
 * registration is disarmed (`40000000`, `EPOLLONESHOT` with no `EPOLLIN`) and
 * the JS stream waits, flowing and empty, forever. Bun 1.4.4 describes this
 * re-entry above `PROCESS_POLL_ONE_SHOT` in `src/spawn/process.rs` and made
 * the Linux pidfd level-triggered for it, which is why Linux loses `close`
 * and not `exit`; macOS watches the process with `EV_ONESHOT`, so there a
 * dropped event is the child's exit. On beelink2 (Linux, Bun 1.4.4) `rejects`
 * lost 42 of 900 children and `plain` none; see to-do 6900 for the table.
 *
 * Not named `.test.ts`, so no suite runs it; pass its path to `bun test`.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { holdUntilClosed, openFds, track } from "./probe";

const MODES = ["rejects", "resolves", "sleep", "plain"] as const;
type Mode = (typeof MODES)[number];

function mode(): Mode {
  const value = process.env.LOST_CHILD_NESTED_MODE ?? "rejects";
  if (!(MODES as readonly string[]).includes(value))
    throw new Error(`LOST_CHILD_NESTED_MODE must be one of ${MODES.join(", ")}`);
  return value as Mode;
}

function count(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
  return value;
}

/** Spawns on pipes, reads both outputs, settles on `close` as the old `runCommand` did. */
function run(argv: string[]): Promise<void> {
  const before = openFds();
  const child = spawn(argv[0]!, argv.slice(1), { stdio: "pipe" });
  track(child, argv, before);
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  child.on("error", () => undefined);
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

test("an awaited expect(promise).resolves/rejects drops another child's close", async () => {
  const selected = mode();
  const iterations = count("LOST_CHILD_NESTED_ITERATIONS", 300);
  const others = count("LOST_CHILD_NESTED_OTHERS", 1);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const first = run(["true"]);
    // Not awaited: a lost `close` would hang the test. The probe reports it.
    for (let index = 0; index < others; index++) run(["true"]).catch(() => undefined);
    await first;
    if (selected === "rejects") await expect(run(["false"])).rejects.toThrow();
    else if (selected === "resolves") await expect(run(["true"])).resolves.toBeUndefined();
    else if (selected === "sleep") await expect(Bun.sleep(1)).resolves.toBeUndefined();
    else await run(["false"]).catch(() => undefined);
  }
  await holdUntilClosed(Number(process.env.LOST_CHILD_PROBE_HOLD_MS ?? 7_000));
}, 300_000);
