import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "../src/core/shell.js";

// Opt in with an existing development image; no provider, mounts or host ports.
const image = process.env.ORKESTRATOR_TEST_TERMINAL_IMAGE;

test.skipIf(!image)(
  "a backend restart reaps orphaned container shells and jobs at the next terminal start",
  async () => {
    if (!image || !image.startsWith("orkestrator-v2:dev-"))
      throw new Error("Use a development image");
    const name = `ork-terminal-orphan-${randomUUID()}`;
    const dir = await mkdtemp(path.join(tmpdir(), "ork-terminal-orphan-"));
    const children: Bun.Subprocess[] = [];
    let created = false;
    const docker = (args: string[]) => runCommand("docker", args, { timeoutMs: 20_000 });
    const modulePath = (file: string) =>
      JSON.stringify(path.resolve(import.meta.dir, "../src/core", file));
    const fixture = path.join(dir, "backend.ts");
    try {
      await docker([
        "run",
        "--rm",
        "-d",
        "--init",
        "--name",
        name,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        "exec sleep 300",
      ]);
      created = true;
      await writeFile(
        fixture,
        `
import { BackendRuntime } from ${modulePath("backend-runtime.ts")};
import { spawnPty } from ${modulePath("pty.ts")};
import { newContainerTerminalToken } from ${modulePath("container-terminal-shell.ts")};
import { CONTAINER_TERMINAL_PID_RECORD_COMMAND } from ${modulePath("container-scripts.ts")};
const runtime = new BackendRuntime({ emit: () => undefined });
process.on("SIGTERM", () => { runtime.shutdown(); process.exit(0); });
const open = () => {
  const token = newContainerTerminalToken();
  const pty = spawnPty("docker", ["exec", "-it", "--user", "node", "--env", "ORKESTRATOR_TERMINAL_SESSION=" + token, ${JSON.stringify(name)}, "bash", "-c", CONTAINER_TERMINAL_PID_RECORD_COMMAND + "\\nsleep 300 &\\necho TERM_READY\\nwait"], { cols: 80, rows: 24 });
  runtime.terminals.registerProcess(token, pty);
  runtime.terminals.recordContainerShell(token, { containerId: ${JSON.stringify(name)}, user: "node", token });
  let output = "";
  pty.onData((chunk) => {
    output = (output + chunk).slice(-1000);
    if (!output.includes("TERM_READY")) return;
    output = "";
    console.log(token);
  });
};
process.stdin.on("data", open);
open();
`,
      );
      const start = () => {
        const child = Bun.spawn([process.execPath, fixture], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
        });
        children.push(child);
        const reader = child.stdout.getReader();
        const token = async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              reader.read(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("terminal readiness timed out")), 15_000);
              }),
            ]);
            if (result.done) throw new Error("fixture exited before terminal readiness");
            return new TextDecoder().decode(result.value).trim();
          } finally {
            clearTimeout(timer);
          }
        };
        return { child, token };
      };
      const live = async (token: string) => {
        const result = await docker([
          "exec",
          "--user",
          "node",
          name,
          "sh",
          "-c",
          'for file in /proc/[0-9]*/environ; do grep -qzxF "ORKESTRATOR_TERMINAL_SESSION=$1" "$file" 2>/dev/null || continue; pid=${file#/proc/}; pid=${pid%/environ}; ps -o stat= -p "$pid"; done',
          "check",
          token,
        ]);
        return result.stdout
          .trim()
          .split("\n")
          .filter((state) => state && !state.trim().startsWith("Z")).length;
      };
      const first = start();
      const oldToken = await first.token();
      expect(await live(oldToken)).toBeGreaterThanOrEqual(2);
      first.child.kill("SIGTERM");
      expect(await first.child.exited).toBe(0);
      // Exiting the backend really did leave the shell and its child behind.
      expect(await live(oldToken)).toBeGreaterThanOrEqual(2);
      const second = start();
      const current = await second.token();
      expect(current.split("--")[0]).not.toBe(oldToken.split("--")[0]);
      const deadline = Date.now() + 10_000;
      while (await live(oldToken)) {
        if (Date.now() >= deadline)
          throw new Error("orphaned shell or child survived new terminal");
        await Bun.sleep(50);
      }
      expect(await live(current)).toBeGreaterThanOrEqual(2);
      second.child.stdin!.write("open\n");
      const another = await second.token();
      expect(another.split("--")[0]).toBe(current.split("--")[0]);
      expect(await live(current)).toBeGreaterThanOrEqual(2);
      expect(await live(another)).toBeGreaterThanOrEqual(2);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGTERM");
        await child.exited;
      }
      if (created) await docker(["rm", "-f", name]);
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
