import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TmuxBackend } from "./backend.js";
import { TmuxSession } from "./session-manager.js";
import { StorageService, createEnvironment } from "../storage/service.js";
import { runCommand } from "../shell.js";
import {
  ENVIRONMENT_ISOLATION_ENV_NAMES,
  environmentIsolationVariables,
} from "../environments/isolation.js";
import type { CommandContext } from "../commands-context.js";

test("two Claude panes on an existing tmux server replace its inherited project and ports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-tmux-isolation-"));
  const socket = path.join(root, "tmux.sock");
  const storage = new StorageService(path.join(root, "data"));
  const inherited = ENVIRONMENT_ISOLATION_ENV_NAMES.map(
    (name) => [name, process.env[name]] as const,
  );
  const tmux = (args: string[]) =>
    runCommand("tmux", ["-S", socket, ...args], { timeoutMs: 10_000 });
  let serverStarted = false;
  try {
    await storage.init();
    Object.assign(process.env, environmentIsolationVariables("parent", 20_000));
    await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "sentinel", "sleep 120"]);
    serverStarted = true;
    const fakeClaude = path.join(root, "claude");
    await writeFile(
      fakeClaude,
      `#!${process.execPath}\nif (process.argv.includes('--help')) { console.log('--session-id --resume'); }\nelse if (process.argv.includes('--version')) { console.log('fixture'); }\nelse { await Bun.write(${JSON.stringify(root)} + '/' + process.env.ORKESTRATOR_ENVIRONMENT_ID + '/isolation.json', JSON.stringify(Object.fromEntries(${JSON.stringify(ENVIRONMENT_ISOLATION_ENV_NAMES)}.map(k => [k, process.env[k] ?? null])))); Bun.spawnSync(['tmux', '-S', ${JSON.stringify(socket)}, 'wait-for', '-S', 'captured-' + process.env.ORKESTRATOR_ENVIRONMENT_ID]); }\n`,
      { mode: 0o755 },
    );
    for (const id of ["first", "second"]) {
      const cwd = path.join(root, id);
      await mkdir(cwd);
      await storage.addEnvironment({
        ...createEnvironment("fixture", { environmentType: "local" }),
        id,
        worktreePath: cwd,
      });
      const backend = TmuxBackend.local(cwd);
      const original = backend.exec.bind(backend);
      const exec = spyOn(backend, "exec").mockImplementation(async (args, ...rest) => {
        if (args[0] !== "tmux") return original(args, ...rest);
        try {
          const out = await tmux(args.slice(1));
          return { ...out, status: 0 };
        } catch (error) {
          return { status: 1, stdout: "", stderr: String(error) };
        }
      });
      const session = new TmuxSession(id, "tab", backend, root, undefined, fakeClaude);
      // This test owns launch only; polling is independently covered and never starts.
      const polling = spyOn(
        session as unknown as { spawnPollLoop(context: CommandContext): void },
        "spawnPollLoop",
      ).mockImplementation(() => {});
      const context = {
        storage,
        runtime: { tmux: { localClaudeConfigDirectory: async () => undefined } },
        emit() {},
      } as unknown as CommandContext;
      try {
        await session.startAfterHooksInstalled(context, undefined, undefined, undefined, undefined);
        await tmux(["wait-for", `captured-${id}`]);
        const base = await storage.environmentIsolation.assignEnvironmentPortBase(id);
        expect(JSON.parse(await readFile(path.join(cwd, "isolation.json"), "utf8"))).toEqual(
          environmentIsolationVariables(id, base),
        );
      } finally {
        polling.mockRestore();
        exec.mockRestore();
      }
    }
    // Per-pane exports have not changed the server's original project.
    expect((await tmux(["show-environment", "-g", "COMPOSE_PROJECT_NAME"])).stdout.trim()).toBe(
      "COMPOSE_PROJECT_NAME=ork-parent",
    );
  } finally {
    if (serverStarted) await tmux(["kill-server"]);
    for (const [name, value] of inherited) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
