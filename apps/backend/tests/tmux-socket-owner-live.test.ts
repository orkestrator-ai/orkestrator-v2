/**
 * Real tmux servers against the unreachable-socket census (to-do 7020 task 1).
 *
 * A local environment move failed with `claude-tmux cleanup incomplete`
 * whenever no tmux server listened on the backend's socket and any other tmux
 * process ran on the host. The census these cases feed is limited to the
 * servers this file starts, so other work on the host cannot change the result.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { confirmTmuxSessionGone, type ExecOutput } from "../src/core/tmux-shared";

// A case can run several subprocesses, each bounded to 10 seconds.
setDefaultTimeout(60_000);

const NAMESPACE = ["--user", "--map-root-user", "--net"];

function run(args: string[]) {
  return spawnSync(args[0]!, args.slice(1), { encoding: "utf8", timeout: 10_000 });
}

const hasTmux = run(["tmux", "-V"]).status === 0;
const canUnshare =
  process.platform === "linux" && run(["unshare", ...NAMESPACE, "--mount", "true"]).status === 0;

/** Real exec, except that the census lists only the servers given. */
function execWithCensus(pids: number[]) {
  return async (args: string[]): Promise<ExecOutput> => {
    if (args[0] === "ps") {
      return { status: 0, stdout: pids.map((pid) => `${pid} tmux: server`).join("\n"), stderr: "" };
    }
    const result = run(args);
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
}

describe.skipIf(process.platform !== "linux" || !hasTmux)("unreachable tmux socket census", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function scratchDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ork-tmux-owner-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  /** Starts a server with `prefix` (empty, or an `unshare` wrapper) and returns its pid. */
  function startServer(prefix: string[], socket: string): number {
    const started = run([
      ...prefix,
      "sh",
      "-c",
      'tmux -S "$1" new-session -d -s owner "sleep 600" && tmux -S "$1" display-message -p "#{pid}"',
      "sh",
      socket,
    ]);
    expect(started.status).toBe(0);
    const pid = Number(started.stdout.trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    // The server this test started, by the pid it reported.
    cleanups.push(() => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    });
    return pid;
  }

  /** What `tmux list-sessions` says for a socket nothing listens on. */
  function unreachable(socket: string): string {
    const listed = run(["tmux", "-S", socket, "list-sessions"]);
    expect(listed.status).not.toBe(0);
    return listed.stderr;
  }

  test("a server on another socket does not keep this socket contested", async () => {
    const dir = scratchDir();
    const pid = startServer([], path.join(dir, "decoy"));
    const diagnostic = unreachable(path.join(dir, "default"));
    expect(await confirmTmuxSessionGone(diagnostic, execWithCensus([pid]))).toBe(true);
  });

  test("a live server whose socket file was deleted still blocks", async () => {
    const socket = path.join(scratchDir(), "default");
    const pid = startServer([], socket);
    unlinkSync(socket);
    const diagnostic = unreachable(socket);
    expect(diagnostic).toContain("No such file or directory");
    expect(await confirmTmuxSessionGone(diagnostic, execWithCensus([pid]))).toBe(false);
  });

  test.skipIf(!canUnshare)(
    "a server in a container-like namespace with its own /tmp is ruled out",
    async () => {
      const dir = scratchDir();
      const pid = startServer(
        [
          "unshare",
          ...NAMESPACE,
          "--mount",
          "sh",
          "-c",
          'mount -t tmpfs tmpfs /tmp && exec "$@"',
          "sh",
        ],
        "/tmp/inner",
      );
      const diagnostic = unreachable(path.join(dir, "default"));
      expect(await confirmTmuxSessionGone(diagnostic, execWithCensus([pid]))).toBe(true);
    },
  );

  test.skipIf(!canUnshare)(
    "a server in another network namespace that shares the directory stays a possible owner",
    async () => {
      const dir = scratchDir();
      const pid = startServer(["unshare", ...NAMESPACE], path.join(dir, "other"));
      const diagnostic = unreachable(path.join(dir, "default"));
      expect(await confirmTmuxSessionGone(diagnostic, execWithCensus([pid]))).toBe(false);
    },
  );
});
