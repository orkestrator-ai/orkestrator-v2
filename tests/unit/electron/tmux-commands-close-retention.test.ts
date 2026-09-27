/**
 * INC-08 for the tmux composer: closing a Claude tmux tab stops the CLI and
 * never deletes its conversation. The resume listing is read from the Claude
 * CLI's own JSONL under `~/.claude/projects/<encoded cwd>/`, so that file
 * surviving the close is what keeps the conversation resumable.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { createHandlers, encodeCwd, invoke, withFakeTmuxRuntime } from "./tmux-test-harness.js";

describe("Claude tmux tab close", () => {
  test("stops the session and keeps the conversation file the resume listing reads", async () => {
    const handlers = createHandlers();
    await withFakeTmuxRuntime(async ({ environment, worktree, home, alive }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const started = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-retain", environmentId: environment.id },
        context,
      )) as { tmux_session: string; running: boolean };
      expect(started.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const conversation = path.join(transcriptDir, "retained-session.jsonl");
      const contents = `${JSON.stringify({ type: "user", sessionId: "retained-session" })}\n`;
      await fs.writeFile(conversation, contents);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-retain", environmentId: environment.id },
        context,
      );

      // The CLI was stopped...
      expect(existsSync(path.join(alive, started.tmux_session))).toBe(false);
      await expect(
        invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-retain", environmentId: environment.id },
          context,
        ),
      ).resolves.toBeNull();
      // ...and the conversation it wrote is untouched.
      expect(await fs.readFile(conversation, "utf8")).toBe(contents);
    });
  });
});
