import { describe, expect, spyOn, test } from "bun:test";
import type { CommandContext } from "./commands.js";
import { registrarFrom } from "./commands-registry-contracts.js";
import { TmuxBackend } from "./tmux-backend.js";
import { registerTmuxBackendCommands } from "./tmux-commands.js";
import { TmuxSession } from "./tmux-session-manager.js";

/**
 * Mail presence reuses the tab poll loop's recent `has-session` answer instead
 * of spawning its own; every other status read still probes.
 */
describe("tmux liveness reuse", () => {
  test("a session remembers its latest liveness answer for a bounded age", async () => {
    let now = 10_000;
    const backend = TmuxBackend.local("/tmp");
    const session = new TmuxSession("env", "tab", backend, "/tmp", undefined, undefined, {
      now: () => now,
    });
    let status = 0;
    const exec = spyOn(backend, "exec").mockImplementation(async () => ({
      status,
      stdout: "",
      stderr: "",
    }));
    try {
      expect(session.recentLiveness(3_000)).toBeUndefined();
      expect(await session.tmuxAlive()).toBe(true);
      now += 3_000;
      expect(session.recentLiveness(3_000)).toBe(true);
      now += 1;
      expect(session.recentLiveness(3_000)).toBeUndefined();

      status = 1;
      expect(await session.tmuxAlive()).toBe(false);
      expect(session.recentLiveness(3_000)).toBe(false);

      // A probe that fails records nothing, so the last real answer stands.
      exec.mockImplementationOnce(async () => {
        throw new Error("spawn failed");
      });
      await expect(session.tmuxAlive()).rejects.toThrow("spawn failed");
      expect(session.recentLiveness(3_000)).toBe(false);
    } finally {
      exec.mockRestore();
    }
  });

  test("claude_tmux_status probes unless the caller accepts a recent answer", async () => {
    const commands = new Map<
      string,
      (args: Record<string, unknown>, context: CommandContext) => unknown
    >();
    // The fake session's status is partial, so its result is not validated.
    registerTmuxBackendCommands(
      registrarFrom(
        (name, handler) => {
          commands.set(name, handler as never);
        },
        { validateResults: false },
      ),
    );
    const status = commands.get("claude_tmux_status")!;
    let probes = 0;
    let recent: boolean | undefined = true;
    const session = {
      status: (running: boolean) => ({ running }),
      recentLiveness: (maxAgeMs: number) => {
        expect(maxAgeMs).toBe(3_000);
        return recent;
      },
      tmuxAlive: async () => {
        probes += 1;
        return false;
      },
    };
    const context = {
      runtime: { tmux: { sessions: { get: () => session } } },
    } as unknown as CommandContext;
    const args = { environmentId: "env", tabId: "tab" };

    expect(await status(args, context)).toEqual({ running: false });
    expect(probes).toBe(1);

    expect(await status({ ...args, livenessMaxAgeMs: 3_000 }, context)).toEqual({ running: true });
    expect(probes).toBe(1);

    // Nothing recent enough: the caller still gets a fresh probe.
    recent = undefined;
    expect(await status({ ...args, livenessMaxAgeMs: 3_000 }, context)).toEqual({
      running: false,
    });
    expect(probes).toBe(2);
  });
});
