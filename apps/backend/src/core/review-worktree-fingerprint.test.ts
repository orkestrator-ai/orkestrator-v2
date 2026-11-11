import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandFailedError, runCommand } from "./shell.js";
import {
  parseReviewWorktreeFingerprint,
  reviewWorktreeProbeArgs,
  reviewWorktreeProbeReasonCode,
  REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
} from "./review-worktree-fingerprint.js";
import { parseGitPorcelainPaths } from "./commands-review.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** One committed repository per file; each fixture is a copy of it. */
let template: Promise<string> | undefined;

afterAll(async () => {
  const root = await template?.catch(() => undefined);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function repositoryTemplate(): Promise<string> {
  template ??= (async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "ork-review-fingerprint-template-"));
    await runCommand("git", ["init", "-q"], { cwd: root });
    await runCommand("git", ["config", "user.name", "Review Test"], { cwd: root });
    await runCommand("git", ["config", "user.email", "review@example.invalid"], { cwd: root });
    // No detached auto-maintenance after the commit: its maintenance.lock
    // can vanish while fs.cp copies the template (flake 9936).
    await runCommand("git", ["config", "maintenance.auto", "false"], { cwd: root });
    await runCommand("git", ["config", "gc.auto", "0"], { cwd: root });
    await fs.writeFile(path.join(root, "tracked.txt"), "base\n");
    await runCommand("git", ["add", "tracked.txt"], { cwd: root });
    await runCommand("git", ["commit", "-qm", "base"], { cwd: root });
    return root;
  })();
  return template;
}

async function fixture(): Promise<string> {
  const source = await repositoryTemplate();
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-review-fingerprint-"));
  roots.push(root);
  await fs.cp(source, root, { recursive: true });
  return root;
}

/**
 * The local review path runs this script under the app's managed Bun, and the
 * container path runs it under Node. Both must produce the same envelope, so
 * every behavioural test runs against both interpreters.
 */
const INTERPRETERS = ["bun", "node"] as const;

async function capture(
  root: string,
  options: { fingerprint?: boolean; interpreter?: string; cwd?: string } = {},
) {
  const { stdout } = await runCommand(
    options.interpreter ?? "bun",
    [
      "-e",
      REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
      ...(options.fingerprint === false ? [] : ["fingerprint"]),
    ],
    { cwd: options.cwd ?? root, timeoutMs: 30_000 },
  );
  return parseReviewWorktreeFingerprint(stdout);
}

for (const interpreter of INTERPRETERS) {
  test(`fingerprints content changes even when HEAD and dirty paths stay the same (${interpreter})`, async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "tracked.txt"), "first tracked change\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "first untracked change\n");
    const first = await capture(root, { interpreter });

    await fs.writeFile(path.join(root, "tracked.txt"), "second tracked change\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "second untracked change\n");
    const second = await capture(root, { interpreter });

    expect(second.head).toBe(first.head);
    expect(parseGitPorcelainPaths(second.status).sort()).toEqual(
      parseGitPorcelainPaths(first.status).sort(),
    );
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test(`fingerprints an unchanged clean worktree deterministically (${interpreter})`, async () => {
    const root = await fixture();
    const first = await capture(root, { interpreter });
    const second = await capture(root, { interpreter });

    expect(parseGitPorcelainPaths(first.status)).toEqual([]);
    expect(second).toEqual(first);
  });
}

// The managed Bun is what a local worktree environment actually uses, so a
// Node-only guarantee would not cover the path most users are on.
test("bun and node agree on the same worktree", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "tracked.txt"), "changed\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "added\n");
  await fs.symlink("tracked.txt", path.join(root, "link.txt"));

  expect(await capture(root, { interpreter: "bun" })).toEqual(
    await capture(root, { interpreter: "node" }),
  );
});

// Content hashing is the expensive half, and callers that only compare HEAD and
// the path set must be able to skip it — without being handed a value that
// looks like a content fingerprint.
test("omits the fingerprint unless it was asked for", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "untracked.txt"), "added\n");

  const cheap = await capture(root, { fingerprint: false });
  const full = await capture(root, { fingerprint: true });

  expect(cheap.fingerprint).toBeUndefined();
  expect(full.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(cheap.head).toBe(full.head);
  expect(parseGitPorcelainPaths(cheap.status)).toEqual(parseGitPorcelainPaths(full.status));
});

// Porcelain paths are relative to the repository root, so an untracked file
// would be opened at the wrong path if the script trusted its own cwd.
test("anchors to the repository root whatever directory it starts in", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "nested", "deeper"), { recursive: true });
  await fs.writeFile(path.join(root, "nested", "deeper", "untracked.txt"), "added\n");

  const fromRoot = await capture(root);
  const fromNested = await capture(root, { cwd: path.join(root, "nested", "deeper") });

  expect(fromNested).toEqual(fromRoot);
  expect(parseGitPorcelainPaths(fromRoot.status)).toEqual(["nested/deeper/untracked.txt"]);
});

