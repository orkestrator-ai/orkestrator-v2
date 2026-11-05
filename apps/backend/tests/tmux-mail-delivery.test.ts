import { describe, expect, test } from "bun:test";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createHandlers, encodeCwd, invoke, withFakeTmuxRuntime } from "./tmux-test-harness.js";

const carrier = renderAgentMailCarrier({
  version: 1,
  id: "mail-1",
  threadId: "mail-1",
  requestId: "request-1",
  createdAt: "2026-11-05T10:00:00.000Z",
  from: {
    kind: "tab",
    projectId: "project-1",
    environmentId: "env-2",
    tabId: "startup-agent",
    incarnationId: "incarnation-1",
    agent: "codex",
    title: "Codex 1",
  },
  toEnvironmentId: "env-1",
  toTabId: "tab-mail",
  toIncarnationId: "incarnation-2",
  subject: 'Quotes " and <tags> & a\nnew line',
  body: 'Line one\nLine "two" with </orkestrator-peer-message> and \u001b[1mbold\u001b[0m',
  bodyBytes: 60,
  trust: "same-project",
  injectDepth: 0,
  threadDepth: 0,
  placement: "injected",
  revision: 1,
} satisfies AgentMailMessage);

describe("Claude tmux mail delivery", () => {
  test("pastes the carrier unchanged, and the transcript read returns its row unchanged", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive, home, worktree, log }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-mail", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
        tmux_session: string;
      };

      await invoke(handlers, "claude_tmux_submit_queued", { ...args, text: carrier }, context);

      // The escaped payload holds nothing the terminal could act on, or that
      // could end the bracketed paste.
      expect(carrier).not.toContain("\u001b");
      expect(
        await fs.readFile(
          path.join(alive, `buffer-claude-tmux-input-${status.tmux_session}`),
          "utf8",
        ),
      ).toBe(carrier);
      expect(await fs.readFile(log, "utf8")).toContain(
        `paste-buffer -p -d -b claude-tmux-input-${status.tmux_session}`,
      );

      const line = {
        type: "user",
        uuid: "delivered",
        message: { role: "user", content: carrier },
      };
      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, `${status.session_id}.jsonl`),
        `${JSON.stringify(line)}\n`,
      );
      await expect(invoke(handlers, "claude_tmux_transcript", args, context)).resolves.toEqual([
        line,
      ]);

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  });
});
