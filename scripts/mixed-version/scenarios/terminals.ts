/**
 * terminals across versions (plan item 7002): a current renderer's
 * `terminals` client against each node of the pair, in a worker's worktree.
 * A local terminal session is created for a stable key (and found again),
 * started, written to (`delivered`), its output recovered through the
 * snapshot, resized and closed; after closing, a write is answered in band as
 * not delivered. A pre-contract node gets today's body through version 0.
 */
import { terminalsClient } from "@orkestrator/protocol/contract/domains/terminals";
import { until } from "../harness.ts";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

export default defineScenario({
  domain: "terminals",
  title: "Local terminal session lifecycle and output recovery, from a current renderer",
  requires: {
    command: [
      "create_local_terminal_session",
      "start_local_terminal_session",
      "local_terminal_write",
      "get_terminal_output_snapshot",
      "close_local_terminal_session",
    ],
    leaf: [
      "create_local_terminal_session",
      "start_local_terminal_session",
      "local_terminal_write",
      "get_terminal_output_snapshot",
      "close_local_terminal_session",
    ],
  },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, terminalsClient);
      const terminals = client.api();
      ctx.check(
        `TE-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "terminals"),
        `picked ${version}`,
      );
      const terminalKey = `qualification-${tag.toLowerCase()}`;
      const created = await terminals.create_local_terminal_session({
        environmentId: worker.environmentId,
        terminalKey,
        cols: 80,
        rows: 24,
      });
      const again = await terminals.create_local_terminal_session({
        environmentId: worker.environmentId,
        terminalKey,
        cols: 80,
        rows: 24,
      });
      ctx.check(
        `TE-${tag}2`,
        "a stable terminal key creates one session and finds it again",
        created.created && !again.created && again.sessionId === created.sessionId,
      );
      const sessionId = created.sessionId;
      await terminals.start_local_terminal_session({ sessionId });
      const marker = `ork-qualification-${tag}`;
      const written = await terminals.local_terminal_write({
        sessionId,
        data: `echo ${marker}\n`,
      });
      const output = await until(
        "terminal output",
        () => terminals.get_terminal_output_snapshot({ sessionId }),
        (snapshot) => snapshot.output.includes(marker),
        20_000,
      ).catch(() => null);
      ctx.check(
        `TE-${tag}3`,
        "input reaches the shell and its output comes back in the snapshot",
        written?.delivered !== false && output !== null,
      );
      await terminals.local_terminal_resize({ sessionId, cols: 100, rows: 30 });
      await terminals.close_local_terminal_session({ sessionId });
      const late = await terminals.local_terminal_write({ sessionId, data: "x" });
      ctx.check(
        `TE-${tag}4`,
        "after closing, a write is reported as not delivered (or ignored by an older node)",
        late === undefined || late === null || late.delivered === false,
      );
      ctx.note(`${node.role} terminals`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
