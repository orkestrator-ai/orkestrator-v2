import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./command-capture.js";
import { TmuxBackend } from "./tmux-backend.js";
import { ensureClaudeSettingsGitIgnored } from "./tmux-hooks.js";

test("exclude setup finishes while a login-profile redirected helper survives", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-exclude-login-"));
  const backend = TmuxBackend.local(directory);
  const exec = backend.exec.bind(backend);
  // Explicitly source a fixture profile in a real login shell, without reading
  // the host's profile or changing the test process's HOME or PATH.
  await fs.writeFile(
    path.join(directory, "profile"),
    `sh -c 'echo $$ > helper.pid; echo ready > helper.ready; i=0; while [ ! -f helper.stop ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i+1)); done; echo done > helper.done' >/dev/null 2>&1 &
while [ ! -f helper.ready ]; do sleep 0.01; done
`,
  );
  const statuses: number[] = [];
  const intercepted = spyOn(backend, "exec").mockImplementation(
    async (args, stdin, _timeout, options) => {
      expect(args.slice(0, 2)).toEqual(["bash", "-lc"]);
      const output = await exec(
        ["bash", "--noprofile", "-lc", '. ./profile; eval "$1"', "bash", args[2]!],
        stdin,
        2000,
        options,
      );
      statuses.push(output.status);
      return output;
    },
  );
  try {
    await runCommand("git", ["init", directory]);
    await ensureClaudeSettingsGitIgnored(backend);
    expect(intercepted).toHaveBeenCalledTimes(1);
    // A timed-out setup can still write the exclude file before killing its
    // helper. Require successful completion as well as helper existence.
    expect(statuses).toEqual([0]);
    expect(await fs.readFile(path.join(directory, "helper.ready"), "utf8")).toBe("ready\n");
    const pid = Number(await fs.readFile(path.join(directory, "helper.pid"), "utf8"));
    // Signal 0 checks existence without terminating any process.
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await fs.readFile(path.join(directory, ".git/info/exclude"), "utf8")).toContain(
      ".claude/settings.local.json",
    );
    expect(await fs.exists(path.join(directory, "helper.done"))).toBe(false);
  } finally {
    intercepted.mockRestore();
    // Cooperatively stop only this fixture's helper, even after a failed check.
    await fs.writeFile(path.join(directory, "helper.stop"), "stop");
    const deadline = Date.now() + 3000;
    while (!(await fs.exists(path.join(directory, "helper.done"))) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 10000);
