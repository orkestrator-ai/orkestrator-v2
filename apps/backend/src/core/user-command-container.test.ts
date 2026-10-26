import { UserCommandService } from "./user-commands.js";
import { HumanPromptRegistry } from "./human-prompt-registry.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnContainerUserCommand } from "./user-command-container.js";

// Real process-tree proof against a disposable, network-isolated container.
const enabled = process.env.ORKESTRATOR_AGENT_TEST_DOCKER === "1";
test.skipIf(!enabled)(
  "container cancellation and shutdown kill signal-ignoring descendants",
  async () => {
    const image = process.env.ORKESTRATOR_USER_COMMAND_TEST_IMAGE;
    if (!image)
      throw new Error("Set ORKESTRATOR_USER_COMMAND_TEST_IMAGE to an existing development image");
    const name = `ork-user-command-test-${randomUUID()}`;
    const docker = async (args: string[]) => {
      const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code) throw new Error(`Docker fixture failed (${code}): ${err}`);
      return out.trim();
    };
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "none",
      "--entrypoint",
      "sleep",
      image,
      "120",
    ]);
    const service = new UserCommandService({
      prompts: new HumanPromptRegistry(),
      announce() {},
      resolve: async () => ({
        target: "container",
        cwd: "/workspace",
        spawn: (command) => spawnContainerUserCommand(name, command, process.env),
      }),
    });
    try {
      for (let iteration = 0; iteration < 2; iteration++) {
        const record = await service.run({
          environmentId: "fixture",
          tabId: "tab",
          command:
            "printf TTY_OK >/dev/tty || exit 9; trap '' INT TERM HUP; bash -c 'trap \"\" INT TERM HUP; echo READY; while :; do sleep 1; done' & wait",
        });
        const deadline = Date.now() + 10_000;
        while (!service.get(record.id).output.includes("READY")) {
          if (Date.now() > deadline) throw new Error("command did not start");
          await Bun.sleep(20);
        }
        if (iteration === 0) expect((await service.cancel(record.id)).status).toBe("cancelled");
        else await service.shutdown();
        const survivors = await docker([
          "exec",
          name,
          "bash",
          "-c",
          "ps -eo stat,args | grep '[w]hile :; do sleep 1; done' | grep -v '^Z' || true",
        ]);
        expect(survivors).toBe("");
      }
    } finally {
      await service.shutdown().catch(() => undefined);
      await docker(["rm", "-f", name]);
    }
  },
  30000,
);
