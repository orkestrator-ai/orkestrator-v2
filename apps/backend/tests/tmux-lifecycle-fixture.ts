import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execWithOutput, type ExecOutput } from "../src/core/tmux-shared.js";

// Capture before fake-runtime suites prepend their shims to PATH.
export const realTmux = Bun.which("tmux");

/** A real server on a private socket. Only this fixture's server is ever signalled. */
export async function withPrivateTmux(
  run: (fixture: {
    root: string;
    socket: string;
    start: (name: string, cwd: string) => Promise<void>;
    exec: (args: string[]) => Promise<ExecOutput>;
    terminate: () => Promise<void>;
    alive: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  if (!realTmux) throw new Error("tmux is required for lifecycle coverage");
  const root = await fs.realpath(await fs.mkdtemp("/tmp/ork-tmux-life-"));
  const socket = path.join(root, "socket");
  let serverPid: number | undefined;
  const alive = () => {
    if (!serverPid) return false;
    try {
      process.kill(serverPid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const exec = async (args: string[]): Promise<ExecOutput> => {
    if (args[0] === "tmux") {
      return execWithOutput(realTmux, ["-S", socket, "-f", "/dev/null", ...args.slice(1)], {
        env: { ...process.env, TMUX: "" },
        timeoutMs: 5_000,
      });
    }
    if (args[0] === "ps") {
      // Scope the real process census to the fixture so another suite's server
      // or the developer's tmux cannot affect the never-started/exited cases.
      return execWithOutput(
        "ps",
        ["-p", [process.pid, serverPid].filter(Boolean).join(","), "-o", "pid=,comm="],
        { timeoutMs: 5_000 },
      );
    }
    return execWithOutput(args[0]!, args.slice(1), { timeoutMs: 5_000 });
  };
  const terminate = async () => {
    if (!alive()) return;
    process.kill(serverPid!, "SIGTERM");
    const deadline = performance.now() + 5_000;
    while (alive() && performance.now() < deadline) await delay(20);
    if (alive()) throw new Error("private tmux server did not exit");
  };
  try {
    await run({
      root,
      socket,
      exec,
      terminate,
      alive,
      start: async (name, cwd) => {
        const started = await exec([
          "tmux",
          "new-session",
          "-d",
          "-s",
          name,
          "-c",
          cwd,
          "sleep 300",
        ]);
        if (started.status !== 0) throw new Error(started.stderr);
        const identity = await exec(["tmux", "display-message", "-p", "#{pid}"]);
        serverPid = Number(identity.stdout.trim());
        if (identity.status !== 0 || !Number.isSafeInteger(serverPid) || serverPid <= 1) {
          throw new Error("invalid private tmux server identity");
        }
      },
    });
  } finally {
    await terminate();
    await fs.rm(root, { recursive: true, force: true });
  }
}
