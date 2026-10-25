import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, open, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TmuxBackend } from "../src/core/tmux-backend.js";
import {
  hookScript,
  requestHookHold,
  replyToHook,
  workspaceHookPaths,
  sessionHookPaths,
} from "../src/core/tmux-hooks.js";
import { HOOK_HOLD_PROTOCOL } from "../src/core/tmux-shared.js";

async function until(predicate: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error("Timed out waiting for the hook transport");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a generated hook retains an empty remote write until hold and resume contents arrive", async () => {
  const root = await mkdtemp(join(tmpdir(), "tmux-hold-transport-"));
  const workspace = workspaceHookPaths(root, root);
  const paths = sessionHookPaths(workspace, "transport-test");
  const observed = join(root, "observed");
  // Record each actual read, so the test need not guess when polling happened.
  const script = hookScript(workspace).replace(
    '  HOLD_REQUEST="$(cat "$HOLD_FILE" 2>/dev/null || true)"',
    `  HOLD_REQUEST="$(cat "$HOLD_FILE" 2>/dev/null || true)"\n  touch '${observed}'`,
  );
  await writeFile(workspace.script, script);
  const child = spawn("bash", [workspace.script, "PermissionRequest", HOOK_HOLD_PROTOCOL]);
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ session_id: "transport-test", tool_name: "Bash" }));
  try {
    let name = "";
    await until(async () => {
      name =
        (await readdir(paths.timingDir).catch(() => [])).find((file) => file.endsWith(".json")) ??
        "";
      return !!name;
    });
    const holdFile = join(paths.holdDir, name);
    const timingFile = join(paths.timingDir, name);
    for (const held of [true, false]) {
      await rm(observed, { force: true });
      // Keep the descriptor open, as exec's `cat > file` does. If the hook
      // unlinks the empty file, completing this write cannot restore its name.
      const writer = await open(holdFile, "w");
      try {
        await until(async () =>
          access(observed).then(
            () => true,
            () => false,
          ),
        );
        expect(await readFile(holdFile, "utf8")).toBe("");
        await writer.writeFile(held ? "hold" : "resume");
      } finally {
        await writer.close();
      }
      await until(async () => {
        const timing = JSON.parse(await readFile(timingFile, "utf8"));
        return (timing.heldAt !== undefined) === held;
      });
      await expect(access(holdFile)).rejects.toThrow();
    }
    const id = name.slice("PermissionRequest-".length, -5);
    await replyToHook(TmuxBackend.local(root), paths, "PermissionRequest", id, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Fixture complete" },
      },
    });
    await closed;
  } finally {
    child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

const image = process.env.ORKESTRATOR_TMUX_HOLD_CONTAINER_IMAGE;
(image ? test : test.skip)(
  "repeated pause and resume through a container tmux session and exec writer",
  async () => {
    const name = `ork-tmux-hold-${randomUUID()}`;
    const run = async (args: string[]) => {
      const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(`Docker fixture failed: ${stderr.slice(0, 500)}`);
      return stdout.trim();
    };
    const container = await run([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--label",
      "dev.orkestrator.test=tmux-hold",
      "--network",
      "none",
      "--entrypoint",
      "sleep",
      image!,
      "120",
    ]);
    try {
      const backend = TmuxBackend.container(container);
      const workspace = workspaceHookPaths("/tmp/tmux-hold", "/workspace");
      const paths = sessionHookPaths(workspace, "12345678-1234-1234-1234-123456789abc");
      expect((await backend.exec(["mkdir", "-p", workspace.root])).status).toBe(0);
      await backend.writeFile(workspace.script, hookScript(workspace));
      expect(await backend.readFile(workspace.script)).toBe(hookScript(workspace));
      await backend.writeFile(
        "/tmp/tmux-hold/payload",
        JSON.stringify({ session_id: "12345678-1234-1234-1234-123456789abc", tool_name: "Bash" }),
      );
      await backend.writeFile(
        "/tmp/tmux-hold/run.sh",
        `#!/bin/bash
/bin/bash ${workspace.script} PermissionRequest ${HOOK_HOLD_PROTOCOL} < /tmp/tmux-hold/payload > /tmp/tmux-hold/result 2> /tmp/tmux-hold/error
`,
      );
      const started = await backend.exec([
        "tmux",
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "hold-test",
        "/bin/bash",
        "/tmp/tmux-hold/run.sh",
      ]);
      expect(started.status).toBe(0);
      let filename = "";
      await until(async () => {
        filename =
          (await backend.listDir(paths.timingDir)).find((file) => file.endsWith(".json")) ?? "";
        return !!filename;
      });
      const id = filename.slice("PermissionRequest-".length, -5);
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const held of [true, false]) {
          expect(
            (await requestHookHold(backend, paths, "PermissionRequest", id, held)).result,
          ).toBe("applied");
        }
      }
      await replyToHook(backend, paths, "PermissionRequest", id, { fixture: "denied" });
      await until(
        async () => (await backend.readFile("/tmp/tmux-hold/result"))?.includes("denied") === true,
      );
    } finally {
      await run(["rm", "-f", container]);
    }
  },
  90_000,
);
