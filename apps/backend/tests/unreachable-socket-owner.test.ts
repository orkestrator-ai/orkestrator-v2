import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { confirmTmuxSessionGone, type ExecOutput } from "../src/core/tmux-shared";
import {
  TMUX_SOCKET_OWNER_PROBE,
  noProcessServesTmuxSocket,
  tmuxSocketPathFromMessage,
} from "../src/core/tmux-socket-owner";

const SOCKET = "/tmp/tmux-1000/default";

function answer(stdout: string, status = 0): ExecOutput {
  return { status, stdout, stderr: "" };
}

/** Runs argv for real, as the local tmux backend does. */
function realExec(args: string[]): Promise<ExecOutput> {
  const result = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", timeout: 10_000 });
  return Promise.resolve({
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
}

describe("tmuxSocketPathFromMessage", () => {
  test("reads the socket path from tmux's unreachable-socket diagnostics", () => {
    expect(
      tmuxSocketPathFromMessage(`error connecting to ${SOCKET} (No such file or directory)`),
    ).toBe(SOCKET);
    expect(
      tmuxSocketPathFromMessage("error connecting to /tmp/a b/default (Connection refused)"),
    ).toBe("/tmp/a b/default");
    expect(tmuxSocketPathFromMessage(`no server running on ${SOCKET}\n`)).toBe(SOCKET);
    // runCommand's error carries the command before tmux's own stderr.
    expect(
      tmuxSocketPathFromMessage(
        new Error(
          `Command failed: tmux list-sessions\nerror connecting to ${SOCKET} (No such file or directory)`,
        ),
      ),
    ).toBe(SOCKET);
  });

  test("names no path when tmux did not, or the path is not absolute", () => {
    expect(tmuxSocketPathFromMessage("failed to connect to server")).toBeUndefined();
    expect(tmuxSocketPathFromMessage("no sessions")).toBeUndefined();
    expect(
      tmuxSocketPathFromMessage("error connecting to default (No such file or directory)"),
    ).toBeUndefined();
  });
});

describe("noProcessServesTmuxSocket", () => {
  const self = "net:[4026531833]";

  test("passes the socket and pids as arguments, never inside the script", async () => {
    const exec = mock(async () => answer(`listed no\nself ${self}\npid 41 ${self} same\n`));
    expect(await noProcessServesTmuxSocket(SOCKET, ["41"], exec)).toBe(true);
    expect(exec).toHaveBeenCalledWith(["sh", "-c", TMUX_SOCKET_OWNER_PROBE, "sh", SOCKET, "41"]);
    expect(TMUX_SOCKET_OWNER_PROBE).not.toContain(SOCKET);
  });

  test("rules out only processes that provably serve another socket", async () => {
    const cases: Array<[string, boolean]> = [
      // Same network namespace and the path is not a live socket there.
      [`listed no\nself ${self}\npid 41 ${self} same\n`, true],
      // Another namespace that sees a different socket directory (a container).
      [`listed no\nself ${self}\npid 41 net:[1] differs\n`, true],
      // Exited between the census and the probe.
      [`listed no\nself ${self}\npid 41 gone\n`, true],
      // A live socket with this exact path in our namespace.
      [`listed yes\nself ${self}\npid 41 ${self} same\n`, false],
      // Another namespace that shares the socket directory.
      [`listed no\nself ${self}\npid 41 net:[1] same\n`, false],
      // Unreadable process: nothing is known about it.
      [`listed no\nself ${self}\npid 41 ? ?\n`, false],
      [`listed no\nself ${self}\npid 41 net:[1] ?\n`, false],
      // Malformed or incomplete answers.
      [`listed no\nself ${self}\n`, false],
      [`listed no\nself ?\npid 41 ? differs\n`, false],
      [`self ${self}\nlisted no\npid 41 ${self} same\n`, false],
      [`listed no\nself ${self}\npid 41 ${self}\n`, false],
      [`listed no\nself ${self}\nnoise\n`, false],
      ["", false],
    ];
    for (const [stdout, expected] of cases) {
      expect(await noProcessServesTmuxSocket(SOCKET, ["41"], async () => answer(stdout))).toBe(
        expected,
      );
    }
  });

  test("every process must be ruled out", async () => {
    const stdout = `listed no\nself ${self}\npid 41 ${self} same\npid 42 net:[1] same\n`;
    expect(await noProcessServesTmuxSocket(SOCKET, ["41", "42"], async () => answer(stdout))).toBe(
      false,
    );
  });

  test("a failed probe keeps every process as a possible owner", async () => {
    const ok = `listed no\nself ${self}\npid 41 ${self} same\n`;
    expect(await noProcessServesTmuxSocket(SOCKET, ["41"], async () => answer(ok, 3))).toBe(false);
    expect(
      await noProcessServesTmuxSocket(SOCKET, ["41"], async () => {
        throw new Error("sh failed");
      }),
    ).toBe(false);
  });
});

describe("confirmTmuxSessionGone with tmux processes in the census", () => {
  const diagnostic = `error connecting to ${SOCKET} (No such file or directory)`;

  test("asks the probe about exactly the tmux processes it found", async () => {
    const exec = mock(async (args: string[]) =>
      args[0] === "ps"
        ? answer("  1 /sbin/init\n 41 tmux: server\n 42 bash\n 43 /usr/bin/tmux\n")
        : answer("listed no\nself net:[1]\npid 41 net:[1] same\npid 43 net:[2] differs\n"),
    );
    expect(await confirmTmuxSessionGone(diagnostic, exec)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith([
      "sh",
      "-c",
      TMUX_SOCKET_OWNER_PROBE,
      "sh",
      SOCKET,
      "41",
      "43",
    ]);
  });

  test("a diagnostic without a socket path stays ambiguous and is not probed", async () => {
    const exec = mock(async () => answer(" 41 tmux: server\n"));
    expect(await confirmTmuxSessionGone("failed to connect to server", exec)).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(process.platform !== "linux")("the probe on this Linux host", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function scratchDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ork-socket-owner-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test("rules out a process in this namespace when nothing listens on the path", async () => {
    const socket = path.join(scratchDir(), "default");
    expect(await noProcessServesTmuxSocket(socket, [String(process.pid)], realExec)).toBe(true);
  });

  test("still sees a listening socket whose file was deleted", async () => {
    const socket = path.join(scratchDir(), "default");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    cleanups.push(() => server.close());
    unlinkSync(socket);
    expect(existsSync(socket)).toBe(false);
    expect(await noProcessServesTmuxSocket(socket, [String(process.pid)], realExec)).toBe(false);
  });

  test("a socket path that is only a prefix of a live one is not that socket", async () => {
    const dir = scratchDir();
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path.join(dir, "default2"), resolve));
    cleanups.push(() => server.close());
    expect(
      await noProcessServesTmuxSocket(path.join(dir, "default"), [String(process.pid)], realExec),
    ).toBe(true);
  });

  test("a vanished process cannot serve the socket", async () => {
    const socket = path.join(scratchDir(), "default");
    expect(await noProcessServesTmuxSocket(socket, [String(fakePid(1))], realExec)).toBe(true);
  });
});