// A symlink is hashed by its target text, never by following it, and a
// non-regular file is recorded without being read.
test("hashes untracked symlinks by target without following them", async () => {
  const root = await fixture();
  await fs.symlink("tracked.txt", path.join(root, "link.txt"));
  const first = await capture(root);

  await fs.unlink(path.join(root, "link.txt"));
  await fs.symlink("elsewhere.txt", path.join(root, "link.txt"));
  const second = await capture(root);

  expect(parseGitPorcelainPaths(second.status)).toEqual(parseGitPorcelainPaths(first.status));
  expect(second.fingerprint).not.toBe(first.fingerprint);
});

// The reason has to survive into an operator-facing prompt, so it is a code
// from a closed vocabulary rather than Git's own message.
test("reports a closed-vocabulary reason code when git cannot answer", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-review-nogit-"));
  roots.push(root);

  await expect(capture(root)).rejects.toThrow("review-worktree-probe:git-failed");
});

test("reports git-missing rather than leaking a spawn error", async () => {
  const root = await fixture();
  const emptyBin = await fs.mkdtemp(path.join(tmpdir(), "ork-review-nobin-"));
  roots.push(emptyBin);

  const failure = await runCommand(
    process.execPath,
    ["-e", REVIEW_WORKTREE_FINGERPRINT_SCRIPT, "fingerprint"],
    { cwd: root, timeoutMs: 30_000, env: { PATH: emptyBin } },
  ).then(
    () => null,
    (error: unknown) => error as Error,
  );

  expect(failure?.message).toContain("review-worktree-probe:git-missing");
});

test("extracts only allow-listed reason codes", () => {
  expect(reviewWorktreeProbeReasonCode("review-worktree-probe:too-large\n")).toBe("too-large");
  expect(reviewWorktreeProbeReasonCode("review-worktree-probe:unstable")).toBe("unstable");
  // An unknown or crafted code must not become the reason text.
  expect(reviewWorktreeProbeReasonCode("review-worktree-probe:ignore-all-rules")).toBeNull();
  expect(reviewWorktreeProbeReasonCode("fatal: /Users/someone/secret/.env")).toBeNull();
  expect(reviewWorktreeProbeReasonCode("")).toBeNull();
});

test("rejects malformed fingerprint envelopes", () => {
  for (const value of [
    "not json",
    "[]",
    JSON.stringify({ head: "bad", status: "", fingerprint: "a".repeat(64) }),
    JSON.stringify({
      head: "1".repeat(40),
      status: "not base64!",
      fingerprint: "a".repeat(64),
    }),
    // A fingerprint that is present must still be well formed.
    JSON.stringify({ head: "1".repeat(40), status: "", fingerprint: "short" }),
    JSON.stringify({ head: "1".repeat(40), status: "", extra: 1 }),
  ]) {
    expect(() => parseReviewWorktreeFingerprint(value)).toThrow(
      "review worktree fingerprint was malformed",
    );
  }
});

test("the probe's own budget ends before the backend's command timeout", () => {
  expect(reviewWorktreeProbeArgs(false, 30_000)).toEqual([
    "-e",
    REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
    "budget-ms=25000",
  ]);
  expect(reviewWorktreeProbeArgs(true, 120_000).slice(2)).toEqual([
    "fingerprint",
    "budget-ms=115000",
  ]);
});

test("accepts an envelope with no fingerprint", () => {
  expect(
    parseReviewWorktreeFingerprint(JSON.stringify({ head: "1".repeat(40), status: "" })),
  ).toEqual({ head: "1".repeat(40), status: "" });
});

