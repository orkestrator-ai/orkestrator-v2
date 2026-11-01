import { describe, expect, test } from "bun:test";
import {
  COMMAND_FAILURE_REASONS,
  type CommandFailureReason,
} from "../log-vocabulary/command-failure-reasons.js";
import { classifyCommandFailure, type CommandFailureOptions } from "./command-failure-reason.js";

function failure(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { stdout: "", exitCode: 1, ...fields });
}

type Sample = [error: unknown, options?: CommandFailureOptions];
const git = { tools: ["git"] } as const;
const gh = { tools: ["gh"] } as const;
const docker = { tools: ["docker"] } as const;
const tmux = { tools: ["tmux"] } as const;

/** One real shape per reason. A reason nothing can produce fails the coverage test. */
const SAMPLES: Readonly<Record<CommandFailureReason, Sample>> = {
  "timed-out": [failure("Command timed out after 5 ms", { timedOut: true, exitCode: null })],
  aborted: [failure("Command aborted", { timedOut: true, aborted: true, exitCode: null })],
  killed: [failure("ignored output", { exitCode: null, signal: "SIGSEGV" })],
  "executable-missing": [failure("spawn git ENOENT", { executableMissing: true, exitCode: null })],
  "output-too-large": [failure("x".repeat(100), { outputLimitExceeded: true, exitCode: null })],
  "command-not-found": [failure("bash: line 1: foo: command not found", { exitCode: 127 })],
  "not-executable": [failure("", { exitCode: 126 })],
  "auth-failed": [
    failure("git@github.com: Permission denied (publickey).", { exitCode: 128 }),
    git,
  ],
  "network-failed": [
    failure("fatal: unable to access 'x': Could not resolve host: github.com", { exitCode: 128 }),
    git,
  ],
  "disk-full": [failure("write error: No space left on device")],
  "permission-denied": [failure("error: could not write config file: Permission denied")],
  "path-not-found": [failure("fatal: cannot change to '/x': No such file or directory")],
  "port-in-use": [failure("Bind for 0.0.0.0:80 failed: port is already allocated"), docker],
  "invalid-usage": [failure("usage: git branch [<options>]", { exitCode: 129 }), git],
  "branch-exists": [failure("fatal: a branch named 'x' already exists", { exitCode: 128 }), git],
  "branch-not-found": [failure("error: refname refs/heads/x not found", { exitCode: 128 }), git],
  "invalid-ref": [failure("fatal: 'a..b' is not a valid branch name", { exitCode: 128 }), git],
  "ref-conflict": [
    failure("error: 'refs/heads/a' exists; cannot create 'refs/heads/a/b'", { exitCode: 128 }),
    git,
  ],
  "lock-held": [
    failure("fatal: Unable to create '/w/.git/index.lock': File exists.", { exitCode: 128 }),
    git,
  ],
  "not-a-repository": [failure("fatal: not a git repository (or any parent)"), git],
  "worktree-conflict": [failure("fatal: 'x' is already checked out at '/w'"), git],
  "merge-conflict": [failure("CONFLICT (content): Merge conflict in a.txt"), git],
  "dirty-worktree": [failure("error: Your local changes to a.txt would be overwritten"), git],
  "nothing-to-commit": [failure("nothing to commit, working tree clean"), git],
  "push-rejected": [failure("! [rejected] main -> main (non-fast-forward)"), git],
  "remote-ref-missing": [failure("fatal: couldn't find remote ref refs/heads/x"), git],
  "no-remote": [failure("fatal: 'origin' does not appear to be a git repository"), git],
  "dubious-ownership": [failure("fatal: detected dubious ownership in repository at '/w'"), git],
  "identity-unknown": [failure("Please tell me who you are."), git],
  "rate-limited": [failure("HTTP 403: API rate limit exceeded"), gh],
  forbidden: [failure("HTTP 403: Resource not accessible by integration"), gh],
  "resource-not-found": [failure("GraphQL: Could not resolve to a Repository"), gh],
  "no-pull-request": [failure("no pull requests found for branch x"), gh],
  "pull-request-exists": [failure("a pull request for branch x already exists"), gh],
  "server-error": [failure("HTTP 502: Bad Gateway"), gh],
  "daemon-unavailable": [failure("Cannot connect to the Docker daemon at unix:///x"), docker],
  "daemon-error": [failure("docker: unrecognised failure", { exitCode: 125 }), docker],
  "container-not-found": [failure("Error response from daemon: No such container: abc"), docker],
  "container-not-running": [failure("Error: container abc is not running"), docker],
  "container-name-conflict": [failure('The container name "/x" is already in use'), docker],
  "image-not-found": [failure("Unable to find image: pull access denied for x"), docker],
  "server-not-running": [failure("no server running on /tmp/tmux-0/default"), tmux],
  "session-not-found": [failure("can't find session: x"), tmux],
  "session-exists": [failure("duplicate session: x"), tmux],
  unclassified: [failure("something nobody has seen", { exitCode: 3 })],
};

