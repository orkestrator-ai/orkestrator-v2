/**
 * claude-tmux across versions (plan item 7002): a current renderer's
 * `claude-tmux` client against each node of the pair. The backends run with
 * no toolchain and no credentials, so no Claude session can start; the
 * module qualifies what a renderer reads before one exists: the tab's status
 * (none), the resumable sessions of the worker (an empty list or a refusal
 * that names the missing tool, never a malformed answer), and the refusal of
 * a prompt to a tab with no session.
 */
import { claudeTmuxClient } from "@orkestrator/protocol/contract/domains/claude-tmux";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

export default defineScenario({
  domain: "claude-tmux",
  title: "Status, resumable sessions and a refused prompt with no session, from a current renderer",
  requires: {
    command: ["claude_tmux_status", "claude_tmux_submit"],
    leaf: ["claude_tmux_status", "claude_tmux_submit"],
  },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, claudeTmuxClient);
      const tmux = client.api();
      ctx.check(
        `CT-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "claude-tmux"),
        `picked ${version}`,
      );
      const tabId = `qualification-${tag.toLowerCase()}`;
      const status = await tmux.claude_tmux_status({
        environmentId: worker.environmentId,
        tabId,
      });
      ctx.check(`CT-${tag}2`, "a tab with no session has no status", status === null);
      const refusal = await tmux
        .claude_tmux_submit({ environmentId: worker.environmentId, tabId, text: "hello" })
        .then(
          () => "",
          (error: unknown) => String(error),
        );
      ctx.check(
        `CT-${tag}3`,
        "a prompt to a tab with no session is refused",
        refusal.includes("tmux session not running"),
        refusal.slice(0, 120),
      );
      if (node.has("claude_tmux_list_previous_sessions")) {
        const previous = await tmux
          .claude_tmux_list_previous_sessions({ environmentId: worker.environmentId })
          .then(
            (sessions) => ({ sessions }),
            (error: unknown) => ({ error: String(error) }),
          );
        ctx.check(
          `CT-${tag}4`,
          "the resumable sessions decode (or the read is refused), never a malformed answer",
          "sessions" in previous
            ? Array.isArray(previous.sessions)
            : !/Invalid result/u.test(previous.error),
        );
      }
      ctx.note(`${node.role} claude-tmux`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