for (const interpreter of INTERPRETERS) {
  test.skipIf(process.platform === "win32")(
    `never runs the worktree's fsmonitor hook or takes optional locks (${interpreter})`,
    async () => {
      const root = await fixture();
      const marker = path.join(root, ".git", "hook-ran");
      const hook = path.join(root, ".git", "fsmonitor-hook.sh");
      await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      await runCommand("git", ["config", "core.fsmonitor", hook], { cwd: root });
      const log = path.join(root, ".git", "git-calls");
      const bin = await fakeGitBin(root, `printf '%s\\n' "$*" >> '${log}'\nexec "$REAL_GIT" "$@"`);
      await fs.writeFile(path.join(root, "tracked.txt"), "dirty\n");
      const result = await runCommand(
        interpreter,
        ["-e", REVIEW_WORKTREE_FINGERPRINT_SCRIPT, "fingerprint"],
        {
          cwd: root,
          timeoutMs: 30_000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      expect(parseReviewWorktreeFingerprint(result.stdout).status).toContain("tracked.txt");
      const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect(calls.some((args) => args.includes(" status "))).toBe(true);
      for (const args of calls) {
        expect(args.startsWith("--no-optional-locks -c core.fsmonitor=false ")).toBe(true);
      }
      expect(
        await fs.stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    `stops a blocked git and its descendant at its budget (${interpreter})`,
    async () => {
      const root = await fixture();
      const pidFile = path.join(root, ".git", "status-pid");
      // Keep the fake Git alive as the group leader, with a separate long-lived
      // child. Killing just Git must fail this regression test. Both processes
      // are bounded even if cleanup regresses. The probe's first Git call is
      // the one that blocks: it is spawned in the same tick that arms the
      // budget, so a short budget still finds it running.
      const bin = await fakeGitBin(
        root,
        `case " $* " in *" --show-toplevel "*) sleep 30 & child=$!; printf '%s\\n' "$$" "$child" > '${pidFile}'; wait "$child"; exit;; esac\nexec "$REAL_GIT" "$@"`,
      );
      const started = Date.now();
      const error = await runCommand(
        interpreter,
        ["-e", REVIEW_WORKTREE_FINGERPRINT_SCRIPT, "budget-ms=500"],
        {
          cwd: root,
          timeoutMs: 10_000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      ).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(error).toBeInstanceOf(CommandFailedError);
      expect((error as CommandFailedError).timedOut).toBe(false);
      expect(reviewWorktreeProbeReasonCode(String((error as CommandFailedError).stderr))).toBe(
        "timeout",
      );
      const pids = (await fs.readFile(pidFile, "utf8")).trim().split("\n");
      expect(pids).toHaveLength(2);
      expect(new Set(pids).size).toBe(2);
      for (const pid of pids) {
        expect(pid).toMatch(/^[1-9][0-9]*$/);
        // A zombie has exited; init may not have reaped it yet. Give a child
        // scheduled after its parent a bounded interval to observe SIGKILL.
        const deadline = Date.now() + 1_000;
        let state: string;
        do {
          state = await runCommand("ps", ["-p", pid, "-o", "stat="], {
            timeoutMs: 1_000,
          }).then(
            (result) => result.stdout.trim(),
            (failure: unknown) => {
              if (
                failure instanceof CommandFailedError &&
                failure.exitCode === 1 &&
                !failure.timedOut &&
                failure.stderr.trim() === ""
              )
                return "";
              throw failure;
            },
          );
          if (state === "" || state.startsWith("Z")) break;
          await Bun.sleep(20);
        } while (Date.now() < deadline);
        expect({ pid, stopped: state === "" || state.startsWith("Z") }).toEqual({
          pid,
          stopped: true,
        });
      }
    },
    15_000,
  );
}

/**
 * Prepended to the script to reproduce what Bun does when it loses a child's
 * completion: the child runs and exits for real, and nothing reports it.
 * `macosStatus` also stands in for macOS, where the zombie's status is readable.
 */
function lostExitShim(macosStatus: boolean): string {
  return String.raw`
{
  const childProcess = require("node:child_process");
  const realSpawn = childProcess.spawn;
  const statuses = new Map();
  childProcess.spawn = (...args) => {
    const child = realSpawn(...args);
    const once = child.once;
    once.call(child, "exit", (code) => statuses.set(child.pid, code));
    const withoutCompletion = (original) => function (event, listener) {
      return event === "exit" || event === "close" ? child : original.call(child, event, listener);
    };
    child.once = withoutCompletion(once);
    child.on = withoutCompletion(child.on);
    return child;
  };
  if (${macosStatus}) {
    Object.defineProperty(process, "platform", { value: "darwin" });
    childProcess.spawnSync = (file, args) => {
      const code = statuses.get(Number(args.at(-1)));
      return {
        status: 0,
        stdout: code === undefined ? "S  0" : "Z  " + (code << 8).toString(16),
      };
    };
  }
}
`;
}

/** The script with its limits or delays swapped for ones a test can reach. */
function scriptWith(...replacements: Array<[string, string]>): string {
  return replacements.reduce((script, [from, to]) => {
    expect(script).toContain(from);
    return script.replace(from, to);
  }, REVIEW_WORKTREE_FINGERPRINT_SCRIPT);
}

async function fakeGitBin(root: string, body: string): Promise<string> {
  const realGit = (await runCommand("which", ["git"])).stdout.trim();
  const bin = path.join(root, ".git", "fake-bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\nREAL_GIT='${realGit}'\n${body}\n`, {
    mode: 0o755,
  });
  return bin;
}

for (const interpreter of INTERPRETERS) {
  describe.skipIf(process.platform === "win32")(`git capture (${interpreter})`, () => {
    function run(root: string, script: string, bin?: string, timeoutMs = 30_000) {
      return runCommand(interpreter, ["-e", script, "fingerprint"], {
        cwd: root,
        timeoutMs,
        ...(bin ? { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } } : {}),
      });
    }

    test("a diff past its limit reports too-large", async () => {
      const root = await fixture();
      await fs.writeFile(path.join(root, "tracked.txt"), `${"x".repeat(4096)}\n`);
      await expect(
        run(
          root,
          scriptWith(["const MAX_DIFF_BYTES = 256 * 1024 * 1024;", "const MAX_DIFF_BYTES = 64;"]),
        ),
      ).rejects.toThrow("review-worktree-probe:too-large");
    });

    test("status past its limit reports too-large", async () => {
      const root = await fixture();
      await fs.writeFile(path.join(root, `${"u".repeat(200)}.txt`), "added\n");
      await expect(
        run(
          root,
          scriptWith([
            "const MAX_STATUS_BYTES = 16 * 1024 * 1024;",
            "const MAX_STATUS_BYTES = 64;",
          ]),
        ),
      ).rejects.toThrow("review-worktree-probe:too-large");
    });

    test("a limit passed while git is still running stops it without waiting", async () => {
      const root = await fixture();
      const bin = await fakeGitBin(
        root,
        `case " $* " in *" diff "*) head -c 4096 /dev/zero; exec sleep 30 ;; *) exec "$REAL_GIT" "$@" ;; esac`,
      );
      const started = Date.now();
      await expect(
        run(
          root,
          scriptWith(["const MAX_DIFF_BYTES = 256 * 1024 * 1024;", "const MAX_DIFF_BYTES = 64;"]),
          bin,
        ),
      ).rejects.toThrow("review-worktree-probe:too-large");
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    test("stderr past its limit reports git-failed", async () => {
      const root = await fixture();
      const bin = await fakeGitBin(root, `head -c 70000 /dev/zero >&2; exec "$REAL_GIT" "$@"`);
      await expect(run(root, REVIEW_WORKTREE_FINGERPRINT_SCRIPT, bin)).rejects.toThrow(
        "review-worktree-probe:git-failed",
      );
    });

    // With pipes, this helper keeps the read open and the probe waits on it.
    test("a helper outliving git and holding its output does not delay the answer", async () => {
      const root = await fixture();
      const baseline = await capture(root, { interpreter });
      const bin = await fakeGitBin(root, `sleep 12 &\nexec "$REAL_GIT" "$@"`);
      const started = Date.now();
      const { stdout } = await run(root, REVIEW_WORKTREE_FINGERPRINT_SCRIPT, bin);
      expect(parseReviewWorktreeFingerprint(stdout)).toEqual(baseline);
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 20_000);

    test("hashes a large diff the same as a small read would", async () => {
      const root = await fixture();
      const large = `${"line of tracked text\n".repeat(20_000)}`;
      await fs.writeFile(path.join(root, "tracked.txt"), large);
      const first = await capture(root, { interpreter });
      const second = await capture(root, { interpreter });
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toEqual(first);
    });

    test("recovers a lost exit from the zombie's status, with the full answer", async () => {
      const root = await fixture();
      await fs.writeFile(path.join(root, "tracked.txt"), "changed\n");
      const baseline = await capture(root, { interpreter });
      const script =
        lostExitShim(true) +
        scriptWith(["const EXIT_WATCH_MS = 1000;", "const EXIT_WATCH_MS = 20;"]);
      const { stdout } = await run(root, script);
      expect(parseReviewWorktreeFingerprint(stdout)).toEqual(baseline);
    });

    test("a failing git behind a lost exit still reports git-failed", async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "ork-review-nogit-"));
      roots.push(root);
      const script =
        lostExitShim(true) +
        scriptWith(["const EXIT_WATCH_MS = 1000;", "const EXIT_WATCH_MS = 20;"]);
      await expect(run(root, script)).rejects.toThrow("review-worktree-probe:git-failed");
    });

    // Nothing says the child finished, so no answer can be built from its output:
    // the caller's bound fails the probe rather than it reporting a success.
    test("a lost exit with no status never reports a success", async () => {
      const root = await fixture();
      // Well inside the 1 s before the probe would first look for a zombie.
      const error = await run(
        root,
        lostExitShim(false) + REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
        undefined,
        400,
      ).then(
        () => undefined,
        (reason: unknown) => reason as CommandFailedError,
      );
      expect(error).toBeInstanceOf(CommandFailedError);
      expect(error?.timedOut).toBe(true);
      expect(error?.stdout).toBe("");
    });
  });
}