describe("classifyCommandFailure", () => {
  test("every reason in the vocabulary has a way to be produced", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(COMMAND_FAILURE_REASONS).sort());
  });

  test.each(Object.entries(SAMPLES))("%s", (reason, [error, options]) => {
    expect(classifyCommandFailure(error, options).reason).toBe(reason as CommandFailureReason);
  });

  test.each([
    [
      "ERROR: Repository not found.\nfatal: Could not read from remote repository.",
      git,
      "no-remote",
    ],
    ["fatal: repository 'https://example.test/repo' not found", git, "no-remote"],
    ["error: could not lock config file .git/config: File exists", git, "lock-held"],
    ["error: could not lock config file .git/config: Permission denied", git, "permission-denied"],
    ["no open pull requests in owner/repo", gh, "no-pull-request"],
    ["failed to connect to server", tmux, "server-not-running"],
    ["no sessions", tmux, "server-not-running"],
    [
      "error connecting to /tmp/tmux-501/default (No such file or directory)",
      tmux,
      "server-not-running",
    ],
    ["error connecting to /tmp/tmux-501/default (Connection refused)", tmux, "server-not-running"],
    ["error connecting to /tmp/tmux-501/default (Permission denied)", tmux, "permission-denied"],
    ["error connecting to api.github.com", gh, "network-failed"],
    ["error connecting to api.github.com", undefined, "network-failed"],
    [
      "error connecting to /tmp/tmux-501/default (Permission denied)",
      undefined,
      "permission-denied",
    ],
    ["no sessions", gh, "unclassified"],
    ["no open pull requests in owner/repo", git, "unclassified"],
    ["duplicate session: fixture", git, "unclassified"],
    [
      "fatal: Authentication failed\nerror: failed to push some refs to 'https://example.test/repo'",
      git,
      "auth-failed",
    ],
    [
      "fatal: Could not resolve host: example.test\nerror: failed to push some refs to 'https://example.test/repo'",
      git,
      "network-failed",
    ],
    ["error: failed to push some refs to 'https://example.test/repo'", git, "unclassified"],
    ["! [remote rejected] main -> main (protected branch)", git, "push-rejected"],
  ] as const)("diagnostic: %s", (message, options, reason) => {
    expect(classifyCommandFailure(failure(message), options).reason).toBe(reason);
  });

  test("a large Buffer stderr matches its bounded tail, excluding discarded head and middle", () => {
    const stderr = Buffer.from(
      `fatal: a branch named 'x' already exists\n${"x".repeat(32 * 1024)}\nfatal: not a git repository`,
    );
    const error = failure("ignored", { stderr });
    expect(stderr.length).toBeGreaterThan(16 * 1024);
    expect(classifyCommandFailure(error, git)).toEqual({
      reason: "not-a-repository",
      exitCode: 1,
      signal: null,
    });
    Object.assign(error, {
      stderr: Buffer.from(`fatal: a branch named 'x' already exists\n${"x".repeat(32 * 1024)}`),
    });
    expect(classifyCommandFailure(error, git).reason).toBe("unclassified");
  });

  test("the result is only the label, the exit code and the signal", () => {
    const marker = "PRIVATE-MARKER";
    for (const [error, options] of Object.values(SAMPLES)) {
      const withOutput = Object.assign(error as Error, {
        message: `${(error as Error).message} ${marker}`,
        stdout: marker,
        stderr: `${marker} ${(error as Error).message}`,
        cmd: marker,
        spawnargs: [marker],
      });
      const result = classifyCommandFailure(withOutput, options);
      expect(Object.keys(result).sort()).toEqual(["exitCode", "reason", "signal"]);
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });

  test("an unknown failure falls back with its exit code and signal", () => {
    expect(classifyCommandFailure(failure("odd", { exitCode: 3, signal: null }))).toEqual({
      reason: "unclassified",
      exitCode: 3,
      signal: null,
    });
  });

  test("an odd signal value is not copied, since it could hold anything", () => {
    const result = classifyCommandFailure(failure("odd", { signal: "PRIVATE text" }));
    expect(result.signal).toBeNull();
    expect(result.reason).toBe("unclassified");
  });

  test("reads a raw child-process error's numeric code and stderr", () => {
    const raw = Object.assign(new Error("Command failed: git status"), {
      code: 128,
      stderr: Buffer.from("fatal: not a git repository"),
    });
    expect(classifyCommandFailure(raw, git)).toEqual({
      reason: "not-a-repository",
      exitCode: 128,
      signal: null,
    });
  });

  test("the argv in a Command failed line cannot read as the failure", () => {
    const named = failure("Command failed: git branch -m -- permission-denied no-space-left");
    expect(classifyCommandFailure(named, git).reason).toBe("unclassified");
  });

  test("a killed process is reported as killed, whatever it last wrote", () => {
    const error = failure("fatal: not a git repository", { exitCode: null, signal: "SIGKILL" });
    expect(classifyCommandFailure(error, git)).toMatchObject({
      reason: "killed",
      signal: "SIGKILL",
    });
  });

  test("a timeout wins over the output captured before it", () => {
    const error = failure("fatal: not a git repository", { timedOut: true });
    expect(classifyCommandFailure(error, git).reason).toBe("timed-out");
  });

  test("exit codes are the named tool's own, so another tool's do not apply", () => {
    expect(classifyCommandFailure(failure("", { exitCode: 4 }), gh).reason).toBe("auth-failed");
    expect(classifyCommandFailure(failure("", { exitCode: 4 }), git).reason).toBe("unclassified");
    expect(classifyCommandFailure(failure("", { exitCode: 4 })).reason).toBe("unclassified");
    expect(classifyCommandFailure(failure("", { exitCode: 125 })).reason).toBe("unclassified");
  });

  test("output beats an exit code that says less", () => {
    const error = failure("fatal: a branch named 'x' already exists", { exitCode: 129 });
    expect(classifyCommandFailure(error, git).reason).toBe("branch-exists");
  });

  test("a call site can say what an exit code means for its one command", () => {
    const error = failure("some checks are pending", { exitCode: 8 });
    expect(classifyCommandFailure(error, { tools: ["gh"] }).reason).toBe("unclassified");
    expect(
      classifyCommandFailure(error, { tools: ["gh"], exitCodes: { 8: "server-error" } }).reason,
    ).toBe("server-error");
  });

  test("a docker exec of git reads both tools, docker's own failure first", () => {
    const tools = { tools: ["docker", "git"] } as const;
    expect(classifyCommandFailure(failure("No such container: abc"), tools).reason).toBe(
      "container-not-found",
    );
    expect(
      classifyCommandFailure(failure("fatal: a branch named 'x' already exists"), tools),
    ).toEqual(expect.objectContaining({ reason: "branch-exists" }));
  });

  test("no tools named reads every tool's text, as the print backstop needs", () => {
    expect(classifyCommandFailure(failure("no server running on /x")).reason).toBe(
      "server-not-running",
    );
  });

  test("the cause is found past a huge output, and matching stays bounded", () => {
    const noisy = failure(`${"x".repeat(5_000_000)}\nfatal: not a git repository`);
    const started = performance.now();
    expect(classifyCommandFailure(noisy, git).reason).toBe("not-a-repository");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test.each([
    ["a string", "fatal: not a git repository"],
    ["undefined", undefined],
    ["null", null],
    ["a plain object", { secret: "PRIVATE" }],
  ])("%s is not a command failure", (_label, value) => {
    const result = classifyCommandFailure(value, git);
    expect(result).toEqual({ reason: "unclassified", exitCode: null, signal: null });
  });

  test("an object whose getters throw still answers", () => {
    const hostile = new Proxy(new Error("m"), {
      get() {
        throw new Error("PRIVATE");
      },
    });
    expect(classifyCommandFailure(hostile, git)).toEqual({
      reason: "unclassified",
      exitCode: null,
      signal: null,
    });
  });
});
